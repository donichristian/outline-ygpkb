import type {
  OpenAICompatibleChatAdapter,
  OpenAICompatibleResponsesAdapter,
} from "@tanstack/ai-openai/compatible";
import env from "@server/env";
import { loadOpenaiCompatible } from "./tanstack";

/**
 * The TanStack AI text adapter type produced by {@link createAiChatAdapter}.
 *
 * The gateway is an OpenAI-compatible endpoint, so the adapter is the generic
 * Chat Completions adapter. The library's factory declares a union with the
 * Responses adapter regardless of `api`; {@link createAiChatAdapter} always
 * selects `"chat-completions"`, so only the Chat Completions member is ever
 * returned at runtime.
 */
export type AiChatAdapter =
  | OpenAICompatibleChatAdapter<string>
  | OpenAICompatibleResponsesAdapter<string>;

/**
 * Build the TanStack AI adapter for the configured OpenAI-compatible chat
 * gateway. This is the only place the adapter is constructed.
 *
 * The exact invocation performed here is:
 *
 * ```ts
 * const { openaiCompatibleText } = await loadOpenaiCompatible();
 * openaiCompatibleText(env.AI_CHAT_MODEL, {
 *   api: "chat-completions",
 *   baseURL: env.AI_CHAT_BASE_URL,
 *   apiKey: env.AI_CHAT_API_KEY ?? "not-configured",
 * });
 * ```
 *
 * `api: "chat-completions"` is explicit: the gateway is a pure Chat Completions
 * proxy (`POST ${baseURL}/chat/completions`, `stream:true`), which is what the
 * OpenAI SDK's default path targets. The Responses adapter (`openaiText`) is
 * the wrong endpoint for this gateway. The API key is forwarded to the SDK and
 * is never read back, logged, or returned by this module.
 *
 * The module is loaded through {@link loadOpenaiCompatible} rather than a static
 * import because `@tanstack/ai-openai` publishes only an `import` condition and
 * the server build emits CommonJS; a static import would become a `require()`
 * that Node rejects with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 *
 * @returns A promise of the configured Chat Completions adapter for the gateway.
 * @throws Error when the gateway is not configured (base URL or model unset),
 * before any network call is made.
 */
export async function createAiChatAdapter(): Promise<AiChatAdapter> {
  const baseURL = env.AI_CHAT_BASE_URL;
  const model = env.AI_CHAT_MODEL;

  if (!baseURL || !model) {
    throw new Error("AI chat provider is not configured");
  }

  const { openaiCompatibleText } = await loadOpenaiCompatible();

  return openaiCompatibleText(model, {
    api: "chat-completions",
    baseURL,
    // The SDK requires a non-empty key to construct a client. A keyless gateway
    // receives this placeholder and ignores it; a configured gateway receives
    // the real secret, which stays inside the SDK.
    apiKey: env.AI_CHAT_API_KEY ?? "not-configured",
  });
}
