import { NotFoundError } from "@server/errors";
import type * as TanstackAIModule from "@tanstack/ai";
import type { Filter } from "@shared/helpers/FilterHelper";
import { z } from "zod";
import {
  loadDocumentForRead,
  MAX_CHUNK_LIMIT,
  readDocumentBody,
} from "@server/commands/documentReader";
import type { Document, User } from "@server/models";
import { SearchQuery } from "@server/models";
import { SearchQuerySource } from "@server/models/SearchQuery";
import {
  authorizeFilterFields,
  combineFilters,
} from "@server/models/helpers/Filters";
import SearchProviderManager from "@server/utils/SearchProviderManager";
import { loadTanstack } from "./tanstack";

/** The `@tanstack/ai` module namespace. */
type TanstackAI = typeof TanstackAIModule;

/** Tool message the model receives once the turn's tool budget is spent. */
export const ToolBudgetExhausted = "tool_budget_exhausted";

/** Default number of server tool calls one turn may execute. */
export const DefaultMaxToolCalls = 12;

/** Documented maximum for `AI_CHAT_MAX_TOOL_CALLS`. */
export const MaxToolCalls = 40;

/**
 * One shared per-turn tool-call counter. Every server tool claims against the
 * same instance, so the cap spans the whole turn rather than one tool.
 */
export interface ToolCallBudget {
  /**
   * Counts one invocation before it executes.
   *
   * @return true when this call is within the turn's cap.
   */
  claim(): boolean;
}

/**
 * Creates the counter shared by every tool call of one turn.
 *
 * @param maxToolCalls the turn's cap, inclusive.
 * @return the counter handed to the tools through the chat context.
 */
export function createToolCallBudget(maxToolCalls: number): ToolCallBudget {
  let calls = 0;

  return {
    claim() {
      calls += 1;
      return calls <= maxToolCalls;
    },
  };
}

/**
 * Resolves the operator cap for `AI_CHAT_MAX_TOOL_CALLS`. An unset or
 * non-numeric value falls back to the documented default; values above the
 * documented maximum are clamped, so the turn stays bounded either way.
 *
 * @param maxToolCalls the raw configured value, if any.
 * @return the cap to enforce for one turn.
 */
export function resolveToolCallCap(
  maxToolCalls: number | undefined
): number {
  if (
    maxToolCalls === undefined ||
    !Number.isFinite(maxToolCalls) ||
    maxToolCalls < 1
  ) {
    return DefaultMaxToolCalls;
  }

  return Math.min(Math.trunc(maxToolCalls), MaxToolCalls);
}

/**
 * Counts a call before it executes and refuses it once the turn's cap is
 * exceeded. Throwing keeps the refusal inside the existing tool-error path, so
 * the model receives `{ error: "tool_budget_exhausted" }` and nothing runs.
 *
 * @param context the per-turn tool context.
 * @throws when the turn's tool budget is already spent.
 */
function assertToolBudget(context: ServerToolContext): void {
  if (context.toolBudget && !context.toolBudget.claim()) {
    throw new Error(ToolBudgetExhausted);
  }
}

/**
 * The runtime context `ai.chat` threads into every server tool. Tools are
 * static, so the requesting user reaches them here rather than through a
 * closure – a per-request tool array would be a client-settable allowlist in
 * disguise.
 */
export type ServerToolContext = {
  /** The requesting user, whose access bounds every read the tool performs. */
  user: User;
  /** A document bound server-side by an explicit reference on the request. */
  boundDocumentId?: string;
  /** The one counter shared by every tool call of this turn, when enforced. */
  toolBudget?: ToolCallBudget;
};

/** How many documents one tool call returns, keeping the provider context small. */
const MaxToolResults = 5;

