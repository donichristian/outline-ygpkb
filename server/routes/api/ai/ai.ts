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
import type { APIContext } from "@server/types";
import { AuthenticationType } from "@server/types";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";
import { findUngroundedReason, OutOfScopeRefusal } from "./scope";
import * as T from "./schema";

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
 * Ends the response with a single in-band `event: error` frame. This is the
 * same channel a mid-stream provider failure uses, so `app/utils/aiChat.ts`
 * raises an `AiChatError` of kind `stream` and the panel renders the message as
 * ordinary text – no client change, and the browser still receives a well-formed
 * stream rather than a bare error status.
 *
 * @param ctx the request context.
 * @param message the user-facing message to deliver.
 */
function refuseWithSseError(ctx: APIContext, message: string) {
  setSseHeaders(ctx);

  const body = new Readable({ read() {} });
  body.push(Buffer.from(sseFrame({ error: message }, "error")));
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

    // The feature is gated per-workspace and requires a configured provider.
    // Both conditions return a 404 so the endpoint is indistinguishable from
    // any other unknown route when unavailable.
    if (
      !user.team.getPreference(TeamPreference.AIChat) ||
      !env.AI_CHAT_BASE_URL
    ) {
      throw NotFoundError();
    }

    const { messages } = ctx.input.body;
    const requestId = ctx.get("x-request-id");

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
    // costs no upstream call or latency on a refusal.
    const ungroundedReason = await findUngroundedReason(user, messages);
    if (ungroundedReason) {
      Logger.warn("AI chat prompt rejected as ungrounded", {
        requestId,
        reason: ungroundedReason,
      });
      refuseWithSseError(ctx, t(OutOfScopeRefusal));
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
        messages,
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
