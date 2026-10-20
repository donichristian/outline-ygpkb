import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { t } from "i18next";
import Router from "koa-router";
import { v4 as uuidv4 } from "uuid";
import { toError } from "@shared/utils/error";
import { Minute } from "@shared/utils/time";
import env from "@server/env";
import { NotFoundError, ProviderUnavailableError } from "@server/errors";
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
import Redis from "@server/storage/redis";
import { assertAiChatEnabled } from "./enabled";
import { messageText } from "./messages";
import type { MessageLike } from "./messages";
import { appendTurn, createPersistenceMiddleware } from "./middleware";
import { findUngroundedReason } from "./scope";
import * as T from "./schema";
import { loadTanstack } from "./tanstack";
import { loadServerTools } from "./tools";
import { createAiChatAdapter } from "./adapter";

/** The validated context of a chat request. */
type ChatContext = APIContext<T.AiChatSchemaReq>;

/**
 * A message as forwarded to the provider: storage columns and AG-UI parts are
 * gone, and `content` is always text. This is the shape both the provider and
 * the grounding gate consume.
 */
export type UpstreamMessage = {
  /** The authored role, re-asserted against {@link ForwardableRoles}. */
  role: T.AiChatMessageInput["role"];
  /** The flattened message text. */
  content: string;
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
 * Reduces one message to its forwardable form, dropping it when it has no text
 * or when its role is outside the allow-list.
 *
 * The role is re-asserted **after** flattening, so a `system` role can neither
 * ride in on a legacy `{ role, content }` body nor hide inside an AG-UI
 * `{ role, parts }` one.
 *
 * @param message the message to reduce, in either accepted shape.
 * @returns the `{ role, content }` row, or undefined when it may not be sent.
 */
function toUpstreamMessage(
  message: MessageLike
): UpstreamMessage | undefined {
  const content = messageText(message);

  if (!message.role || !isForwardableRole(message.role)) {
    return undefined;
  }

  if (!content) {
    return undefined;
  }

  return { role: message.role, content };
}

/**
 * Reduces messages to the conversation forwarded upstream, optionally followed
 * by the turn being started now.
 *
 * Only `role` and `content` survive – `seq`, `status`, `runId`, `sessionId`,
 * `teamId`, `userId`, `id` and `parts` are storage or transport concerns. The
 * result is capped to the most recent `AiChatMaxMessages` entries, dropping the
 * oldest context rather than the pending turn.
 *
 * @param messages the committed messages (stored rows or the client array), in
 *   conversation order.
 * @param pendingTurn the turn to append after the committed window, when it has
 *   not been persisted yet.
 * @returns the conversation to hand to the provider.
 */
export function toUpstreamMessages(
  messages: readonly MessageLike[],
  pendingTurn?: MessageLike
): UpstreamMessage[] {
  const committed: UpstreamMessage[] = [];

  for (const message of messages) {
    const forwarded = toUpstreamMessage(message);

    if (forwarded) {
      committed.push(forwarded);
    }
  }

  const pending = pendingTurn ? toUpstreamMessage(pendingTurn) : undefined;

  return (pending ? [...committed, pending] : committed).slice(
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
}: ResolveUpstreamProps): Promise<UpstreamMessage[]> {
  if (!sessionId) {
    return toUpstreamMessages(ctx.input.body.messages ?? []);
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
 * The `kind` discriminators a refused turn may carry, surfaced to the client as
 * the `X-AI-Chat-Kind` response header.
 *
 * `refusal` is the grounding gate declining to answer, which the client renders
 * as an ordinary assistant turn. `busy` is a second turn arriving while the
 * first is still streaming, which is transient contention rather than a
 * considered answer — folding the two together would make a permanent,
 * knowledge-boundary refusal indistinguishable from "ask again in a moment",
 * and the two want opposite UI. Anything else the client maps to a plain
 * stream failure.
 */
type ChatFallbackKind = "refusal" | "busy";

/** Inputs for {@link refuseWithAgUiRun}. */
type RefuseWithAgUiRunProps = {
  ctx: APIContext;
  message: string;
  kind: ChatFallbackKind;
  runId: string;
  sessionId?: string;
};

/**
 * Ends the response with a complete, server-authored AG-UI run delivered as SSE
 * `data:` frames, followed by no terminal sentinel.
 *
 * The five frame types are `RUN_STARTED`, `TEXT_MESSAGE_START`,
 * `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, `RUN_FINISHED`, matching the shape
 * the TanStack transport emits for a real answer so the client's stream reader
 * needs no special case. The `kind` travels only in the `X-AI-Chat-Kind`
 * response header — the client must branch on that header alone, never on the
 * message text and never on the run id, both of which are ordinary values a real
 * answer also carries.
 *
 * @param props the context, message, discriminator, run id, and optional session.
 */
function refuseWithAgUiRun({
  ctx,
  message,
  kind,
  runId,
  sessionId,
}: RefuseWithAgUiRunProps) {
  setSseHeaders(ctx);
  ctx.set("X-AI-Chat-Kind", kind);
  ctx.status = 200;

  const messageId = uuidv4();
  const timestamp = Date.now();
  const base = sessionId
    ? { runId, threadId: sessionId, timestamp }
    : { runId, timestamp };
  const frames = [
    { type: "RUN_STARTED", ...base },
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant", timestamp },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta: message, timestamp },
    { type: "TEXT_MESSAGE_END", messageId, timestamp },
    { type: "RUN_FINISHED", ...base },
  ];

  const body = new Readable({ read() {} });
  for (const frame of frames) {
    body.push(Buffer.from(`data: ${JSON.stringify(frame)}\n\n`));
  }
  body.push(null);
  ctx.body = body;
}

/**
 * Streams an assistant answer as AG-UI over SSE, with optional turn storage.
 *
 * The response is an AG-UI wrap around the provider's stream, **not** a
 * transparent proxy. TanStack re-frames the provider's chunks as `data:`
 * AG-UI events and appends its own terminal `RUN_FINISHED`, so byte-identity
 * with the provider's wire format is deliberately **RETIRED** as a guarantee:
 * a wrapping transport cannot reproduce the provider's bytes, and no consumer
 * may depend on them. A stateless request (`messages` with no `sessionId`)
 * returns this same AG-UI stream and stores nothing.
 */
router.post(
  "ai.chat",
  auth({ type: [AuthenticationType.APP] }),
  rateLimiter(RateLimiterStrategy.TenPerMinute),
  validate(T.AiChatSchema),
  async (ctx: APIContext<T.AiChatSchemaReq>) => {
    const { user } = ctx.state.auth;
    assertAiChatEnabled(user);

    const { messages } = ctx.input.body;
    // A TanStack client addresses a continued conversation by its AG-UI
    // `threadId`, a legacy RPC caller by `sessionId`. Both name the same stored
    // session, so the alias is resolved exactly once here: every downstream
    // read – the ownership lookup, the lock key, the persistence middleware and
    // the `threadId` handed to `chat()` – then uses this one value. Absent both,
    // the request is stateless and stores nothing.
    const sessionId = ctx.input.body.sessionId ?? ctx.input.body.threadId;
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
        refuseWithAgUiRun({
          ctx,
          message: t(
            "Another answer for this conversation is still being generated"
          ),
          kind: "busy",
          runId,
          sessionId: ownedSession?.id,
        });
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

    // Every write on this path delegates to `appendTurn`, which opens and
    // commits its own short-lived transaction: `aiChatMessageCreator` never
    // reads or replaces `ctx.state.transaction`, and `ai.chat` carries no
    // `transaction()` middleware, so there is none to hold open. That is
    // deliberate and load-bearing — the assistant flush runs after the stream
    // has ended, long after this handler returned, so a transaction opened here
    // would have to stay open across the entire SSE stream.

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
      const pendingContent = messageText(pendingTurn);
      await appendTurn({
        user,
        sessionId: ownedSession?.id,
        role: AIChatMessageRole.User,
        content: pendingContent,
        status: AIChatMessageStatus.Completed,
        runId,
        ctx,
        requestId,
      });
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
    // as a synthetic AG-UI run whose `X-AI-Chat-Kind` header is `refusal` (see
    // `refuseWithAgUiRun`) so the panel renders it as an ordinary transcript
    // turn rather than an error.
    //
    // Skipped entirely when `AI_CHAT_GROUNDING` is off: a provider that is itself
    // a retrieval agent enforces the boundary, and the local lexical probe would
    // only refuse prompts that corpus cannot lexically match.
    const ungroundedReason = env.AI_CHAT_GROUNDING
      ? await findUngroundedReason(user, resolvedMessages)
      : undefined;
    if (ungroundedReason) {
      Logger.warn("AI chat prompt rejected as ungrounded", {
        requestId,
        reason: ungroundedReason,
      });
      // Inlined, not `OutOfScopeRefusal`: i18next-parser sees string literals
      // only. ai.test.ts fails if these two ever differ. The literal must stay
      // contiguous in source, so it is bound here rather than split across the
      // call's named arguments.
      //
      // Stored before the frame is written, so a client that reacts to the
      // refusal by reloading history already finds the row. The string is
      // **locale-frozen at send time**: it is never re-translated on read, so
      // reopening the session replays the text the sender received rather than a
      // later translation of a key. Storing the `OutOfScopeRefusal` constant
      // instead would let the row drift away from the wire on any future change
      // to either one.
      const refusal = t("This assistant only answers from this workspace’s knowledge base");

      await appendTurn({
        user,
        sessionId: ownedSession?.id,
        role: AIChatMessageRole.Assistant,
        content: refusal,
        status: AIChatMessageStatus.Completed,
        runId,
        ctx,
        requestId,
      });

      refuseWithAgUiRun({
        ctx,
        message: refusal,
        kind: "refusal",
        runId,
        sessionId: ownedSession?.id,
      });

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
    // The abort surfaces as the chat middleware's `onAbort` terminal hook.
    const ac = new AbortController();
    ctx.res.on("close", () => {
      if (!ctx.res.writableEnded) {
        ac.abort();
      }
    });

    // SECURITY: threadId from server-owned sessionId, runId server-minted.
    // Tools are the server's own frozen allowlist – the request body is never
    // read for tools and `forwardedProps` is never spread into `chat()`.
    // Client-supplied tools/forwardedProps/state/resume are ignored.
    const [
      { chat, chatParamsFromRequestBody, toServerSentEventsResponse },
      serverTools,
    ] = await Promise.all([loadTanstack(), loadServerTools()]);

    // ponytail: chatParamsFromRequestBody validates the AG-UI shape. For a
    // legacy `{ role, content }` body it throws; the zod schema already
    // validated the body, so we proceed rather than reject.
    try {
      await chatParamsFromRequestBody(ctx.request.body);
    } catch {
      // Legacy body shape; the zod schema already validated it.
    }

    // Terminal persistence and lock release ride TanStack's own terminal hooks:
    // each is awaited before the stream closes, so a row is written and the key
    // freed on every exit (finish, abort, error).
    const persistenceMiddleware = createPersistenceMiddleware({
      user,
      sessionId: ownedSession?.id,
      runId,
      ctx,
      requestId,
      releaseInFlightLock,
    });

    let response: Response;
    try {
      const adapter = await createAiChatAdapter();
      // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- AiChatAdapter is a structurally-compatible subtype of AnyTextAdapter; the adapter type is a union that TanStack's generic parameters reject at compile time but accept at runtime.
      const stream = chat({
        adapter: adapter as unknown as Parameters<typeof chat>[0]["adapter"],
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- UpstreamMessage is a valid ModelMessage at runtime; TanStack's generic type parameter is too strict for the schema-inferred shape.
        messages: resolvedMessages as unknown as Parameters<typeof chat>[0]["messages"],
        threadId: sessionId,
        runId,
        // The allowlist is static and read-only. It is the only source of
        // tools on this path; the request body contributes none.
        tools: serverTools,
        // Server tools receive the requesting user through this context, so
        // no tool closes over a request-scoped value.
        context: { user },
        // REASONING: an operator decision (`AI_CHAT_REASONING`), never the
        // request body. The installed `openaiCompatibleText` adapter never
        // maps `chat({ reasoning })` onto the wire — its base
        // `modelReasoning()` default is `undefined`, and the compatible
        // adapter does not override it — so `reasoning_effort` is placed in
        // the provider-native `modelOptions`, which the adapter spreads into
        // the Chat Completions body verbatim. Unconfigured, the key is
        // omitted entirely and the body carries no reasoning field, so a
        // plain gateway is not sent an unsupported parameter.
        ...(env.AI_CHAT_REASONING
          ? {
              modelOptions: {
                reasoning_effort: env.AI_CHAT_REASONING,
              },
            }
          : {}),
        abortController: ac,
        // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- TanStack's middleware generic defaults to `undefined`; a middleware array is accepted at runtime.
        middleware: [persistenceMiddleware] as unknown as Parameters<
          typeof chat
        >[0]["middleware"],
      });
      // The adapter surfaces the provider's raw error text inside RUN_ERROR;
      // replace it with a generic message so the wire never leaks upstream
      // detail. The real cause is logged by the middleware's onError.
      const sanitized = (async function* () {
        for await (const chunk of stream) {
          if (chunk.type === "RUN_ERROR") {
            yield {
              ...chunk,
              message: "The AI chat stream failed",
              code: undefined,
            };
          } else {
            yield chunk;
          }
        }
      })();
      response = toServerSentEventsResponse(sanitized, { abortController: ac });
    } catch (err) {
      await releaseInFlightLock();
      if (typeof (err as { status?: unknown }).status === "number") {
        throw err;
      }
      throw ProviderUnavailableError();
    }

    ctx.status = response.status;
    response.headers.forEach((value, key) => {
      ctx.set(key, value);
    });
    ctx.set("X-Accel-Buffering", "no");
    ctx.compress = false;
    ctx.req.setTimeout(0);
    // oxlint-disable-next-line @typescript-eslint/consistent-type-assertions -- Node's ReadableStream generic is incompatible with Readable.fromWeb; the runtime type is correct.
    ctx.body = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
  }
);

export default router;