/**
 * Resolves an optional document reference supplied on the AI chat request
 * before any model call. The load goes through the shared document loader so
 * the member's own permissions decide whether the reference resolves at all:
 * an unreadable document raises `AuthorizationError`, an archived or
 * soft-deleted document raises `NotFoundError`. A missing or unresolved
 * reference resolves to `undefined`, and the request continues exactly as it
 * does today.
 *
 * @param documentId the document reference from the request body, if any.
 * @param user the requesting user, whose access bounds the load.
 * @return the loaded, authorized, readable document id, or undefined.
 */
export async function resolveDocumentReference(
  documentId: string | undefined,
  user: User
): Promise<string | undefined> {
  if (!documentId) {
    return undefined;
  }

  let document: Document;
  try {
    document = await loadDocumentForRead(documentId, user);
  } catch (err) {
    // A reference that does not resolve is not an error: the request
    // continues exactly as it does today, without a bound document.
    if ((err as { status?: number })?.status === 404) {
      return undefined;
    }
    throw err;
  }

  // The loader authorizes `restore` for a trashed row and the read policy
  // does not exclude archived rows, so both conditions are checked here
  // explicitly: the reference is evidence of a document the member may read,
  // and an archived or soft-deleted document is not readable.
  if (document.archivedAt || document.deletedAt) {
    throw NotFoundError();
  }

  return document.id;
}

/**
 * Archived documents are not readable in the assistant, so they are excluded
 * from results rather than offered as anchors the model cannot open.
 */
const ArchivedFilter: Filter = { field: "archivedAt", operator: "isNull" };

/** Maximum number of results a caller can request from the search tool. */
const MaxToolResultsBound = 10;

/**
 * Refuses a document whose body must not reach the assistant. The loader
 * authorizes `restore` for a trashed row and the read policy does not refuse
 * archived rows, so this is the one place both conditions become a tool
 * error instead of body text. Shared so the bound and unbound paths cannot
 * drift.
 *
 * @param document the loaded, authorized document.
 * @throws when the document is archived or trashed.
 */
