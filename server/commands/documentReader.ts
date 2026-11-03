import { NotFoundError, PaymentRequiredError, ValidationError } from "@server/errors";
import { authorize } from "@server/policies";
import { Document, type User } from "@server/models";
import { DocumentHelper } from "@server/models/helpers/DocumentHelper";
import { presentDocument } from "@server/presenters";

/** Default characters returned for a document body when none is requested. */
export const DEFAULT_CHUNK_LIMIT = 20000;

/** Maximum characters a single fetch may return, to bound tool output. */
export const MAX_CHUNK_LIMIT = 60000;

/**
 * The character paging shape a body read that reports positions carries.
 */
export type BodyPaging = {
  start: number;
  end: number;
  total: number;
  hasMore: boolean;
};

/**
 * Options accepted by the body readers.
 */
export type ReadDocumentBodyOptions = {
  /**
   * Match a section by heading text (case-insensitive substring) and return
   * only that section's markdown.
   */
  section?: string;
  /**
   * Character offset to start reading the body from.
   */
  offset?: number;
  /**
   * Maximum characters of the body to return, bounded by
   * {@link MAX_CHUNK_LIMIT}.
   */
  limit?: number;
};

/**
 * The result of reading a document body.
 */
export type ReadDocumentBodyResult = {
  /** The markdown body text, possibly a section or chunk. */
  content: string;
  /**
   * The paging shape: `{ section }` for a matched section,
   * `{ start, end, total, hasMore }` for an offset/limit read or the
   * default truncation of a long body, undefined for a small untruncated read.
   */
  paging?: BodyPaging | { section: string };
};

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
 * Reads the body of an already-loaded, already-authorized document.
 *
 * The document must have been resolved and authorized by the caller — for
 * example the MCP fetch tool, which keeps its own `Document.findByPk` lookup
 * so a missing or trashed document still reports
 * `Document doesn't exist with id: <id>` — so this read does not perform a
 * second lookup or policy check. When the body is large and no `section` is
 * requested the read is truncated: the default chunk is
 * {@link DEFAULT_CHUNK_LIMIT} characters, and an explicit `offset`/`limit`
 * read is bounded by {@link MAX_CHUNK_LIMIT}. The two paging shapes emitted
 * are: `{ section }` for a matched section, and `{ start, end, total,
 * hasMore }` for both an offset/limit read and the default truncation of a
 * body longer than the default.
 *
 * @param document - the loaded, authorized document.
 * @param options - section, offset and limit options.
 * @returns the body content and optional paging metadata.
 * @throws when a requested section heading does not exist.
 */
export async function readDocumentBody(
  document: Document,
  options: ReadDocumentBodyOptions = {}
): Promise<ReadDocumentBodyResult> {
  const { text } = await presentDocument(undefined, document, {
    includeData: false,
    includeText: true,
    includeUpdatedAt: true,
    includeCommentCount: true,
  });

  const body = typeof text === "string" ? text : "";
  let content = body;
  let paging: ReadDocumentBodyResult["paging"];

  if (options.section) {
    const found = extractSection(body, options.section);
    if (found === undefined) {
      throw ValidationError(
        `No section heading matching "${options.section}" was found in the document.`
      );
    }
    content = found;
    paging = { section: options.section };
  } else if (options.offset !== undefined || options.limit !== undefined) {
    const chunk = chunkText(
      body,
      options.offset ?? 0,
      Math.min(options.limit ?? DEFAULT_CHUNK_LIMIT, MAX_CHUNK_LIMIT)
    );
    content = chunk.chunk;
    paging = {
      start: chunk.start,
      end: chunk.end,
      total: chunk.total,
      hasMore: chunk.hasMore,
    };
  } else if (body.length > DEFAULT_CHUNK_LIMIT) {
    // Default truncation of a long body, reusing the offset paging shape.
    const chunk = chunkText(body, 0, DEFAULT_CHUNK_LIMIT);
    content = chunk.chunk;
    paging = {
      start: chunk.start,
      end: chunk.end,
      total: chunk.total,
      hasMore: chunk.hasMore,
    };
  }

  return { content, paging };
}

/**
 * Reads the body of a document identified by id, authorizing the read through
 * the shared document loader path. This is the entry point for consumers
 * that start from an id rather than an already-loaded document.
 *
 * A missing row is reported as `NotFoundError` and a trashed row is
 * authorized through the `restore` ability, mirroring `documentLoader.ts`.
 *
 * @param id - the document identifier.
 * @param user - the user authorizing the read.
 * @param options - section, offset and limit options.
 * @returns the body content and optional paging metadata.
 * @throws when the document is missing or the user may not read it.
 */
export async function readDocumentBodyById(
  id: string,
  user: User,
  options: ReadDocumentBodyOptions = {}
): Promise<ReadDocumentBodyResult> {
  const document = await loadDocumentForRead(id, user);
  return readDocumentBody(document, options);
}

/**
 * Reads the body of a section located by heading **anchor** (the slug of the
 * heading, as used in the document's internal anchors), deliberately
 * separate from {@link readDocumentBody}'s `section` option, which matches
 * by heading text (case-insensitive substring) over the rendered markdown.
 *
 * The anchor lookup operates on the document's ProseMirror data through
 * `DocumentHelper.getAnchorContent` and resolves the heading via
 * `HeadingSlugger`, so it finds headings the text-based match cannot
 * (numbered duplicate slugs, headings nested in tables, ...). The document
 * is expected to already be loaded and authorized by the caller.
 *
 * @param document - the loaded, authorized document.
 * @param anchor - the heading anchor to locate, with or without a leading "#".
 * @returns the section content as markdown.
 * @throws when no heading matches the anchor.
 */
export function readDocumentSectionByAnchor(
  document: Document,
  anchor: string
): string {
  const found = DocumentHelper.getAnchorContent(document, anchor);

  if (found === undefined) {
    throw ValidationError(
      `No section heading matching anchor "${anchor}" was found in the document.`
    );
  }

  return found;
}

/**
 * Loads and authorizes a document by id: a missing row is `NotFoundError`,
 * a trashed row is authorized through the `restore` ability, and a readable
 * row is authorized through the `read` ability.
 *
 * Exported so callers that need the document itself (the AI `fetch_document`
 * tool needs the title and link) reuse the same authorized load instead of
 * repeating the lookup and policy check.
 *
 * @param id - the document identifier, either a uuid or a url slug.
 * @param user - the user authorizing the load.
 * @returns the loaded, authorized document.
 * @throws when the document is missing or the user may not read it.
 */
export async function loadDocumentForRead(
  id: string,
  user: User
): Promise<Document> {
  const document = await Document.findByPk(id, {
    userId: user.id,
    paranoid: false,
  });

  if (!document) {
    throw NotFoundError();
  }

  if (document.deletedAt) {
    // don't send data if user cannot restore deleted doc
    authorize(user, "restore", document);
  } else {
    authorize(user, "read", document);
  }

  if (document.isTrialImport) {
    throw PaymentRequiredError();
  }

  return document;
}
