import { ChatClient } from "@tanstack/ai-client";
import type { UIMessage } from "@tanstack/ai-client";
import { observer } from "mobx-react";
import { GrowIcon, InfoIcon, ShrinkIcon } from "outline-icons";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import styled, { css } from "styled-components";
import { s } from "@shared/styles";
import Button from "~/components/Button";
import Flex from "~/components/Flex";
import Input from "~/components/Input";
import Scrollable from "~/components/Scrollable";
import Text from "~/components/Text";
import Tooltip from "~/components/Tooltip";
import useStores from "~/hooks/useStores";
import SidebarLayout from "~/scenes/Document/components/SidebarLayout";
import {
  clearDraft,
  createAiChatConnection,
  flushDrafts,
  readDraft,
  toAiChatError,
  writeDraft,
} from "~/utils/aiChat";
import type {
  AiChatError,
  AiChatKind,
  AiChatMessage,
  AiChatTurnStatus,
} from "~/utils/aiChat";
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
 * The text and reasoning carried by the client's trailing assistant message.
 * Only `text` and `thinking` parts contribute; tool and unknown parts are left
 * for the slices that render them (todos 14 and 16).
 *
 * @param messages the client's current messages.
 * @returns the joined answer text and the joined reasoning text.
 */
function liveAssistant(messages: UIMessage[]): {
  text: string;
  reasoning: string;
} {
  let assistant: UIMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant") {
      assistant = messages[index];
      break;
    }
  }

  const text: string[] = [];
  const reasoning: string[] = [];

  for (const part of assistant?.parts ?? []) {
    switch (part.type) {
      case "text":
        text.push(part.content);
        break;
      case "thinking":
        reasoning.push(part.content);
        break;
      default:
        break;
    }
  }

  return { text: text.join(""), reasoning: reasoning.join("") };
}

/**
 * Merges the turn still held by the client over the committed rows. The store
 * stays the source of truth: a local turn is dropped the moment the equivalent
 * stored row is read back, so the same question or answer is never rendered
 * twice around the settle boundary.
 *
 * @param stored the committed rows, oldest first.
 * @param pending the local turn, when one is in flight.
 * @returns the transcript to render.
 */
function mergeTurns(
  stored: TranscriptTurn[],
  pending: TranscriptTurn[]
): TranscriptTurn[] {
  let local = pending;
  const lastStored = stored[stored.length - 1];
  const firstLocal = local[0];

  if (
    lastStored &&
    firstLocal &&
    lastStored.role === "user" &&
    firstLocal.role === "user" &&
    lastStored.content === firstLocal.content
  ) {
    local = local.slice(1);
  }

  const storedAnswer = stored[stored.length - 1];
  const localAnswer = local[local.length - 1];

  if (
    storedAnswer &&
    localAnswer &&
    storedAnswer.role === "assistant" &&
    localAnswer.role === "assistant" &&
    storedAnswer.content === localAnswer.content
  ) {
    local = local.slice(0, -1);
  }

  return [...stored, ...local];
}

/**
 * Renders the user-facing message for a failed chat request. The HTTP status
 * decides first, since a rejected request is the case a user can act on – a
 * 404 means the feature is off for the workspace, a 403 an expired session –
 * and the transport's failure kind decides the rest.
 *
 * @param error the error thrown while streaming.
 * @param t the translation function.
 * @returns the message to display to the user.
 */
