import type * as TanstackAIModule from "@tanstack/ai";
import type { Filter } from "@shared/helpers/FilterHelper";
import { z } from "zod";
import { NotFoundError } from "@server/errors";
import { Document } from "@server/models";
import type { User } from "@server/models";
import { SearchQuery } from "@server/models";
import { SearchQuerySource } from "@server/models/SearchQuery";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import {
  authorizeFilterFields,
  combineFilters,
} from "@server/models/helpers/Filters";
import { authorize } from "@server/policies";
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
  /** A document bound server-side by an explicit reference on the request. */
  boundDocumentId?: string;
};

/** How many documents one tool call returns, keeping the provider context small. */
const MaxToolResults = 5;

/**
 * Characters of a document one `read_document` call returns. A whole document
 * can exceed the model's context, so the text is truncated and the model is
 * told it was; summary work is expected to page with `offset`.
 */
const MaxDocumentChars = 24000;

/**
 * Archived documents are not readable in the assistant, so they are excluded
 * from results rather than offered as anchors the model cannot open.
 */
const ArchivedFilter: Filter = { field: "archivedAt", operator: "isNull" };

/** Maximum number of results a caller can request from the search tool. */
const MaxToolResultsBound = 10;

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

  const readDocument = toolDefinition({
    name: "read_document",
    description:
      "Read the Markdown content of one document by id. Use after search_workspace when the answer needs the document’s actual text (summaries, procedures, step lists) rather than a snippet. Read-only; authorization is checked against the requesting user.",
    inputSchema: z.object({
      documentId: z.string().uuid().describe("Id returned by search_workspace."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Character offset to continue from when a read was truncated."),
    }),
    outputSchema: z.object({
      documentId: z.string(),
      title: z.string(),
      url: z.string(),
      markdown: z.string().describe("Document text as Markdown."),
      offset: z.number().describe("Offset this slice starts at."),
      truncated: z.boolean().describe("Whether more text remains after this slice."),
    }),
  }).server<ServerToolContext>(async ({ documentId, offset = 0 }, context) => {
    // Passing the user id applies the membership preload the read policy
    // asserts on, so a non-admin read can be authorized without a second query.
    const document = await Document.findByPk(documentId, {
      userId: context.context.user.id,
      paranoid: false,
      rejectOnEmpty: false,
    });
    if (!document) {
      throw NotFoundError();
    }

    // Read access is the user's, not the workspace's: a guessed id must not
    // read a document the requester cannot open.
    authorize(context.context.user, "read", document);

    const text = await DocumentHelper.toMarkdown(document, {
      includeTitle: false,
      commonMark: true,
      teamId: document.teamId,
    });
    const slice = text.slice(offset, offset + MaxDocumentChars);

    return {
      documentId: document.id,
      title: document.title,
      url: document.url,
      markdown: slice,
      offset,
      truncated: offset + slice.length < text.length,
    };
  });

  // ponytail: text-relevance-only ranking; provider's popularity blend is the
  // named opt-in upgrade path.
  return Object.freeze([searchWorkspace, recommendDocuments, readDocument]);
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
