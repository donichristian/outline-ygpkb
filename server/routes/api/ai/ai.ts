import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { t } from "i18next";
import Router from "koa-router";
import { TeamPreference } from "@shared/types";
import { toError } from "@shared/utils/error";
import env from "@server/env";
import { NotFoundError } from "@server/errors";
import Logger from "@server/logging/Logger";
import auth from "@server/middlewares/authentication";
import { rateLimiter } from "@server/middlewares/rateLimiter";
import validate from "@server/middlewares/validate";
import { AIChatSession } from "@server/models";
import type { User } from "@server/models";
import AIChatMessage, { AIChatMessageRole } from "@server/models/AIChatMessage";
import type { APIContext } from "@server/types";
import { AuthenticationType } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
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

  return (
    pendingTurn ? [...committed, pendingTurn] : committed
  ).slice(-T.AiChatMaxMessages);
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
 * Ends the response with a single in-band `event: error` frame carrying a
 * `kind: "refusal"` discriminator. The event name stays `error` so a browser
 * holding a pre-rename client bundle still reads the payload's `error` field and
 * degrades to the previous banner rather than silently dropping the answer. The
 * `kind` field lets `app/utils/aiChat.ts` raise an `AiChatError` of kind
 * `refusal`, which the panel renders as an ordinary assistant transcript turn –
 * the boundary answering, not a failure – while the browser still receives a
 * well-formed stream rather than a bare error status.
 *
 * @param ctx the request context.
 * @param message the user-facing message to deliver.
 */
function refuseWithSseError(ctx: APIContext, message: string) {
  setSseHeaders(ctx);

  const body = new Readable({ read() {} });
  body.push(Buffer.from(sseFrame({ error: message, kind: "refusal" }, "error")));
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

    // The feature is gated per-workspace and requires a fully configured
    // provider – a base URL *and* a model. A base URL without a model can only
    // produce a broken upstream request, so it is treated as no provider at
    // all. All three conditions return a 404 so the endpoint is
    // indistinguishable from any other unknown route when unavailable.
    if (
      !user.team.getPreference(TeamPreference.AIChat) ||
      !env.AI_CHAT_BASE_URL ||
      !env.AI_CHAT_MODEL
    ) {
      throw NotFoundError();
    }

    const { messages, sessionId } = ctx.input.body;
    const requestId = ctx.get("x-request-id");

    // Resolved once, before any consumer, so the grounding gate and the
    // provider are asked about the same conversation: for a stored session that
    // is the committed window, not the client array. A foreign `sessionId`
    // raises here, before the response is switched to SSE and before the
    // provider is contacted.
    //
    // `pendingTurn` carries the newest client message because it is not
    // persisted yet. When the turn is written, stop passing it – the committed
    // window then already contains it, and passing both would send it twice.
    const resolvedMessages = await resolveUpstreamMessages({
      user,
      ctx,
      sessionId,
      pendingTurn: sessionId ? messages?.at(-1) : undefined,
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
    const ungroundedReason = await findUngroundedReason(
      user,
      resolvedMessages
    );
    if (ungroundedReason) {
      Logger.warn("AI chat prompt rejected as ungrounded", {
        requestId,
        reason: ungroundedReason,
      });
      // Inlined, not `OutOfScopeRefusal`: i18next-parser sees string literals
      // only. ai.test.ts fails if these two ever differ.
      refuseWithSseError(
        ctx,
        t("This assistant only answers from this workspace’s knowledge base")
      );
      return;
    }

    // Abort the upstream request if the client disconnects before the stream
    // has finished, so we do not keep the provider connection open.
    const ac = new AbortController();
    ctx.req.on("close", () => {
      if (!ctx.res.writableEnded) {
        ac.abort();
      }
    });

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

    // The upstream refused the request. Nothing has been written to the client
    // yet, so throw a normal error that the API error handler renders as JSON.
    // The provider's own message is logged only – it can carry prompts, internal
    // hostnames or account identifiers.
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

    setSseHeaders(ctx);

    // Wrap the upstream body so a mid-stream error can be interposed as an
    // in-band SSE frame rather than surfacing as a broken pipe. `body` is the
    // only writer on the socket – koa pipes it into `ctx.res` – so a second
    // writer would interleave and corrupt frames.
    // The global `ReadableStream` comes from the fetch typings while
    // `Readable.fromWeb` wants the `node:stream/web` one – same shape, different
    // declaration, so the cast is unavoidable.
    const upstream = Readable.fromWeb(
      res.body as NodeReadableStream<Uint8Array>
    );
    const body = new Readable({ read() {} });
    let ended = false;

    const end = () => {
      if (ended) {
        return;
      }
      ended = true;
      body.push(null);
    };

    upstream.on("data", (chunk: Buffer) => {
      if (!ended && !ctx.res.writableEnded) {
        body.push(chunk);
      }
    });
    upstream.on("end", end);
    upstream.on("error", (err: Error) => {
      Logger.error("AI chat stream failed", toError(err), { requestId });

      // Pushed even when nothing has flushed yet – `body` buffers until koa
      // pipes it, whereas throwing now would leave the client with a bare 200.
      if (!ended) {
        body.push(
          Buffer.from(sseFrame({ error: "The AI chat stream failed" }, "error"))
        );
      }
      end();
    });

    ctx.body = body;
  }
);

export default router;