function errorText(error: AiChatError, t: (key: string) => string): string {
  switch (error.status) {
    case 404:
      return t("AI chat is not enabled for this workspace");
    case 403:
      return t("Your session has expired, refresh the page to continue");
    case 429:
      return t("Too many requests, try again shortly");
    default:
      break;
  }

  // A rejected request's `error.message` is the server's own JSON envelope
  // message, already localized server-side, so it is surfaced verbatim – it
  // names the field or rule that refused the turn, which the generic copy
  // below cannot. Every other kind's message is an English literal from the
  // transport that can never be localized, so those render from their kind.
  switch (error.kind) {
    case "http":
      return error.message;
    case "network":
      return t("A network error occurred, try again?");
    case "stream":
      return t("The AI chat stream failed, try again?");
    case "busy":
      return t("Another AI chat response is still in progress");
    case "truncated":
      return t("The AI chat answer stopped before it finished");
    case "malformed":
      return t("The AI chat response could not be read");
    case "refusal":
      return t("The AI chat request was declined");
    case "aborted":
      return t("The AI chat request was cancelled");
    default:
      return t("The AI chat request failed, try again?");
  }
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
  const sessionId = aiChatSessions.selectedSessionId;
  const [pending, setPending] = React.useState<TranscriptTurn[]>([]);
  const [input, setInput] = React.useState(() =>
    readDraft(sessionId ?? undefined)
  );
  const [isStreaming, setIsStreaming] = React.useState(false);
  const [error, setError] = React.useState<AiChatError | null>(null);
  // The reasoning of the turn currently streaming. Kept only for the live turn:
  // it is never persisted (the server accumulates `content` alone), so a
  // reopened conversation shows the answer without the thinking behind it.
  const [reasoning, setReasoning] = React.useState("");
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  // The client for the turn currently in flight. It is recreated per turn, so
  // it never owns the committed transcript – the store does.
  const clientRef = React.useRef<ChatClient | null>(null);
  // Identifies the current turn. Bumping it orphans every callback and the
  // `handleSubmit` continuation belonging to an aborted or superseded turn.
  const turnRef = React.useRef(0);
  const stopRequestedRef = React.useRef(false);
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  const formRef = React.useRef<HTMLFormElement>(null);

  /**
   * Abandons the in-flight turn: aborts the client and discards both the
   * streaming frame source and its React callbacks. A deliberate Stop keeps the
   * partial turn visible; callers that switch conversations also clear it.
   */
  const stopTurn = React.useCallback(() => {
    turnRef.current += 1;
    stopRequestedRef.current = true;

    const client = clientRef.current;
    clientRef.current = null;
    client?.stop();
    client?.dispose();

    setIsStreaming(false);
  }, []);

  // Abort any in-flight stream when the panel unmounts, and commit whatever
  // the composer has typed but not yet written. Without the flush, a draft
  // typed in the last moments before closing is lost to the debounce.
  React.useEffect(
    () => () => {
      turnRef.current += 1;
      const client = clientRef.current;
      clientRef.current = null;
      client?.dispose();
      flushDrafts();
    },
    []
  );

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
    // opened here always reflects committed turns. A failure here is swallowed
    // only to keep the rejection out of the console; the rows a slow request
    // returns still land in the store stamped with this session id.
    void aiChatMessages.list({ sessionId }).then(
      () => undefined,
      () => undefined
    );
  }, [aiChatMessages, sessionId]);

  // Show the draft belonging to whichever conversation is open, both on mount
  // and whenever the selection changes, so an unsent question is never carried
  // into – or lost with – a different conversation.
  React.useEffect(() => {
    setInput(readDraft(sessionId ?? undefined));
  }, [sessionId]);

  // The persisted turns of the active session, ordered by ascending `seq` so
  // the transcript reads oldest-first. Deliberately not `orderedData`, which
  // sorts by `createdAt` descending.
  //
  // Computed inline rather than memoized: `aiChatMessages.data` is an observable
  // Map whose *reference* never changes, so a `useMemo` keyed on it caches the
  // empty first render and never recomputes when the messages arrive – the
  // transcript stayed blank on reopen. As an `observer`, this read re-tracks the
  // Map and re-renders when a row is added.
  const storedTurns: TranscriptTurn[] = sessionId
    ? Array.from(aiChatMessages.data.values())
        .filter((message) => message.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq)
        .map((message) => ({
          seq: message.seq,
          role: message.role,
          content: message.content,
          status: message.status,
        }))
    : [];

  const turns: TranscriptTurn[] = mergeTurns(storedTurns, pending);

  const handleNewChat = React.useCallback(() => {
    stopTurn();
    setError(null);
    aiChatSessions.setSelectedSessionId(null);
    setPending([]);
  }, [stopTurn, aiChatSessions]);

  const handleSelectSession = React.useCallback(
    (id: string) => {
      stopTurn();
      setError(null);
      aiChatSessions.setSelectedSessionId(id);
      setPending([]);
    },
    [stopTurn, aiChatSessions]
  );

  // Keep the transcript pinned to the latest message as it grows. Keyed on the
  // transcript's length and its last turn's text, not on `turns` itself: that
  // array is rebuilt every render (it is derived from the observable store), so
  // it can never be a stable dependency.
  const lastTurnText = turns.length ? turns[turns.length - 1].content : "";
  React.useEffect(() => {
    const el = transcriptRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns.length, lastTurnText]);

  const handleStop = stopTurn;

  const handleToggleFullscreen = React.useCallback(() => {
    setIsFullscreen((current) => !current);
  }, []);

  /**
   * Creates the conversation a turn is about to be stored in and selects it.
   * Called on the first send of a new conversation: a turn sent without a
   * `sessionId` is stateless and written nowhere, so the transcript would not
   * survive closing the panel.
   *
   * @returns the created session, whose `id` is the conversation to send under.
   */
  const createSession = React.useCallback(async () => {
    const session = await aiChatSessions.create({});
    aiChatSessions.setSelectedSessionId(session.id);
    return session;
  }, [aiChatSessions]);

  // A plain function, not `useCallback`: it reads `turns`, which is rebuilt
  // every render, so it could never be memoized on stable inputs anyway, and no
  // memoized consumer depends on its identity.
  const handleSubmit = async (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const content = input.trim();
    if (!content || isStreaming) {
      return;
    }

    setPending([
      { role: "user", content },
      { role: "assistant", content: "" },
    ]);
    setInput("");
    // The question is now a transcript turn, so it must not also come back as
    // a draft for this conversation.
    clearDraft(sessionId ?? undefined);
    setError(null);
    setReasoning("");
    setIsStreaming(true);

    const turn = ++turnRef.current;
    stopRequestedRef.current = false;
    let client: ChatClient | undefined;
    let observedKind: AiChatKind = null;

    try {
      // A conversation is only stored once it has an id: without one the server
      // treats the turn as stateless and persists nothing, which is how a
      // transcript was lost on close. Created on the first send rather than on
      // "New chat" so a fresh conversation nobody sends in leaves no empty row.
      const targetSessionId = sessionId ?? (await createSession()).id;

      if (turnRef.current !== turn || stopRequestedRef.current) {
        return;
      }

      // A per-turn headless `ChatClient` rather than `useChat`: the persisted
      // session id only exists after this turn's session is created, and the
      // client's `threadId` is fixed at construction (`updateOptions` cannot
      // change it), so `useChat`'s option-bag recreations would not address the
      // very first send. The client is a frame source only — the committed
      // history stays in the store and is merged in for rendering.
      const connection = createAiChatConnection({
        onKind: (kind) => {
          observedKind = kind;
        },
      });
      let failure: unknown;

      const chat = new ChatClient({
        connection: {
          ...connection,
          connect: async function* (messages, data, signal, runContext) {
            try {
              yield* connection.connect(messages, data, signal, runContext);
            } catch (err) {
              failure = err;
              throw err;
            }
          },
        },
        threadId: targetSessionId,
        onMessagesChange: (messages) => {
          if (clientRef.current !== chat) {
            return;
          }

          const live = liveAssistant(messages);
          setPending((current) => {
            if (current.length === 0) {
              return current;
            }
            const updated = current.slice();
            updated[updated.length - 1] = {
              role: "assistant",
              content: live.text,
            };
            return updated;
          });
          setReasoning(live.reasoning);
        },
        onLoadingChange: (loading) => {
          if (clientRef.current !== chat) {
            return;
          }
          setIsStreaming(loading);
        },
        onError: (err) => {
          failure = failure ?? err;
        },
      });

      client = chat;
      clientRef.current = chat;
      await chat.sendMessage(content);

      if (turnRef.current !== turn) {
        return;
      }

      const error = failure ?? chat.getError();

      if (error) {
        setError(toAiChatError(error, { kind: observedKind }));
        return;
      }

      // Busy is a complete synthetic run, so no error is thrown for it; the
      // header is the only signal that this turn should be retried later.
      if (observedKind === "busy") {
        setError(toAiChatError(undefined, { kind: observedKind }));
        return;
      }

      // The stream only closes after the server has committed the turn, so the
      // re-read is guaranteed to include the assistant row; the local turn is
      // dropped in the same pass.
      await aiChatMessages.list({ sessionId: targetSessionId }).then(
        () => undefined,
        () => undefined
      );

      if (turnRef.current === turn) {
        setPending([]);
      }
    } catch (err) {
      if (turnRef.current === turn) {
        setError(toAiChatError(err, { kind: observedKind }));
      }
    } finally {
      if (client && clientRef.current === client) {
        clientRef.current = null;
        client.dispose();
      }
    }
  };

  const handleChange = React.useCallback(
    (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const text = ev.target.value;
      setInput(text);
      writeDraft(text, sessionId ?? undefined);
    },
    [sessionId]
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
      fullscreen={isFullscreen}
      actions={
        <>
          <AIChatHistory
            activeSessionId={sessionId}
            onSelect={handleSelectSession}
            onNewChat={handleNewChat}
          />
          <Tooltip content={t("Toggle fullscreen")} placement="bottom">
            <Button
              icon={isFullscreen ? <ShrinkIcon /> : <GrowIcon />}
              onClick={handleToggleFullscreen}
              borderOnHover
              neutral
              aria-label={t("Toggle fullscreen")}
              data-testid="ai-chat-fullscreen"
            />
          </Tooltip>
        </>
      }
    >
      <Container column>
        <Transcript ref={transcriptRef} data-testid="ai-chat-transcript">
          {turns.length === 0 && (
            <EmptyText type="secondary" size="small">
              {t("Ask anything about your workspace")}
            </EmptyText>
          )}
          {turns.map((turn, index) => {
            const isLast = index === turns.length - 1;
            const isStreamingAssistant =
              isStreaming && isLast && turn.role === "assistant";

            // An assistant turn with no content is either still streaming –
            // waiting on its first token – or a stateless answer the server
            // never recorded. Only a streaming turn earns an empty bubble to
            // carry the spinner; the rest render nothing.
            if (
              turn.role === "assistant" &&
              !turn.content &&
              !isStreamingAssistant
            ) {
              return null;
            }

            const marker = turnMarker(turn);

            return (
              <Message
                key={turn.seq ?? `pending-${index}`}
                $role={turn.role}
                dir="auto"
                data-testid={`message-${turn.role}`}
              >
                {isStreamingAssistant && (
                  <Spinner
                    data-testid="ai-chat-spinner"
                    role="status"
                    aria-label={t("Loading")}
                  />
                )}
                {isStreamingAssistant && reasoning && (
                  <ReasoningDisclosure data-testid="ai-chat-reasoning">
                    <summary>{`${t("Loading")}…`}</summary>
                    <ReasoningBody>{reasoning}</ReasoningBody>
                  </ReasoningDisclosure>
                )}
                {turn.role === "assistant" ? (
                  // Assistant output is an aria-live region so a refusal – which
                  // renders inline without the error banner's visual affordance –
                  // is still announced to assistive technology.
                  <span role="status">{renderAnswer(turn.content)}</span>
                ) : (
                  turn.content
                )}
                {marker && (
                  <TurnMarker
                    data-testid={`message-status-${turn.status}`}
                    $tone={marker.tone}
                  >
                    {t(marker.labelKey)}
                  </TurnMarker>
                )}
              </Message>
            );
          })}
        </Transcript>

        <TurnDisclosure type="secondary" size="xsmall">
          <InfoIcon size={14} />
          <span>
            {t(
              "AI chat is grounded in this workspace, but answers are generated text and may be wrong or out of date — check anything important against the source documents."
            )}
          </span>
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
 * The label is a translation key rather than text, so the copy is resolved by
 * the caller's `t` at render time.
 *
 * @param turn the transcript entry to describe.
 * @returns the marker to render, or undefined when the turn needs none.
 */
function turnMarker(
  turn: TranscriptTurn
): { labelKey: string; tone: "danger" | "warning" } | undefined {
  if (turn.role !== "assistant") {
    return undefined;
  }

  switch (turn.status) {
    case "truncated":
      return { labelKey: "Response cut short", tone: "warning" };
    case "aborted":
      return { labelKey: "Stopped", tone: "warning" };
    case "error":
      return { labelKey: "Failed", tone: "danger" };
    default:
      return undefined;
  }
}

const linkStyles = css`
  color: ${(props) => props.theme.link};
  text-decoration: underline;
  overflow-wrap: anywhere;
`;

const InternalLink = styled(Link)`
  ${linkStyles}
`;

const ExternalLink = styled.a`
  ${linkStyles}
`;

/**
 * A single http(s) URL, up to the first whitespace. The capture group keeps the
 * match in the output of `String.prototype.split`, which otherwise drops it.
 */
const UrlPattern = /(https?:\/\/\S+)/;

/** Markdown emphasis and code markers, dropped from rendered output. */
const MarkdownMarkers = /\*\*|__|`{1,3}|~~/g;

/** Sentence punctuation that ends a URL's token but not the URL itself. */
const TrailingPunctuation = /[)\].,;:!?"'»]+$/;

/**
 * Resolves an in-app URL to a router path. A URL on this origin resolves to its
 * path so the citation navigates client-side and the panel stays mounted; any
 * other URL (a foreign host, a scheme this SPA cannot route) returns undefined
 * and is rendered as a plain anchor instead.
 *
 * @param url the absolute URL to resolve.
 * @returns the router path, or undefined when the URL is not same-origin.
 */
function internalPath(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin === window.location.origin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Renders one assistant answer as plain, end-user-friendly text. Assistant
 * replies are generated text that arrives with light Markdown – emphasis and
 * code markers, list markers, bare source URLs – but the transcript is rendered
 * as plain text with `white-space: pre-wrap`, so the markers are stripped rather
 * than shown literally and every bare URL becomes a link: same-origin to a
 * document route (keeping the panel open), otherwise a plain anchor.
 *
 * @param content the raw assistant turn body.
 * @returns the nodes to render for the turn.
 */
function renderAnswer(content: string): React.ReactNode {
  const cleaned = content.replace(MarkdownMarkers, "");

  return cleaned.split(UrlPattern).map((part, index) => {
    if (!/^https?:\/\//.test(part)) {
      return part;
    }

    const trailing = part.match(TrailingPunctuation)?.[0] ?? "";
    const url = part.slice(0, part.length - trailing.length);

    if (!url) {
      return part;
    }

    const path = internalPath(url);

    return (
      <React.Fragment key={index}>
        {path ? (
          <InternalLink to={path}>{url}</InternalLink>
        ) : (
          <ExternalLink href={url}>{url}</ExternalLink>
        )}
        {trailing}
      </React.Fragment>
    );
  });
}

const ReasoningDisclosure = styled.details`
  margin-top: 6px;
  font-size: 12px;
  color: ${s("textTertiary")};

  summary {
    cursor: var(--pointer);
    font-weight: 500;
  }
`;

const ReasoningBody = styled.div`
  margin-top: 4px;
  padding: 6px 8px;
  border-radius: 6px;
  background: ${s("sidebarBackground")};
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

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

const Spinner = styled.span`
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-inline-end: 8px;
  vertical-align: -2px;
  border: 2px solid ${s("divider")};
  border-top-color: ${s("textTertiary")};
  border-radius: 50%;
  animation: ai-chat-spin 0.7s linear infinite;

  @keyframes ai-chat-spin {
    to {
      transform: rotate(360deg);
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
  display: flex;
  align-items: flex-start;
  gap: 6px;
  flex-shrink: 0;
  margin: 0 16px 8px;
  font-size: 12px;
  line-height: 1.4;

  svg {
    flex-shrink: 0;
    margin-top: 1px;
  }
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
