import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { t } from "i18next";
import Router from "koa-router";
import { v4 as uuidv4 } from "uuid";
import { toError } from "@shared/utils/error";
import { Minute } from "@shared/utils/time";
import aiChatMessageCreator from "@server/commands/aiChatMessageCreator";
import env from "@server/env";
import { NotFoundError } from "@server/errors";
import Logger from "@server/logging/Logger";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import { AIChatSession } from "@server/models";
import type { User } from "@server/models";
import AIChatMessage, {
  AIChatMessageRole,
  AIChatMessageStatus,
} from "@server/models/AIChatMessage";
import type { APIContext } from "@server/types";
import { AuthenticationType } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { requestContext } from "@server/storage/requestContext";
import Redis from "@server/storage/redis";
import { assertAiChatEnabled } from "./enabled";
import { findUngroundedReason } from "./scope";
import * as T from "./schema";

/** The validated context of a chat request. */
type ChatContext = APIContext<T.AiChatSchemaReq>;

/**
 * A stored message row, narrowed to the two columns that may leave the server.
 * `role` is widened to `string` so a value outside the allow-list is re-checked
 * at runtime rather than trusted from the model's type.
 */
type StoredMessage = {
  /** The authored role, re-asserted against {@link ForwardableRoles}. */
  role: string;
  /** The message text. */
  content: string;
};

/**
 * The subset of an incremental chat-completions frame this route reads while
 * proxying the upstream body. Every field is optional because providers vary
 * and a role-only opener carries neither – `app/utils/aiChat.ts:81` parses the
 * same shape on the client.
 */
type ChatCompletionChunk = {
  choices?: {
    delta?: { content?: string };
    finish_reason?: string | null;
  }[];
};

/**
 * The roles a stored row may contribute to the upstream window. The provider
 * also accepts a `system` role, which would override the server-side persona, so
 * the allow-list is re-asserted on every row rather than trusted from the
 * column type.
 */
const ForwardableRoles: ReadonlySet<string> = new Set<string>(
  Object.values(AIChatMessageRole)
);

type ResolveUpstreamProps = {
  /** The requesting user, who must own the session being continued. */
  user: User;
  /** The validated request context. */
  ctx: ChatContext;
  /** The stored conversation to continue, absent for a standalone chat. */
  sessionId?: string;
  /**
   * The turn being started now, appended after the committed window because it
   * is not in the database yet. Omitted once it has been persisted.
   */
  pendingTurn?: T.AiChatMessageInput;
};

/**
 * Reports whether a stored role may be forwarded to the provider.
 *
 * @param role the role as stored.
 * @returns true when the role is one the provider may receive.
 */
function isForwardableRole(role: string): role is T.AiChatMessageInput["role"] {
  return ForwardableRoles.has(role);
}

/**
 * Reduces stored rows to the conversation forwarded upstream, optionally
 * followed by the turn being started now.
 *
 * Only `role` and `content` survive – `seq`, `status`, `runId`, `sessionId`,
 * `teamId` and `userId` are storage concerns. The result is capped to the most
 * recent `AiChatMaxMessages` entries, dropping the oldest context rather than the
 * pending turn.
 *
 * @param rows the committed rows, in `seq ASC` order.
 * @param pendingTurn the turn to append after the committed window, when it has
 *   not been persisted yet.
 * @returns the conversation to hand to the provider.
 */
export function toUpstreamMessages(
  rows: readonly StoredMessage[],
  pendingTurn?: T.AiChatMessageInput
): T.AiChatMessageInput[] {
  const committed: T.AiChatMessageInput[] = [];

  for (const row of rows) {
    if (isForwardableRole(row.role)) {
      committed.push({ role: row.role, content: row.content });
    }
  }

  return (pendingTurn ? [...committed, pendingTurn] : committed).slice(
    -T.AiChatMaxMessages
  );
}

