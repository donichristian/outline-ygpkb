import { observer } from "mobx-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import styled from "styled-components";
import { s } from "@shared/styles";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Input from "~/components/Input";
import Scrollable from "~/components/Scrollable";
import Text from "~/components/Text";
import SidebarLayout from "~/scenes/Document/components/SidebarLayout";
import { AiChatError, streamAiChat } from "~/utils/aiChat";
import type { AiChatMessage } from "~/utils/aiChat";

type Props = {
  /** Called when the user closes the panel. */
  onClose: () => void;
};

/**
 * Renders the user-facing message for a failed chat request. A 404 means the
 * feature is disabled for the workspace, a 403 means the CSRF token was
 * rejected, and every other failure is presented as a generic, retryable error.
 *
 * @param error the error thrown while streaming.
 * @param t the translation function.
 * @returns the message to display to the user.
 */
function errorText(error: AiChatError, t: (key: string) => string): string {
  if (error.status === 404) {
    return t("AI chat is not enabled for this workspace");
  }
  if (error.status === 403) {
    return t("Your session has expired, refresh the page to continue");
  }
  if (error.kind === "network") {
    return t("The AI chat request failed, try again?");
  }
  return error.message || t("The AI chat request failed, try again?");
}

/**
 * The right-sidebar AI chat panel: a streaming transcript and a composer. The
 * transcript is rendered as plain text with preserved line breaks – this is
 * intentional for the transport spike, which favours proving the stream over
 * formatting. Markdown rendering can be layered on later.
 *
 * Closing the panel (via `onClose`) clears the transcript and aborts any
 * in-flight stream; the same cleanup runs on unmount.
 */
