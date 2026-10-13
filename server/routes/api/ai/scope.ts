import type { AiChatSchemaReq } from "./schema";

type ChatMessages = AiChatSchemaReq["body"]["messages"];

/**
 * The refusal sent to the browser when a prompt is rejected before any upstream
 * call is made. The English text doubles as its own translation key – `t()`
 * falls back to the key until `yarn build:i18n` extracts it into the locale
 * files.
 */
export const OutOfScopeRefusal =
  "This assistant only answers from this workspace’s knowledge base";

/**
 * Question shapes whose answer lives in a model's parametric memory rather than
 * in any workspace document, so no document retrieval could ground them. These
 * are matched against user messages only – an assistant message that echoed one
 * of these phrases must not permanently lock the conversation.
 *
 * ponytail: pattern matching, not classification. It cannot catch an off-topic
 * question phrased outside these shapes ("tell me about France"), and it does
 * reject a genuine knowledge-base question that happens to share one ("what is
 * the capital of our Jakarta office?"). It is a cheap pre-filter in front of
 * the model, not a boundary on what the model may answer – an unmatched
 * off-topic prompt still reaches the provider, which leaks from memory roughly
 * 40% of the time. Upgrade path: score the prompt against the team's own
 * documents (embeddings, or the existing full-text index) and reject when no
 * document is close, or require the upstream response to cite a `/doc/` URL
 * before any token of it is flushed to the browser. Both stay in this route and
 * cost no extra model call.
 */
const OUT_OF_SCOPE_PROBES = [
  "capital of",
  "capital city of",
  "population of",
  "who is the (?:president|prime minister|king|queen|pope|ceo)",
  "who (?:wrote|painted|composed|invented|discovered|directed)",
  "birthday of",
  "date of birth of",
  "what year is it",
  "recipe for",
  "weather (?:forecast|in)",
  "exchange rate",
  "stock price",
  "(?:tell|give) me a (?:joke|riddle|fun fact)",
  "write (?:me )?(?:an? )?(?:poem|song|haiku|limerick|short story|novel)",
  "how do i (?:say|pronounce)",
  "latest news",
];

/**
 * Normalizes prompt text so the probes cannot be dodged with case, with runs of
 * spaces or tabs, with fullwidth characters (NFKC folds them to ASCII), or with
 * zero-width and soft-hyphen marks that are invisible on screen.
 *
 * @param input the raw message text.
 * @returns the normalized, single-spaced, lowercased text.
 */
function normalize(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Decides whether a conversation is answerable from the workspace knowledge
 * base. Fails open: anything that does not match a known general-knowledge
 * probe shape is passed through to the provider.
 *
 * @param messages the conversation as submitted by the client.
 * @returns the matched probe (or `"empty prompt"`) when the conversation is out
 * of scope, otherwise undefined.
 */
export function findOutOfScopeProbe(
  messages: ChatMessages
): string | undefined {
  const text = normalize(
    messages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join(" ")
  );

  // Whitespace-only input carries no prompt, so there is nothing a workspace
  // document could ground.
  if (!text) {
    return "empty prompt";
  }

  // Two shapes per probe: one tolerant of spacing between words, one matching
  // the probe with all spacing removed so `c a p i t a l   o f` cannot slip past.
  const dense = text.replace(/ /g, "");

  for (const probe of OUT_OF_SCOPE_PROBES) {
    const spaced = new RegExp(probe.replace(/ /g, "\\s+"), "u");
    const compact = new RegExp(probe.replace(/ /g, ""), "u");

    if (spaced.test(text) || compact.test(dense)) {
      return probe;
    }
  }

  return undefined;
}
