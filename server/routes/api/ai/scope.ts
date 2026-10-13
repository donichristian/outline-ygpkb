import { toError } from "@shared/utils/error";
import type { Filter } from "@shared/helpers/FilterHelper";
import Logger from "@server/logging/Logger";
import type { User } from "@server/models";
import SearchProviderManager from "@server/utils/SearchProviderManager";
import type { AiChatSchemaReq } from "./schema";

type ChatMessages = AiChatSchemaReq["body"]["messages"];

/**
 * The refusal sent to the browser when a prompt is rejected before any upstream
 * call is made. `ai.ts` inlines this text at its `t()` call instead of passing
 * the constant, because i18next-parser extracts string literals only – the two
 * are kept identical by a test rather than by this reference.
 */
export const OutOfScopeRefusal =
  "This assistant only answers from this workspace’s knowledge base";

/**
 * How many terms the retrieval probe searches for. Terms are taken newest-turn
 * first, so this bounds the query built from the conversation rather than the
 * conversation itself.
 */
const MaxProbeTerms = 8;

/**
 * English function words, question words and conversational filler. These carry
 * no topic, so a prompt made only of them names nothing a document could match.
 * The list is deliberately small – Postgres drops its own stop words during
 * `to_tsquery` – and exists to stop the probe widening into "any document that
 * happens to contain the word *the*".
 */
const WeakTerms = new Set(
  `
    a an the and or but nor so yet if then than as
    of in on at to for from by with about into onto over under after before
    between during through per via
    is are was were be been being am do does did done have has had
    can could will would shall should may might must
    i me my mine we us our ours you your yours he him his she her hers
    it its they them their theirs this that these those
    what which who whom whose there here when where why how
    not no yes ok okay please thanks thank hello hi hey
    get got tell show give use used using make made need want know like
    any some all more most much many one two also just very really quite
    thing things stuff something anything everything
  `
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Archived documents are excluded from the probe. The assistant has no way to
 * open one, so an archived-only match would approve the prompt here only for the
 * model to refuse it after paying the upstream latency.
 */
const ProbeFilter: Filter = { field: "archivedAt", operator: "isNull" };

/**
 * Normalizes prompt text for term extraction. Case is folded, invisible marks
 * (zero-width, soft hyphen) are removed so an obfuscated word reassembles,
 * and everything that is not a letter or digit becomes a space so punctuation
 * cannot end up inside a search term.
 *
 * @param input the raw message text.
 * @returns the normalized, single-spaced, lowercased text.
 */
function normalize(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reduces the conversation to the normalized text the probe searches for. Only
 * user messages contribute – an assistant message that echoed a phrase must not
 * lock the conversation – and the newest turn comes first so a follow-up spends
 * the term budget on the current topic.
 *
 * @param messages the conversation as submitted by the client.
 * @returns the normalized prompt, or an empty string when there is nothing to search.
 */
function promptText(messages: ChatMessages): string {
  return messages
    .filter((message) => message.role === "user")
    .reverse()
    .map((message) => normalize(message.content))
    .join(" ")
    .trim();
}

/**
 * Builds the retrieval query from normalized prompt text.
 *
 * `|` is the provider's OR operator, so the probe matches a document that
 * contains *any* of the terms. Left unquoted, `pg-tsquery` would AND the words
 * together instead — a whole question would then demand every word at once and
 * match nothing — while quoting is worse still: the provider lifts quoted
 * fragments out into separate AND-ed clauses and keeps only the first three,
 * turning the probe into a conjunction and silently dropping terms beyond that.
 *
 * Interpolation is safe because normalization leaves letters and digits only,
 * so a term can never carry a `tsquery` operator.
 *
 * @param prompt the normalized prompt text.
 * @returns the query to hand to the search provider, or undefined when no term survives.
 */
function buildProbeQuery(prompt: string): string | undefined {
  const terms: string[] = [];

  for (const word of prompt.split(" ")) {
    // A single character carries no topic, and a repeated term would only
    // widen the OR it already belongs to.
    if (word.length < 2 || WeakTerms.has(word) || terms.includes(word)) {
      continue;
    }

    terms.push(word);

    if (terms.length === MaxProbeTerms) {
      break;
    }
  }

  return terms.length ? terms.join("|") : undefined;
}

/**
 * Decides whether the workspace knowledge base can answer the conversation, by
 * searching the requesting user's own documents for the prompt and requiring at
 * least one accessible hit. Answers nothing locally – it only answers "is there
 * anything to ground an answer in", so a prompt with no retrievable match is
 * refused without the provider ever being contacted.
 *
 * Authorization is the search provider's own: `searchForUser` narrows results to
 * documents the user can read, by membership and by collection access. A prompt
 * whose only match sits in a collection the user cannot read therefore returns
 * nothing and is refused, so prompts cannot be used to probe for inaccessible
 * collections.
 *
 * Fails closed. If retrieval is unavailable the prompt is refused rather than
 * passed through ungrounded.
 *
 * ponytail: a lexical hit is a claim, not a measurement – no false-reject rate
 * has been measured against the live corpus, and a full-text OR both over-matches
 * a document that merely shares a word and under-matches a paraphrase that shares
 * none. Deliberately biased toward refusing, because a refusal is visible and a
 * hallucinated answer is not. Costs one search (two or three indexed queries on
 * the read replica) on a route that previously did no database read. Upgrade path
 * if this proves too blunt: rank with embeddings, or keep the probe and add a
 * post-hoc check that the upstream stream actually cites a `/doc/` URL before any
 * token of it is flushed.
 *
 * @param user the requesting user, whose access bounds the search.
 * @param messages the conversation as submitted by the client.
 * @returns the refusal reason when the prompt cannot be grounded, otherwise undefined.
 */
export async function findUngroundedReason(
  user: User,
  messages: ChatMessages
): Promise<string | undefined> {
  const prompt = promptText(messages);

  if (!prompt) {
    return "empty prompt";
  }

  const query = buildProbeQuery(prompt);

  if (!query) {
    return "no distinctive terms";
  }

  try {
    const { total } = await SearchProviderManager.getProvider().searchForUser(
      user,
      { query, filter: ProbeFilter, offset: 0, limit: 1 }
    );

    return total > 0 ? undefined : "no matching document";
  } catch (err) {
    Logger.error(
      "AI chat grounding search failed",
      toError(err),
      { userId: user.id }
    );
    return "search failed";
  }
}