#!/usr/bin/env node
/**
 * QA-only OpenAI-compatible Chat Completions SSE stub.
 *
 * Run with `node server/test/stub-openai-sse.mjs` from the worktree root. It is
 * test infrastructure: no dependencies, no auth, no persistence, and nothing
 * under `app/` or `server/` imports it.
 *
 * Variant selection is by request-body marker substring:
 * - `canary`   echoes the last user message back.
 * - `refusal`  empty content, finishes with `finish_reason: "stop"`.
 * - `budget`   a tiny completion sequence for forced-ceiling tests.
 * - `tool-fail` emits one tool_call delta, then a mid-stream error frame.
 *
 * A terminal `usage` chunk is sent only when the request body sets
 * `stream_options: { include_usage: true }`, mirroring real providers.
 * A request header `x-stub-status: 503` answers 503 with no SSE body.
 *
 * Binds 127.0.0.1 only, default port 9099 (override with STUB_PORT).
 */
import http from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.STUB_PORT ?? 9099);

/**
 * Pick the stream variant from the raw request body.
 *
 * @param {string} raw the raw request body.
 * @returns {"canary"|"refusal"|"budget"|"tool-fail"} the matching variant.
 */
function pickVariant(raw) {
  if (raw.includes("tool-fail")) {
    return "tool-fail";
  }
  if (raw.includes("refusal")) {
    return "refusal";
  }
  if (raw.includes("budget")) {
    return "budget";
  }
  if (raw.includes("canary")) {
    return "canary";
  }
  return "canary";
}

/**
 * Extract the last textual user message from the request body.
 *
 * @param {unknown} body parsed request body.
 * @returns {string} the user prompt, or an empty string.
 */
function lastUserContent(body) {
  const messages = body && typeof body === "object" ? body.messages : undefined;
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message &&
      message.role === "user" &&
      typeof message.content === "string"
    ) {
      return message.content;
    }
  }
  return "";
}

/**
 * Write one SSE data frame.
 *
 * @param {import("node:http").ServerResponse} res the response.
 * @param {unknown} payload JSON-serializable payload.
 * @returns {void}
 */
function frame(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Handle one Chat Completions request.
 *
 * @param {import("node:http").IncomingMessage} req the request.
 * @param {import("node:http").ServerResponse} res the response.
 * @returns {void}
 */
function handle(req, res) {
  if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found", type: "stub" } }));
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }

    const forcedStatus = Number(req.headers["x-stub-status"]);
    if (Number.isInteger(forcedStatus) && forcedStatus >= 400) {
      res.writeHead(forcedStatus);
      res.end();
      return;
    }

    const variant = pickVariant(raw);
    const includeUsage = body.stream_options?.include_usage === true;
    const model = typeof body.model === "string" ? body.model : "stub";
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-stub-${created}`;
    const promptTokens = Math.max(1, lastUserContent(body).length);
    let completionTokens = 0;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    if (variant === "canary") {
      const content = lastUserContent(body);
      completionTokens = content.length;
      frame(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content },
            finish_reason: null,
          },
        ],
      });
      frame(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
    } else if (variant === "refusal") {
      completionTokens = 0;
      frame(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          { index: 0, delta: { role: "assistant" }, finish_reason: null },
        ],
      });
      frame(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
    } else if (variant === "budget") {
      completionTokens = 3;
      for (const content of ["one ", "two ", "three "]) {
        frame(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content },
              finish_reason: null,
            },
          ],
        });
      }
      frame(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
    } else {
      frame(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_stub_1",
                  type: "function",
                  function: {
                    name: "search_knowledge_base",
                    arguments: '{"query":"marker:tool-fail"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      frame(res, {
        error: {
          message: "stub tool failure",
          type: "server_error",
          code: "tool_fail",
        },
      });
      res.end();
      process.stdout.write(`[stub] ${variant}\n`);
      return;
    }

    if (includeUsage) {
      frame(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    }

    res.write("data: [DONE]\n\n");
    res.end();
    process.stdout.write(`[stub] ${variant} usage=${includeUsage}\n`);
  });
}

const server = http.createServer(handle);
server.listen(PORT, HOST, () => {
  process.stdout.write(
    `[stub] listening http://${HOST}:${PORT} pid=${process.pid}\n`
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
