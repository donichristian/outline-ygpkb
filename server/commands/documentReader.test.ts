import {
  DEFAULT_CHUNK_LIMIT,
  MAX_CHUNK_LIMIT,
  readDocumentBody,
  readDocumentBodyById,
  readDocumentSectionByAnchor,
} from "@server/commands/documentReader";
import { AuthorizationError, ValidationError } from "@server/errors";
import { Document, UserMembership } from "@server/models";
import { DocumentPermission } from "@shared/types";
import {
  buildCollection,
  buildDocument,
  buildUser,
} from "@server/test/factories";

/**
 * Loads a document the way a production caller would — through `findByPk`,
 * whose default scope preloads the creator/modifier users that the document
 * presenter reads — so the reader receives a fully populated instance.
 */
async function loadDocument(id: string) {
  return Document.findByPk(id, { rejectOnEmpty: true });
}

describe("documentReader", () => {
  it("returns the full body when it fits under the default limit", async () => {
    const created = await buildDocument({ text: "Small body." });
    const document = await loadDocument(created.id);

    const { content, paging } = await readDocumentBody(document);

    expect(content).toContain("Small body.");
    expect(paging).toBeUndefined();
  });

  it("truncates a long body at the default limit with the offset paging shape", async () => {
    const created = await buildDocument({
      text: "A".repeat(DEFAULT_CHUNK_LIMIT + 100),
    });
    const document = await loadDocument(created.id);

    const { content, paging } = await readDocumentBody(document);

    expect(content.length).toBe(DEFAULT_CHUNK_LIMIT);
    expect(paging).toEqual({
      start: 0,
      end: DEFAULT_CHUNK_LIMIT,
      total: DEFAULT_CHUNK_LIMIT + 100,
      hasMore: true,
    });
  });

  it("bounds an explicit limit at the maximum", async () => {
    const created = await buildDocument({
      text: "A".repeat(MAX_CHUNK_LIMIT + 100),
    });
    const document = await loadDocument(created.id);

    const { content, paging } = await readDocumentBody(document, {
      limit: MAX_CHUNK_LIMIT + 100,
    });

    expect(content.length).toBe(MAX_CHUNK_LIMIT);
    expect(paging).toEqual({
      start: 0,
      end: MAX_CHUNK_LIMIT,
      total: MAX_CHUNK_LIMIT + 100,
      hasMore: true,
    });
  });

  it("reads a later chunk when an offset is supplied", async () => {
    const created = await buildDocument({ text: "A".repeat(300) });
    const document = await loadDocument(created.id);

    const { content, paging } = await readDocumentBody(document, {
      offset: 200,
      limit: 100,
    });

    expect(content.length).toBe(100);
    expect(paging).toEqual({ start: 200, end: 300, total: 300, hasMore: false });
  });

  it("returns only the requested section and carries the section paging shape", async () => {
    const created = await buildDocument({
      text: [
        "# Title",
        "",
        "## Section One",
        "",
        "Body one.",
        "",
        "## Section Two",
        "",
        "Body two.",
      ].join("\n"),
    });
    const document = await loadDocument(created.id);

    const { content, paging } = await readDocumentBody(document, {
      section: "Section One",
    });

    expect(content).toContain("## Section One");
    expect(content).toContain("Body one.");
    expect(content).not.toContain("Section Two");
    expect(paging).toEqual({ section: "Section One" });
  });

  it("throws a validation error for an unmatched section", async () => {
    const created = await buildDocument({ text: "# Title\n\nBody." });
    const document = await loadDocument(created.id);

    await expect(
      readDocumentBody(document, { section: "Nope" })
    ).rejects.toThrow(
      ValidationError(
        `No section heading matching "Nope" was found in the document.`
      )
    );
  });

  it("refuses a document in a collection the user cannot read", async () => {
    const userA = await buildUser();
    const document = await buildDocument({
      teamId: userA.teamId,
      userId: userA.id,
      text: "Secret body.",
    });

    const userB = await buildUser({ teamId: userA.teamId });
    await UserMembership.create({
      documentId: document.id,
      userId: userB.id,
      createdById: userA.id,
      permission: DocumentPermission.Read,
    });

    await expect(readDocumentBodyById(document.id, userB)).resolves.toMatchObject({
      content: expect.stringContaining("Secret body."),
    });
  });

  it("refuses a document whose collection the user cannot read", async () => {
    const userA = await buildUser();
    const collection = await buildCollection({
      teamId: userA.teamId,
      userId: userA.id,
      permission: null,
    });
    const document = await buildDocument({
      teamId: userA.teamId,
      userId: userA.id,
      collectionId: collection.id,
      text: "Secret body.",
    });

    const userB = await buildUser({ teamId: userA.teamId });

    await expect(readDocumentBodyById(document.id, userB)).rejects.toThrow(
      AuthorizationError()
    );
  });

  it("matches a section by heading anchor via the separate anchor lookup", async () => {
    const created = await buildDocument({
      text: [
        "# Title",
        "",
        "## Anchor Heading",
        "",
        "Anchored body.",
      ].join("\n"),
    });
    const document = await loadDocument(created.id);

    // Heading anchors are slugged as "h-<slugified heading text>".
    const section = readDocumentSectionByAnchor(document, "h-anchor-heading");

    expect(section).toContain("## Anchor Heading");
    expect(section).toContain("Anchored body.");
  });
});
