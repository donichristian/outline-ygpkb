import type * as TanstackAIModule from "@tanstack/ai";
import type { Filter } from "@shared/helpers/FilterHelper";
import { z } from "zod";
import type { User } from "@server/models";
import SearchProviderManager from "@server/utils/SearchProviderManager";
import { loadTanstack } from "./tanstack";

/** The `@tanstack/ai` module namespace. */
type TanstackAI = typeof TanstackAIModule;

/**
 * The runtime context `ai.chat` threads into every server tool. Tools are
 * static, so the requesting user reaches them here rather than through a
 * closure – a per-request tool array would be a client-settable allowlist in
 * disguise.
 */
export type ServerToolContext = {
  /** The requesting user, whose access bounds every read the tool performs. */
  user: User;
};

/** How many documents one tool call returns, keeping the provider context small. */
const MaxToolResults = 5;

/**
 * Archived documents are not readable in the assistant, so they are excluded
 * from results rather than offered as anchors the model cannot open.
 */
const ArchivedFilter: Filter = { field: "archivedAt", operator: "isNull" };

/**
 * Builds the read-only server tool allowlist. Every tool here is executed on
 * the server and can only read the requesting user's own documents.
 *
 * `toolDefinition` is taken as an argument rather than imported so the caller
 * can load it through {@link loadTanstack}: `@tanstack/ai` is ESM-only and the
 * server build emits CommonJS, so a static import would not compile.
 *
 * @param toolDefinition the `toolDefinition` builder from `@tanstack/ai`.
 * @returns the frozen allowlist handed to `chat({ tools })`.
 */
function buildServerTools(toolDefinition: TanstackAI["toolDefinition"]) {
  const searchWorkspace = toolDefinition({
    name: "search_workspace",
    description:
      "Search this workspace’s knowledge base for documents relevant to a query. Returns document titles, links, and matching snippets. Read-only; results are limited to documents the requesting user can already read.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(800)
        .describe("Keywords describing the topic to look up."),
    }),
    outputSchema: z.object({
      total: z.number().describe("How many documents matched in total."),
      results: z.array(
        z.object({
          documentId: z.string(),
          title: z.string(),
          url: z.string(),
          context: z.string().optional(),
        })
      ),
    }),
  }).server<ServerToolContext>(async ({ query }, context) => {
    // Authorization is the search provider's own: `searchForUser` narrows
    // results to documents the user can read, so a query cannot surface a
    // document from a collection the requester cannot access.
    const { total, results } = await SearchProviderManager.getProvider()
      .searchForUser(context.context.user, {
        query,
        filter: ArchivedFilter,
        offset: 0,
        limit: MaxToolResults,
      });

    return {
      total,
      results: results.map(({ document, context: snippet }) => ({
        documentId: document.id,
        title: document.title,
        url: document.url,
        context: snippet,
      })),
    };
  });

  return Object.freeze([searchWorkspace]);
}

/** The frozen allowlist produced by {@link buildServerTools}. */
type BuiltServerTools = ReturnType<typeof buildServerTools>;

let serverToolsPromise: Promise<BuiltServerTools> | undefined;

/**
 * Loads the server tool allowlist once and caches the promise. The array is
 * frozen: the route passes it to `chat({ tools })` as-is and never merges
 * client-supplied tools into it.
 *
 * @returns the frozen, read-only server tool array.
 */
export function loadServerTools(): Promise<BuiltServerTools> {
  serverToolsPromise ??= loadTanstack().then(({ toolDefinition }) =>
    buildServerTools(toolDefinition)
  );
  return serverToolsPromise;
}