/**
 * Resolves the conversation the provider is asked about.
 *
 * Without a `sessionId` the schema guarantees `messages`, so the client array is
 * the whole conversation. With one, the upstream window is derived from the
 * session's committed rows – never from the client – after ownership has been
 * resolved, so a session belonging to another user raises `NotFoundError`
 * before any provider call and without loading a single row.
 *
 * ponytail: `pendingTurn` exists so this resolver can be composed with the
 * streaming path before that path persists the turn. Once the turn is written,
 * pass nothing: the committed window already contains it, and supplying both
 * would send the turn twice. Upgrade path if a turn ever needs retrying after
 * the fetch: drop the rows that failed to persist before resolving, rather than
 * widening this function to delete them.
 *
 * @param props the requester, the validated context, and the session or pending
 *   turn to resolve.
 * @returns the resolved conversation, capped and free of storage columns.
 * @throws NotFoundError when the session does not exist or belongs to another
 *   user.
 */
export async function resolveUpstreamMessages({
  user,
  ctx,
  sessionId,
  pendingTurn,
}: ResolveUpstreamProps): Promise<T.AiChatMessageInput[]> {
  if (!sessionId) {
    return ctx.input.body.messages ?? [];
  }

  const session = await AIChatSession.findOwned(ctx, sessionId, user);

  if (!session) {
    throw NotFoundError();
  }

  const rows = await AIChatMessage.findAll({
    attributes: ["seq", "role", "content"],
    where: { sessionId: session.id },
    order: [["seq", "ASC"]],
    transaction: ctx.state.transaction,
  });

  return toUpstreamMessages(rows, pendingTurn);
}

const router = new Router();

/**
 * Serializes an arbitrary payload as a single Server-Sent Events frame.
 *
 * @param data The payload to serialize.
 * @param event The optional SSE event name.
 * @returns The encoded SSE frame.
 */
function sseFrame(data: unknown, event?: string): string {
  const prefix = event ? `event: ${event}\n` : "";
  return `${prefix}data: ${JSON.stringify(data)}\n\n`;
}

/**
 * Applies the SSE response headers shared by the streaming and refusal paths.
 *
 * @param ctx the request context.
 */
function setSseHeaders(ctx: APIContext) {
  ctx.set("Content-Type", "text/event-stream");
  ctx.set("Cache-Control", "no-cache");
  ctx.set("X-Accel-Buffering", "no");
}

/**
 * Seconds a held per-session in-flight lock survives without being released,
 * which only happens when the process dies mid-stream and no exit ever runs.
 *
 * The trade-off is asymmetric, so the value sits at the slow end of plausible.
 * A lock that expires while a legitimately slow completion is still streaming
 * silently defeats the cap — a second turn is admitted for the same session and
 * both race to allocate `seq` — whereas a lock that outlives a crash costs the
 * session one refusal per TTL, and every ordinary exit releases explicitly. A
 * completion over a full 50-message window routinely runs for a minute or two,
 * so five minutes is well above a slow stream and well below the point where a
 * stranded key would be noticed by a user.
 */
const AiChatInFlightLockTtlSeconds = 5 * Minute.seconds;

/**
 * The `kind` discriminators an `event: error` frame may carry.
 *
 * `refusal` is the grounding gate declining to answer, which the client renders
 * as an ordinary assistant turn. `busy` is a second turn arriving while the
 * first is still streaming, which is transient contention rather than a
 * considered answer — folding the two together would make a permanent,
 * knowledge-boundary refusal indistinguishable from "ask again in a moment",
 * and the two want opposite UI. Anything else the client maps to a plain
 * stream failure.
 */
type SseErrorKind = "refusal" | "busy";

/**
 * Ends the response with a single in-band `event: error` frame carrying a
 * `kind` discriminator. The event name stays `error` so a browser holding a
 * pre-rename client bundle still reads the payload's `error` field and degrades
 * to the previous banner rather than silently dropping the answer. The `kind`
 * field lets `app/utils/aiChat.ts` raise an `AiChatError` of kind `refusal`,
 * which the panel renders as an ordinary assistant transcript turn – the
 * boundary answering, not a failure – while the browser still receives a
 * well-formed stream rather than a bare error status.
 *
 * @param ctx the request context.
 * @param message the user-facing message to deliver.
 * @param kind the discriminator, defaulting to the grounding refusal.
 */