function assertDocumentReadable(document: Document): void {
  if (document.archivedAt) {
    throw new Error(`Document ${document.id} is archived and cannot be read.`);
  }

  if (document.deletedAt) {
    throw new Error(
      `Document ${document.id} has been deleted and cannot be read.`
    );
  }
}

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
      collectionId: z
        .string()
        .optional()
        .describe("Restrict results to a specific collection."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of results to return."),
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
  }).server<ServerToolContext>(async ({ query, collectionId, limit }, context) => {
    assertToolBudget(context.context);
    const user = context.context.user;
    const requestedLimit =
      typeof limit === "number" ? Math.min(limit, MaxToolResultsBound) : MaxToolResults;
    const collectionFilter: Filter | undefined = collectionId
      ? { field: "collectionId", operator: "eq", value: collectionId }
      : undefined;

    const filter = combineFilters(
      collectionFilter ? [collectionFilter, ArchivedFilter] : [ArchivedFilter]
    );

    if (collectionFilter) {
      await authorizeFilterFields(user, collectionFilter);
    }

    // Authorization is the search provider's own: `searchForUser` narrows
    // results to documents the user can read, so a query cannot surface a
    // document from a collection the requester cannot access.
    const startedAt = Date.now();
    const { total, results } =
      await SearchProviderManager.getProvider().searchForUser(user, {
        query,
        filter,
        offset: 0,
        limit: requestedLimit,
        usePopularityBoost: false,
      });
    const duration = Date.now() - startedAt;

    await SearchQuery.record({
      userId: context.context.user.id,
      teamId: context.context.user.teamId,
      source: SearchQuerySource.Ai,
      query,
      results: total,
      duration,
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

  const recommendDocuments = toolDefinition({
    name: "recommend_documents",
    description:
      "Recommend documents from this workspace’s knowledge base for a topic. Returns relevance-ranked candidates with an explicit reason (matching excerpt) and a link. Read-only; results are limited to documents the requesting user can already read.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(800)
        .describe("Topic or question to recommend documents for."),
      collectionId: z
        .string()
        .optional()
        .describe("Restrict recommendations to a specific collection."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of results to return."),
    }),
    outputSchema: z.object({
      total: z.number().describe("How many documents matched in total."),
      results: z.array(
        z.object({
          documentId: z.string(),
          title: z.string(),
          url: z.string(),
          reason: z.string(),
        })
      ),
    }),
  }).server<ServerToolContext>(async ({ query, collectionId, limit }, context) => {
    assertToolBudget(context.context);
    const user = context.context.user;
    const requestedLimit =
      typeof limit === "number" ? Math.min(limit, MaxToolResultsBound) : MaxToolResults;
    const collectionFilter: Filter | undefined = collectionId
      ? { field: "collectionId", operator: "eq", value: collectionId }
      : undefined;

    const filter = combineFilters(
      collectionFilter ? [collectionFilter, ArchivedFilter] : [ArchivedFilter]
    );

    if (collectionFilter) {
      await authorizeFilterFields(user, collectionFilter);
    }

    // Authorization is the search provider's own: `searchForUser` narrows
    // results to documents the user can read, so a query cannot surface a
    // document from a collection the requester cannot access.
    const startedAt = Date.now();
    const { total, results } =
      await SearchProviderManager.getProvider().searchForUser(user, {
        query,
        filter,
        offset: 0,
        limit: requestedLimit,
        usePopularityBoost: false,
      });
    const duration = Date.now() - startedAt;

    await SearchQuery.record({
      userId: context.context.user.id,
      teamId: context.context.user.teamId,
      source: SearchQuerySource.Ai,
      query,
      results: total,
      duration,
    });

    return {
      total,
      results: results
        .map(({ document, context: snippet }) => ({
          documentId: document.id,
          title: document.title,
          url: document.url,
          reason: snippet ?? "",
        }))
        .filter((result) => result.reason.trim().length > 0),
    };
  });

  const fetchDocument = toolDefinition({
    name: "fetch_document",
    description:
      "Fetch the Markdown body of one document by id or url slug. Use after search_workspace when the answer needs the document’s actual text (summaries, procedures, step lists) rather than a snippet. Optionally return only one heading section. Read-only; authorization is checked against the requesting user.",
    inputSchema: z.object({
      documentId: z
        .string()
        .min(1)
        .optional()
        .describe("Document id or url slug returned by search_workspace."),
      section: z
        .string()
        .min(1)
        .optional()
        .describe("Return only the heading section whose title contains this text, case-insensitively."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Character offset to continue from when a read was truncated."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_CHUNK_LIMIT)
        .optional()
        .describe("Maximum characters to return."),
    }),
    outputSchema: z.object({
      documentId: z.string(),
      title: z.string(),
      url: z.string(),
      markdown: z.string().describe("Document text as Markdown."),
      characters: z.number().describe("Number of characters returned in markdown."),
      truncated: z.boolean().describe("Whether more body text remains after this slice."),
    }),
  }).server<ServerToolContext>(
    async ({ documentId, section, offset, limit }, context) => {
      assertToolBudget(context.context);
      // A server-bound document wins over anything the model passes.
      const requestedId = context.context.boundDocumentId ?? documentId;

      if (!requestedId) {
        throw new Error(
          "No document identifier was supplied. Search the workspace first and pass a documentId."
        );
      }

      const document = await loadDocumentForRead(
        requestedId,
        context.context.user
      );
      assertDocumentReadable(document);

      const { content, paging } = await readDocumentBody(document, {
        section,
        offset,
        limit,
      });

      return {
        documentId: document.id,
        title: document.title,
        url: document.url,
        markdown: content,
        characters: content.length,
        truncated:
          paging !== undefined && "hasMore" in paging && paging.hasMore,
      };
    }
  );

  // ponytail: text-relevance-only ranking; provider's popularity blend is the
  // named opt-in upgrade path.
  return Object.freeze([searchWorkspace, fetchDocument, recommendDocuments]);
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