const AIChatPanel = observer(function AIChatPanel({ onClose }: Props) {
  const { t } = useTranslation();
  const [messages, setMessages] = React.useState<AiChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [isStreaming, setIsStreaming] = React.useState(false);
  const [error, setError] = React.useState<AiChatError | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  const abort = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // Abort any in-flight stream when the panel unmounts.
  React.useEffect(() => () => abort(), [abort]);

  // Keep the transcript pinned to the latest message as it grows.
  React.useEffect(() => {
    const el = transcriptRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleStop = React.useCallback(() => {
    abort();
    setIsStreaming(false);
  }, [abort]);

  const handleSubmit = React.useCallback(
    async (ev: React.FormEvent<HTMLFormElement>) => {
      ev.preventDefault();
      const content = input.trim();
      if (!content || isStreaming) {
        return;
      }

      // Snapshot the conversation plus the newest user turn to send.
      const next: AiChatMessage[] = [
        ...messages,
        { role: "user", content },
        { role: "assistant", content: "" },
      ];

      setMessages(next);
      setInput("");
      setError(null);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        for await (const delta of streamAiChat(next.slice(0, -1), {
          signal: controller.signal,
        })) {
          setMessages((current) => {
            const updated = current.slice();
            const last = updated[updated.length - 1];
            updated[updated.length - 1] = {
              role: "assistant",
              content: last.content + delta.text,
            };
            return updated;
          });
        }
      } catch (err) {
        if (controller.signal.aborted) {
          // A user-initiated stop is not an error.
        } else if (err instanceof AiChatError) {
          setError(err);
        } else {
          setError(
            new AiChatError("The AI chat request failed, try again?", "network")
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setIsStreaming(false);
      }
    },
    [input, isStreaming, messages]
  );

  const handleChange = React.useCallback(
    (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setInput(ev.target.value);
    },
    []
  );

  const requestSubmit = React.useCallback(() => {
    formRef.current?.requestSubmit();
  }, []);

  // A single-line prompt sends on plain Enter. Input only fires
  // onRequestSubmit on Cmd+Enter (Input.tsx handleKeyDown), and that branch
  // returns early, so Enter is handled here rather than in the shared
  // component. preventDefault stops the browser's implicit submission, which
  // would otherwise submit the form a second time.
  const handleKeyDown = React.useCallback(
    (ev: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        requestSubmit();
      }
    },
    [requestSubmit]
  );

  return (
    <SidebarLayout title={t("AI chat")} onClose={onClose} scrollable={false}>
      <Container column>
        <Transcript ref={transcriptRef}>
          {messages.length === 0 && (
            <EmptyText type="secondary" size="small">
              {t("Ask anything about your workspace")}
            </EmptyText>
          )}
          {messages.map((message, index) => {
            if (message.role === "assistant" && !message.content) {
              return null;
            }
            return (
              <Message
                key={index}
                $role={message.role}
                dir="auto"
                data-testid={`message-${message.role}`}
              >
                {message.content}
                {isStreaming &&
                  index === messages.length - 1 &&
                  message.role === "assistant" && <Cursor />}
              </Message>
            );
          })}
        </Transcript>

        {error && (
          <ErrorNotice data-testid="ai-chat-error">
            <Text type="danger" size="small">
              {errorText(error, t)}
            </Text>
          </ErrorNotice>
        )}

        <Composer ref={formRef} onSubmit={handleSubmit}>
          <Input
            type="text"
            value={input}
            placeholder={t("Ask a question…")}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onRequestSubmit={requestSubmit}
            // Input's outlined box defaults to a 16px bottom margin, which
            // pushes it off-centre in the composer row.
            margin={0}
            aria-label={t("Message")}
            data-testid="ai-chat-input"
          />
          {isStreaming ? (
            <Button
              type="button"
              neutral
              onClick={handleStop}
              data-testid="ai-chat-stop"
            >
              {t("Stop")}
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={!input.trim()}
              data-testid="ai-chat-send"
            >
              {t("Send")}
            </Button>
          )}
        </Composer>
      </Container>
    </SidebarLayout>
  );
});

const Container = styled(Flex)`
  height: 100%;
  overflow: hidden;
  /* Allow the column to shrink below its content so Transcript scrolls
     internally and Composer stays pinned instead of being clipped. */
  min-height: 0;
`;

const Transcript = styled(Scrollable)`
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px;
  /* A flex item defaults to min-height: auto and will not shrink below its
     content; without this the transcript grows unbounded and pushes the
     composer out of the panel. */
  min-height: 0;
`;

const EmptyText = styled(Text)`
  color: ${s("textTertiary")};
  text-align: center;
  margin-top: 24px;
`;

const Message = styled.div<{ $role: "user" | "assistant" }>`
  /* Plain-text rendering with preserved newlines – intentional for the
     transport spike, which does not yet render Markdown. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.5;
  color: ${s("text")};
  padding: 8px 10px;
  border-radius: 6px;
  ${(props) =>
    props.$role === "user" &&
    `background: ${props.theme.sidebarBackground}; font-weight: 500;`}
`;

const Cursor = styled.span`
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-inline-start: 2px;
  vertical-align: text-bottom;
  background: currentColor;
  animation: ai-chat-blink 1s steps(2, start) infinite;

  @keyframes ai-chat-blink {
    to {
      visibility: hidden;
    }
  }
`;

const ErrorNotice = styled.div`
  margin: 0 16px 8px;
  padding: 8px 12px;
  border-radius: 6px;
  background: ${(props) => props.theme.sidebarBackground};
  border: 1px solid ${(props) => props.theme.danger};
`;

const Composer = styled.form`
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 12px 16px;
  gap: 8px;
  border-top: 1px solid ${s("divider")};
  flex-shrink: 0;

  /* Input's root Wrapper carries flex: 0, i.e. flex-basis: 0%, so in this row
     it resolves to zero width and its overflowed control paints over the
     Send/Stop button – visible but unclickable. Grow the input wrapper to fill
     the row instead, letting min-width: 0 do what min-width: initial (the
     flex-item automatic minimum) would otherwise forbid. */
  > :first-child {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* The button keeps its intrinsic width and never shrinks. */
  > :last-child {
    flex: 0 0 auto;
  }
`;

export default AIChatPanel;