function refuseWithSseError(
  ctx: APIContext,
  message: string,
  kind: SseErrorKind = "refusal"
) {
  setSseHeaders(ctx);

  const body = new Readable({ read() {} });
  body.push(Buffer.from(sseFrame({ error: message, kind }, "error")));
  body.push(null);
  ctx.body = body;
}

router.post(
  "ai.chat",
  auth({ type: [AuthenticationType.APP] }),
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  validate(T.AiChatSchema),
  async (ctx: APIContext<T.AiChatSchemaReq>) => {
    const { user } = ctx.state.auth;
    assertAiChatEnabled(user);

    const { messages, sessionId } = ctx.input.body;
    const requestId = ctx.get("x-request-id");

    // One generation run per call, stamped on both rows of the turn so a
    // question and the answer it produced can be correlated without relying on
    // their adjacency in `seq`.
    const runId = uuidv4();

    // Ownership is resolved before anything is written or streamed, so a session
    // belonging to another user raises `NotFoundError` while the response is
    // still a normal JSON error – never a 200 carrying SSE. `null` means the
    // request is a stateless chat, which stores nothing at all.
    //
    // `resolveUpstreamMessages` re-reads the session to load its window; that
    // second read is cheaper than threading this row through its signature.
    const ownedSession = sessionId
      ? await AIChatSession.findOwned(ctx, sessionId, user)
      : null;

    if (sessionId && !ownedSession) {
      throw NotFoundError();
    }

    // At most one turn may be in flight per (user, session), so a double submit
    // or a reconnect cannot open a second concurrent upstream call against the
    // same conversation. The key is derived from the *owned* session, so it is
    // scoped to a user that already passed the ownership check, and a stateless
    // chat has no session to key on and is never locked.
    //
    // The value is this request's `runId`, which makes it an ownership token:
    // release is a compare-and-delete, so a stream whose TTL expired mid-flight
    // and whose key was re-acquired by a later turn cannot have *that* turn's
    // lock deleted out from under it. The release is also idempotent, because
    // all three exits below funnel through `finish`.
    const inFlightLock = ownedSession
      ? {
          key: `aiChat:inflight:${user.id}:${ownedSession.id}`,
          released: false,
        }
      : undefined;

    if (inFlightLock) {
      const acquired = await Redis.defaultClient.set(
        inFlightLock.key,
        runId,
        "EX",
        AiChatInFlightLockTtlSeconds,
        "NX"
      );

      if (acquired !== "OK") {
        Logger.warn("AI chat turn refused, another turn is already in flight", {
          requestId,
          sessionId: inFlightLock.key.split(":").at(-1),
        });

        // Refused in-band rather than thrown: the client is already expecting a
        // stream from this endpoint, and a bare HTTP status here would leave it
        // with no frame to attach the answer to.
        refuseWithSseError(
          ctx,
          t("Another answer for this conversation is still being generated"),
          "busy"
        );
        return;
      }
    }

    /**
     * Releases the in-flight lock, at most once. A no-op for a stateless chat,
     * which never took one. Never rejects: a failed release must not take down
     * the exit that called it, and the TTL bounds how long a stranded key can
     * outlive it anyway.
     */
    const releaseInFlightLock = async () => {
      if (!inFlightLock || inFlightLock.released) {
        return;
      }
      inFlightLock.released = true;

      try {
        // Compare-and-delete: the value under the key must still be this
        // request's `runId`. A bare `del` would remove a lock that a later turn
        // had re-acquired after this one's TTL lapsed, un-capping that turn.
        const script =
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
        await Redis.defaultClient.eval(script, 1, inFlightLock.key, runId);
      } catch (err) {
        Logger.warn(
          "AI chat in-flight lock could not be released",
          toError(err)
        );
      }
    };

    /**
     * Appends one row to the stored session, or does nothing for a stateless
     * chat. Every write on this path goes through here, and every one of them
     * opens and commits its own short-lived transaction: `aiChatMessageCreator`
     * never reads or replaces `ctx.state.transaction`, and `ai.chat` carries no
     * `transaction()` middleware, so there is none to hold open. That is
     * deliberate and load-bearing — the assistant flush below runs after the
     * stream has ended, long after this handler returned, so a transaction
     * opened here would have to stay open across the entire SSE stream.
     */
    const appendTurn = async (
      role: AIChatMessageRole,
      content: string,
      status: AIChatMessageStatus
    ) => {
      if (!ownedSession) {
        return;
      }

      // Runs outside this request's async context. `database.ts` refuses reads
      // whose originating socket is already destroyed, so a flush after a
      // client disconnect fails its own `max(seq)` read and the turn is lost –
      // which is precisely the case the abort path exists to record. That guard
      // exists to stop spending database work on a response nobody will
      // receive, and it is registered on `beforeFind`/`beforeCount` only, so
      // writes were never gated by it: this write's deliverable is the row, not
      // the response. Reads stay guarded everywhere else.
      await requestContext.exit(() =>
        aiChatMessageCreator({
          user,
          sessionId: ownedSession.id,
          role,
          content,
          status,
          runId,
          ctx,
        }).catch((err) =>
          // A turn that cannot be stored is a lost answer, never a failed
          // request: the bytes are already on the wire, so there is nothing left
          // to report to the client and the stream must still terminate.
          Logger.error("AI chat turn could not be persisted", toError(err), {
            requestId,
          })
        )
      );
    };

    // The turn being started now, as supplied by the client. With a stored
    // session it is the newest client message; only a user turn is new
    // material, an assistant-last array being a regeneration whose answer is
    // stored when the stream finishes.
    const pendingTurn = messages?.at(-1);

    if (ownedSession && pendingTurn?.role === "user") {
      // Written *before* the grounding gate, which is what makes a refusal
      // recoverable: reopening the session must show the question the user
      // actually asked, not an orphan refusal with nothing above it. Persisting
      // after the gate would leave the refusal as the first row and lose the
      // turn that produced it.
      await appendTurn(
        AIChatMessageRole.User,
        pendingTurn.content,
        AIChatMessageStatus.Completed
      );
    }

    // Resolved after the turn is committed, so the gate and the provider are
    // asked about the same conversation. `pendingTurn` is passed only when the
    // turn was not written: the committed window already contains it, and
    // supplying both would send the turn to the provider twice.
    const resolvedMessages = await resolveUpstreamMessages({
      user,
      ctx,
      sessionId,
      pendingTurn: pendingTurn?.role === "user" ? undefined : pendingTurn,
    });

    // SSE responses must not be compressed – buffering defeats incremental
    // delivery. koa-compress honors `ctx.compress = false` as a filter bypass.
    ctx.compress = false;

    // The upstream stream may be long-lived; disable the per-request socket
    // timeout that would otherwise cut the connection mid-stream.
    ctx.req.setTimeout(0);

    // The provider's persona carries the knowledge-base boundary as prompt
    // text only, and honours it roughly 60% of the time – it answers general
    // knowledge from memory otherwise. Refuse here, unless the requesting user's
    // own documents can ground the prompt, so the boundary is structural and
    // costs no upstream call or latency on a refusal. The refusal is delivered
    // with a `kind: "refusal"` discriminator (see `refuseWithSseError`) so the
    // panel renders it as an ordinary transcript turn rather than an error.
    const ungroundedReason = await findUngroundedReason(user, resolvedMessages);
    if (ungroundedReason) {
      Logger.warn("AI chat prompt rejected as ungrounded", {
        requestId,
        reason: ungroundedReason,
      });
      // Inlined, not `OutOfScopeRefusal`: i18next-parser sees string literals
      // only. ai.test.ts fails if these two ever differ. The literal must stay
      // contiguous in source — it is passed as a bare argument below, which is
      // the one position the formatter does not break across lines.
      //
      // Stored before the frame is written, so a client that reacts to the
      // refusal by reloading history already finds the row. The string is
      // **locale-frozen at send time**: it is never re-translated on read, so
      // reopening the session replays the text the sender received rather than a
      // later translation of a key. Storing the `OutOfScopeRefusal` constant
      // instead would let the row drift away from the wire on any future change
      // to either one.
      await appendTurn(
        AIChatMessageRole.Assistant,
        t("This assistant only answers from this workspace’s knowledge base"),
        AIChatMessageStatus.Completed
      );

      refuseWithSseError(
        ctx,
        t("This assistant only answers from this workspace’s knowledge base")
      );

      // A refusal returns before the stream exists, so `finish` never runs for
      // this request. The lock taken above would otherwise sit until its TTL.
      await releaseInFlightLock();
      return;
    }

    // Abort the upstream request if the client disconnects before the stream
    // has finished, so we do not keep the provider connection open.
    //
    // The listener is on `ctx.res`, not `ctx.req`. An `IncomingMessage` emits
    // `close` exactly once, as soon as its body has been consumed — which
    // koa-body did before this handler ran — so by the time this listener is
    // attached that event is already gone and a real disconnect is invisible.
    // `ServerResponse` emits `close` when the socket actually goes away, which
    // is the signal this needs; verified against a live abort, where `res`
    // fired within 10ms and `req` never fired at all. `writableEnded`
    // separates a genuine disconnect from the ordinary close after `end()`.
    //
    // The listener is also wired in two stages. `clientGone` is set the moment
    // the socket drops, because the flag alone already separates a disconnect
    // from a provider failure; `onClientGone` can only be attached once the
    // stream state exists, which is after the provider has answered.
    let clientGone = false;
    let onClientGone: (() => void) | undefined;
    const ac = new AbortController();
    ctx.res.on("close", () => {
      if (!ctx.res.writableEnded) {
        clientGone = true;
        ac.abort();
        onClientGone?.();
      }
    });

    // Opens the upstream stream. Nothing has been written to the client yet, so
    // a failure here is an ordinary HTTP error rather than a broken pipe – but
    // it is still an exit, and the lock has to go with it. Releasing inside the
    // catch keeps the window between "provider unreachable" and "session usable
    // again" at one round trip instead of the whole TTL.
    let upstream: Readable;
    try {
      const res = await fetch(`${env.AI_CHAT_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.AI_CHAT_API_KEY
            ? { Authorization: `Bearer ${env.AI_CHAT_API_KEY}` }
            : {}),
        },
        body: JSON.stringify({
          model: env.AI_CHAT_MODEL,
          stream: true,
          messages: resolvedMessages,
        }),
        signal: ac.signal,
      });

      // The upstream refused the request. Nothing has been written to the
      // client yet, so throw a normal error that the API error handler renders
      // as JSON. The provider's own message is logged only – it can carry
      // prompts, internal hostnames or account identifiers.
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        Logger.error(
          "AI chat upstream request failed",
          toError(
            new Error(
              `Upstream returned ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`
            )
          ),
          { status: res.status, requestId }
        );

        ctx.throw(res.status, "AI chat provider error");
      }

      if (!res.body) {
        ctx.throw(502, "AI chat provider returned an empty response");
      }

      upstream = Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>);
    } catch (err) {
      await releaseInFlightLock();
      throw err;
    }

    setSseHeaders(ctx);

    // Wrap the upstream body so a mid-stream error can be interposed as an
    // in-band SSE frame rather than surfacing as a broken pipe. `body` is the
    // only writer on the socket – koa pipes it into `ctx.res` – so a second
    // writer would interleave and corrupt frames.
    const body = new Readable({ read() {} });
    let ended = false;

    const end = () => {
      if (ended) {
        return;
      }
      ended = true;
      body.push(null);
    };

    // The answer as it is produced, and why generation stopped. `data: [DONE]`
    // cannot decide either: the OpenAI SDK consumes the sentinel and never
    // forwards it, so nothing downstream can rely on seeing it. `finish_reason`
    // is the one signal that survives every provider proxy, so the last frame
    // carrying a non-null one means the answer is whole and anything else means
    // it was cut – by an output limit, or by the provider disappearing.
    let assistantText = "";
    let lastFinishReason: string | null = null;
    let frameBuffer = "";
    const decoder = new TextDecoder();

    // Terminal state of this turn, recorded by whichever exit arrives first.
    // Every exit funnels through `finish`, which is idempotent: an `end` after
    // an `error`, or the `error` an abort produces after the disconnect handler
    // already flushed, must not append a second row for the same turn.
    let flushed = false;

    const finish = (status: AIChatMessageStatus) => {
      // A stateless chat is a pure byte proxy: no row is written and no
      // terminal frame is authored, so the wire format is exactly what it was
      // before turns were stored.
      if (!ownedSession) {
        end();
        return;
      }
      if (flushed) {
        return;
      }
      flushed = true;

      // The server authors its own terminal frame rather than leaving the
      // client to infer one. Only the clean exits carry a distinction worth
      // reporting – an aborted or failed stream already terminates with
      // `event: error`, and in the aborted case there is no client left to
      // read anything.
      if (
        status === AIChatMessageStatus.Completed ||
        status === AIChatMessageStatus.Truncated
      ) {
        body.push(
          Buffer.from(
            sseFrame(
              { runId, finishReason: lastFinishReason },
              status === AIChatMessageStatus.Truncated
                ? "truncated"
                : "complete"
            )
          )
        );
      }

      const content = assistantText;

      // Never persist an empty assistant turn. The client optimistically
      // appends `content: ""`, so a turn that produced nothing – an abort
      // before the first token, a provider that only sent `[DONE]` – would
      // store a blank bubble indistinguishable from a lost answer.
      if (!content) {
        void releaseInFlightLock().finally(end);
        return;
      }

      // The response is only terminated once the turn is durable, so a client
      // that reloads history the instant it sees the terminal frame cannot
      // race the insert. `appendTurn` cannot reject, so `end` always runs.
      //
      // The lock is released in the same breath: a later turn acquires it, then
      // resolves the upstream window from the database, so dropping it before
      // the row is committed would let that turn read a window missing the
      // answer it is meant to continue from.
      void appendTurn(AIChatMessageRole.Assistant, content, status)
        .then(() => releaseInFlightLock())
        .finally(end);
    };

    // Reads the delta text and the terminal reason out of every complete frame
    // in the chunk. A frame split across chunks stays buffered until its
    // blank-line terminator arrives, and a payload that is not JSON is skipped
    // rather than thrown – a malformed frame must not cost the turn its record.
    const inspectChunk = (chunk: Buffer) => {
      frameBuffer += decoder.decode(chunk, { stream: true });

      let separator = frameBuffer.indexOf("\n\n");
      while (separator !== -1) {
        const frame = frameBuffer.slice(0, separator);
        frameBuffer = frameBuffer.slice(separator + 2);
        separator = frameBuffer.indexOf("\n\n");

        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).replace(/^ /, ""))
          .join("\n");

        if (!data || data === "[DONE]") {
          continue;
        }

        let payload: ChatCompletionChunk;
        try {
          payload = JSON.parse(data) as ChatCompletionChunk;
        } catch {
          continue;
        }

        const choice = payload.choices?.[0];
        if (typeof choice?.delta?.content === "string") {
          assistantText += choice.delta.content;
        }
        if (typeof choice?.finish_reason === "string") {
          lastFinishReason = choice.finish_reason;
        }
      }
    };

    upstream.on("data", (chunk: Buffer) => {
      // Inspected before the forwarding guard: a chunk that arrives after the
      // client vanished still belongs to the answer being recorded.
      inspectChunk(chunk);
      if (!ended && !ctx.res.writableEnded) {
        body.push(chunk);
      }
    });
    upstream.on("end", () =>
      finish(
        lastFinishReason
          ? AIChatMessageStatus.Completed
          : AIChatMessageStatus.Truncated
      )
    );
    upstream.on("error", (err: Error) => {
      Logger.error("AI chat stream failed", toError(err), { requestId });

      // Pushed even when nothing has flushed yet – `body` buffers until koa
      // pipes it, whereas throwing now would leave the client with a bare 200.
      if (!ended) {
        body.push(
          Buffer.from(sseFrame({ error: "The AI chat stream failed" }, "error"))
        );
      }

      // An abort reaches this handler as an `error` and never as an `end`,
      // which is why it has to be told apart by the disconnect rather than by
      // the event that carried it.
      finish(
        clientGone ? AIChatMessageStatus.Aborted : AIChatMessageStatus.Error
      );
    });

    onClientGone = () => finish(AIChatMessageStatus.Aborted);
    ctx.body = body;
  }
);

export default router;
