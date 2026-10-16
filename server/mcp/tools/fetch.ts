import { z } from "zod";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  Attachment,
  Collection,
  Document,
  Template,
  User,
} from "@server/models";
import { authorize, can } from "@server/policies";
import { AuthorizationError, ValidationError } from "@server/errors";
import { presentNavigationNode, presentUser } from "@server/presenters";
import AuthenticationHelper from "@shared/helpers/AuthenticationHelper";
import { presentCollection } from "./collections";
import { presentDocument } from "./documents";
import { presentTemplate } from "./templates";
import {
  error,
  success,
  getActorFromContext,
  getDocumentBreadcrumb,
  getPublicShareUrlForCollection,
  getPublicShareUrlForDocument,
  pathToUrl,
  withTracing,
} from "../util";

const SELF_TOKENS = new Set(["self", "me", "current_user"]);

/** Default characters returned for a document body when none is requested. */
const DEFAULT_CHUNK_LIMIT = 20000;

/** Maximum characters a single fetch may return, to bound tool output. */
const MAX_CHUNK_LIMIT = 60000;

/**
 * Extracts the ATX/fenced heading lines from markdown, used to locate a section.
 *
 * @param markdown - the markdown body.
 * @returns an array of `{ level, title, index }` ordered as they appear.
 */
function findHeadings(markdown: string) {
  const headings: { level: number; title: string; index: number }[] = [];
  const lines = markdown.split("\n");
  let offset = 0;

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (match) {
      headings.push({
        level: match[1].length,
        title: match[2].trim(),
        index: offset,
      });
    }
    offset += line.length + 1;
  }

  return headings;
}

/**
 * Slices out a section of markdown from a heading down to the next heading of
 * the same or higher level, so a subsection is returned whole.
 *
 * @param markdown - the markdown body.
 * @param query - heading text to locate (case-insensitive substring).
 * @returns the section text, or undefined when no heading matches.
 */
function extractSection(markdown: string, query: string) {
  const headings = findHeadings(markdown);
  const needle = query.toLowerCase();
  const index = headings.findIndex((heading) =>
    heading.title.toLowerCase().includes(needle)
  );

  if (index === -1) {
    return undefined;
  }

  const { level, index: start } = headings[index];
  const next = headings
    .slice(index + 1)
    .find((heading) => heading.level <= level);
  const end = next ? next.index : markdown.length;

  return markdown.slice(start, end).trim();
}

/**
 * Applies offset/limit paging to a document body.
 *
 * @param text - the full markdown body.
 * @param offset - starting character offset.
 * @param limit - maximum characters to return.
 * @returns the chunk plus paging metadata for the caller to surface.
 */
function chunkText(text: string, offset: number, limit: number) {
  const total = text.length;
  const start = Math.max(0, Math.min(offset, total));
  const end = Math.min(total, start + limit);

  return {
    chunk: text.slice(start, end),
    total,
    start,
    end,
    hasMore: end < total,
  };
}

/**
 * Extracts a resource identifier from a value that may be a URL or a plain ID.
 * When a URL is detected the last non-empty path segment is returned as the
 * slug, which the model's findByPk override can resolve.
 *
 * @param value - a URL string or plain identifier.
 * @returns the extracted identifier.
 */
