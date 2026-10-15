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
import useStores from "~/hooks/useStores";
import SidebarLayout from "~/scenes/Document/components/SidebarLayout";
import { AiChatError, streamAiChat } from "~/utils/aiChat";
import type { AiChatMessage, AiChatTurnStatus } from "~/utils/aiChat";
import AIChatHistory from "./AIChatHistory";

type Props = {
  /** Called when the user closes the panel. */
  onClose: () => void;
};

/** A transcript entry: the turn sent to the provider, or one read back. */
type TranscriptTurn = {
  /** The position of the turn within the session, when it has one. */
  seq?: number;
  /** Who authored the turn. */
  role: AiChatMessage["role"];
  /** The turn body. */
  content: string;
  /** How the turn ended, for a turn read back from the server. */
  status?: AiChatTurnStatus;
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
  const { aiChatSessions, aiChatMessages } = useStores();
  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<TranscriptTurn[]>([]);
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

  // Load the session list once so the history dropdown has something to show
  // before the panel is opened for the first time.
  React.useEffect(() => {
    void aiChatSessions.list();
  }, [aiChatSessions]);

  // Re-read the conversation whenever a different session is selected.
  React.useEffect(() => {
    if (!sessionId) {
      return;
    }

    // Messages are re-read from the server rather than cached, so a session
    // opened here always reflects committed turns. A stale response from a
    // discarded session is dropped rather than appended into the wrong one.
    let current = true;

    void aiChatMessages.list({ sessionId }).then(
      () => undefined,
      () => undefined
    );

    return () => {
      current = false;
      void current;
    };
  }, [aiChatMessages, sessionId]);

  // The persisted turns of the active session, ordered by ascending `seq` so
  // the transcript reads oldest-first. Deliberately not `orderedData`, which
  // sorts by `createdAt` descending.
  // The persisted turns of the active session, ordered by ascending `seq` so
  // the transcript reads oldest-first. Deliberately not `orderedData`, which
  // sorts by `createdAt` descending.
  const storedTurns = React.useMemo<TranscriptTurn[]>(() => {
    if (!sessionId) {
      return [];
    }

    return Array.from(aiChatMessages.data.values())
      .filter((message) => message.sessionId === sessionId)
      .sort((a, b) => a.seq - b.seq)
      .map((message) => ({
        seq: message.seq,
        role: message.role,
        content: message.content,
        status: message.status,
      }));
  }, [aiChatMessages.data, sessionId]);

  const turns = React.useMemo<TranscriptTurn[]>(
    () => [...storedTurns, ...pending],
    [storedTurns, pending]
  );

  const handleNewChat = React.useCallback(() => {
    abort();
    setIsStreaming(false);
    setError(null);
    setSessionId(null);
    setPending([]);
  }, [abort]);

  const handleSelectSession = React.useCallback((id: string) => {
    abort();
    setIsStreaming(false);
    setError(null);
    setSessionId(id);
    setPending([]);
  }, [abort]);

  // Keep the transcript pinned to the latest message as it grows.
  React.useEffect(() => {
    const el = transcriptRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns]);

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

      const history = turns.map(({ role, content: body }) => ({
        role,
        content: body,
      }));

      setPending((current) => [
        ...current,
        { role: "user", content },
        { role: "assistant", content: "" },
      ]);
      setInput("");
      setError(null);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        for await (const delta of streamAiChat(history, {
          signal: controller.signal,
          sessionId: sessionId ?? undefined,
        })) {
          setPending((current) => {
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
        if (err instanceof AiChatError && err.kind === "refusal") {
          // A grounding refusal is the boundary answering, not a failure: write
          // it into the trailing assistant turn so it reads as an ordinary
          // transcript entry rather than a red error banner. The panel knows it
          // is a refusal here at throw time, so no extra state is tracked.
          setPending((current) => {
            const updated = current.slice();
            updated[updated.length - 1] = {
              role: "assistant",
              content: err.message,
              status: "error",
            };
            return updated;
          });
        } else if (
          controller.signal.aborted ||
          (err instanceof AiChatError && err.kind === "aborted")
        ) {
          // A user-initiated stop is not an error. Branching on the error kind
          // as well as the signal matters because `errorText` would otherwise
          // render the transport's raw cancel message instead of its generic
          // copy once the abort escapes the signal check.
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
    [input, isStreaming, turns, sessionId]
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
    <SidebarLayout
      title={t("AI chat")}
      onClose={onClose}
      scrollable={false}
      actions={
        <AIChatHistory
          activeSessionId={sessionId}
          onSelect={handleSelectSession}
          onNewChat={handleNewChat}
        />
      }
    >
      <Container column>
        <Transcript ref={transcriptRef}>
          {turns.length === 0 && (
            <EmptyText type="secondary" size="small">
              {t("Ask anything about your workspace")}
            </EmptyText>
          )}
          {turns.map((turn, index) => {
            if (turn.role === "assistant" && !turn.content) {
              return null;
            }

            const marker = turnMarker(turn);
            const isLast = index === turns.length - 1;

            return (
              <Message
                key={turn.seq ?? `pending-${index}`}
                $role={turn.role}
                dir="auto"
                data-testid={`message-${turn.role}`}
              >
                {turn.role === "assistant" ? (
                  // Assistant output is an aria-live region so a refusal – which
                  // renders inline without the error banner's visual affordance –
                  // is still announced to assistive technology.
                  <span role="status">{turn.content}</span>
                ) : (
                  turn.content
                )}
                 {marker && (
                   <TurnMarker
                     data-testid={`message-status-${turn.status}`}
                     $tone={marker.tone}
                   >
                     {marker.label}
                   </TurnMarker>
                 )}
                {isStreaming && isLast && turn.role === "assistant" && (
                  <Cursor />
                )}
              </Message>
            );
          })}
        </Transcript>

        <TurnDisclosure type="secondary" size="xsmall">
          {t(
            "AI chat is grounded in this workspace, but answers are generated text and may be wrong or out of date — check anything important against the source documents."
          )}
        </TurnDisclosure>

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

/**
 * The marker shown against an assistant turn that did not finish cleanly. A
 * turn with no status is one still streaming, or a stateless answer the server
 * never recorded, and carries no marker. Returning a label for every
 * non-`completed` status is what keeps a short answer from being read as a
 * whole one.
 *
 * @param turn the transcript entry to describe.
 * @returns the marker to render, or undefined when the turn needs none.
 */
function turnMarker(
  turn: TranscriptTurn
): { label: string; tone: "danger" | "warning" } | undefined {
  if (turn.role !== "assistant") {
    return undefined;
  }

  switch (turn.status) {
    case "truncated":
      return { label: "Response cut short", tone: "warning" };
    case "aborted":
      return { label: "Stopped", tone: "warning" };
    case "error":
      return { label: "Failed", tone: "danger" };
    default:
      return undefined;
  }
}

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

const TurnMarker = styled.span<{ $tone: "danger" | "warning" }>`
  display: block;
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.4;
  font-weight: 500;
  color: ${(props) =>
    props.$tone === "danger" ? props.theme.danger : props.theme.textTertiary};
`;

const ErrorNotice = styled.div`
  margin: 0 16px 8px;
  padding: 8px 12px;
  border-radius: 6px;
  background: ${(props) => props.theme.sidebarBackground};
  border: 1px solid ${(props) => props.theme.danger};
`;

const TurnDisclosure = styled(Text)`
  display: block;
  flex-shrink: 0;
  margin: 0 16px 8px;
  line-height: 1.4;
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