function extractId(value: string): string {
  if (/^https?:\/\//.test(value)) {
    try {
      const url = new URL(value);
      const queryId = url.searchParams.get("id");
      if (queryId) {
        return queryId;
      }
      const segments = url.pathname.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? value;
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Registers the unified "fetch" MCP tool on the given server. The tool is
 * only registered when at least one of the underlying info scopes is granted.
 *
 * @param server - the MCP server instance to register on.
 * @param scopes - the OAuth scopes granted to the access token.
 */
export function fetchTool(server: McpServer, scopes: string[]) {
  const canReadDocuments = AuthenticationHelper.canAccess(
    "documents.info",
    scopes
  );
  const canReadCollections = AuthenticationHelper.canAccess(
    "collections.info",
    scopes
  );
  const canReadUsers = AuthenticationHelper.canAccess("users.info", scopes);
  const canReadAttachments = AuthenticationHelper.canAccess(
    "attachments.info",
    scopes
  );
  const canReadTemplates = AuthenticationHelper.canAccess(
    "templates.info",
    scopes
  );

  if (
    !canReadDocuments &&
    !canReadCollections &&
    !canReadUsers &&
    !canReadAttachments &&
    !canReadTemplates
  ) {
    return;
  }

  const allowedTypes = [
    ...(canReadDocuments ? ["document"] : []),
    ...(canReadCollections ? ["collection"] : []),
    ...(canReadUsers ? ["user"] : []),
    ...(canReadAttachments ? ["attachment"] : []),
    ...(canReadTemplates ? ["template"] : []),
  ] as [string, ...string[]];

  server.registerTool(
    "fetch",
    {
      title: "Fetch",
      description:
        'Fetches a document, collection, user, attachment, or template by type and ID. When fetching a collection the response includes the full hierarchical document tree. For users, "current_user" can be used as the ID to get the authenticated user. For attachments, the response includes a short-lived signed URL that can be used to download the file contents directly. For templates, the response includes the template body as markdown. For long documents, prefer `section` to read a single heading, or `offset`/`limit` to page through the body; large bodies are chunked and the metadata block reports `paging` with `total` and `hasMore`.',
      annotations: {
        idempotentHint: true,
        readOnlyHint: true,
      },
      inputSchema: {
        resource: z.enum(allowedTypes).describe("The resource to fetch."),
        id: z
          .string()
          .describe(
            'The unique identifier or URL. For users, "current_user" returns the authenticated user.'
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Documents only. Character offset to start reading the body from. Use with `hasMore` from a previous response to read the next chunk of a long document."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_CHUNK_LIMIT)
          .optional()
          .describe(
            `Documents only. Maximum characters of the body to return (default ${DEFAULT_CHUNK_LIMIT}, max ${MAX_CHUNK_LIMIT}). Large documents are returned in chunks.`
          ),
        section: z
          .string()
          .optional()
          .describe(
            "Documents only. Return only the section whose heading contains this text (case-insensitive), from that heading down to the next heading of the same or higher level. Use for long structured documents instead of paging through the whole body."
          ),
      },
    },
    withTracing(
      "fetch",
      async ({ resource, id: rawId, offset, limit, section }, extra) => {
      try {
        const actor = getActorFromContext(extra);
        const id = extractId(rawId);

        switch (resource) {
          case "document": {
            const document = await Document.findByPk(id, {
              userId: actor.id,
              rejectOnEmpty: true,
            });

            authorize(actor, "read", document);

            const [{ text, ...attributes }, breadcrumb, shareUrl] =
              await Promise.all([
                presentDocument(document, {
                  includeData: false,
                  includeText: true,
                  includeUpdatedAt: true,
                  includeCommentCount: true,
                }),
                getDocumentBreadcrumb(document, actor),
                getPublicShareUrlForDocument(actor.team, document.id),
              ]);

            const body = typeof text === "string" ? text : "";
            let content = body;
            let paging: Record<string, unknown> | undefined;

            if (section) {
              const found = extractSection(body, section);
              if (found === undefined) {
                return error(
                  ValidationError(
                    `No section heading matching "${section}" was found in the document.`
                  )
                );
              }
              content = found;
              paging = { section };
            } else if (offset !== undefined || limit !== undefined) {
              const chunk = chunkText(
                body,
                offset ?? 0,
                Math.min(limit ?? DEFAULT_CHUNK_LIMIT, MAX_CHUNK_LIMIT)
              );
              content = chunk.chunk;
              paging = {
                start: chunk.start,
                end: chunk.end,
                total: chunk.total,
                hasMore: chunk.hasMore,
              };
            } else if (body.length > DEFAULT_CHUNK_LIMIT) {
              const chunk = chunkText(body, 0, DEFAULT_CHUNK_LIMIT);
              content = chunk.chunk;
              paging = {
                start: chunk.start,
                end: chunk.end,
                total: chunk.total,
                hasMore: chunk.hasMore,
              };
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    document: pathToUrl(actor.team, attributes),
                    ...(breadcrumb !== undefined && { breadcrumb }),
                    ...(shareUrl !== undefined && { shareUrl }),
                    ...(paging !== undefined && { paging }),
                  }),
                },
                {
                  type: "text" as const,
                  text: content,
                },
              ],
            } satisfies CallToolResult;
          }

          case "collection": {
            const collection = await Collection.findByPk(id, {
              userId: actor.id,
              includeDocumentStructure: true,
              rejectOnEmpty: true,
            });

            authorize(actor, "read", collection);

            const [presented, shareUrl] = await Promise.all([
              presentCollection(collection),
              getPublicShareUrlForCollection(actor.team, collection.id),
            ]);
            return success([
              {
                ...pathToUrl(actor.team, presented),
                ...(shareUrl !== undefined && { shareUrl }),
              },
              (collection.documentStructure ?? []).map((node) =>
                presentNavigationNode(actor.team, node)
              ),
            ]);
          }

          case "user": {
            const user = SELF_TOKENS.has(id.toLowerCase())
              ? actor
              : await User.findByPk(id, { rejectOnEmpty: true });

            authorize(actor, "read", user);

            return success(
              presentUser(user, {
                includeEmail: !!can(actor, "readEmail", user),
                includeDetails: !!can(actor, "readDetails", user),
              })
            );
          }

          case "attachment": {
            const attachment = await Attachment.findByPk(id, {
              rejectOnEmpty: true,
            });

            // Private attachments are accessible to any member of the workspace they
            // belong to. This is intentional and not a permission bypass – attachments
            // are owned by the workspace (team), not by individual documents or users.
            if (attachment.teamId !== actor?.teamId) {
              throw AuthorizationError();
            }

            return success({
              id: attachment.id,
              name: attachment.name,
              contentType: attachment.contentType,
              size: attachment.size,
              signedUrl: await attachment.signedUrl,
            });
          }

          case "template": {
            const template = await Template.findByPk(id, {
              userId: actor.id,
              rejectOnEmpty: true,
            });

            authorize(actor, "read", template);

            const { text, ...attributes } = await presentTemplate(template);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(pathToUrl(actor.team, attributes)),
                },
                {
                  type: "text" as const,
                  text,
                },
              ],
            } satisfies CallToolResult;
          }

          default:
            return error(`Unknown resource: ${resource}`);
        }
      } catch (message) {
        return error(message);
      }
    })
  );
}
