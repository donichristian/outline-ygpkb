import { CollectionPermission, type NavigationNode } from "@shared/types";
import type { CallToolResult } from "@modelcontextprotocol/server";
import Logger from "@server/logging/Logger";
import {
  buildCollection,
  buildDocument,
  buildTeam,
  buildUser,
} from "@server/test/factories";
import {
  buildBreadcrumb,
  error,
  getBreadcrumbsForDocuments,
  optionalString,
  success,
  toolErrorCode,
  withTracing,
} from "./util";

const node = (
  id: string,
  title: string,
  children: NavigationNode[] = []
): NavigationNode => ({
  id,
  title,
  url: `/doc/${id}`,
  children,
});

describe("success", () => {
  it("returns a text block for empty list results", () => {
    expect(success([])).toEqual({
      content: [{ type: "text", text: "[]" }],
    });
  });

  it("returns one text block per list item", () => {
    expect(success([{ id: "a" }, { id: "b" }])).toEqual({
      content: [
        { type: "text", text: JSON.stringify({ id: "a" }) },
        { type: "text", text: JSON.stringify({ id: "b" }) },
      ],
    });
  });

  it("wraps a single object in one text block", () => {
    expect(success({ success: true })).toEqual({
      content: [{ type: "text", text: JSON.stringify({ success: true }) }],
    });
  });
});

describe("error", () => {
  it("replaces internal error text with a stable code", () => {
    const logged: Error[] = [];
    const spy = vi
      .spyOn(Logger, "error")
      .mockImplementation((_message, err) => {
        logged.push(err);
      });

    const result = error(
      new Error(
        "pg: duplicate key value violates UNIQUE constraint SECRET-DETAIL"
      )
    );

    const payload = JSON.stringify(result);
    expect(payload).toContain(toolErrorCode);
    expect(payload).not.toContain("SECRET-DETAIL");
    expect(result.isError).toBe(true);

    // Full detail still reaches server-side logging.
    expect(spy).toHaveBeenCalledOnce();
    expect(logged[0].message).toContain("SECRET-DETAIL");

    spy.mockRestore();
  });

  it("returns authored strings unchanged", () => {
    expect(error("Unknown resource: x")).toEqual({
      content: [{ type: "text", text: "Unknown resource: x" }],
      isError: true,
    });
  });
});

describe("withTracing", () => {
  it("sanitizes an error thrown by a tool handler", async () => {
    const spy = vi.spyOn(Logger, "error").mockImplementation(() => undefined);
    const handler = withTracing(
      "throwing_tool",
      async (_context: unknown): Promise<CallToolResult> => {
        throw new Error("conn refused at 10.0.0.5 SECRET-DETAIL");
      }
    );

    const result = await handler({});

    const payload = JSON.stringify(result);
    expect(payload).toContain(toolErrorCode);
    expect(payload).not.toContain("SECRET-DETAIL");
    expect(result.isError).toBe(true);
    expect(spy).toHaveBeenCalledOnce();

    spy.mockRestore();
  });
});

describe("buildBreadcrumb", () => {
  const structure: NavigationNode[] = [
    node("a", "Onboarding", [
      node("b", "Setup guide", [node("c", "Database")]),
      node("d", "Glossary"),
    ]),
    node("e", "Architecture"),
  ];

  it("returns just the collection name for a root-level document", () => {
    expect(buildBreadcrumb("a", structure, "Engineering")).toBe("Engineering");
    expect(buildBreadcrumb("e", structure, "Engineering")).toBe("Engineering");
  });

  it("includes ancestor titles for a nested document", () => {
    expect(buildBreadcrumb("b", structure, "Engineering")).toBe(
      "Engineering › Onboarding"
    );
    expect(buildBreadcrumb("c", structure, "Engineering")).toBe(
      "Engineering › Onboarding › Setup guide"
    );
  });

  it("excludes the document's own title from the path", () => {
    const result = buildBreadcrumb("c", structure, "Engineering");
    expect(result).not.toContain("Database");
  });

  it("falls back to the collection name when the document is not in the structure", () => {
    expect(buildBreadcrumb("missing", structure, "Engineering")).toBe(
      "Engineering"
    );
  });

  it("returns just the collection name when the structure is null", () => {
    expect(buildBreadcrumb("a", null, "Engineering")).toBe("Engineering");
    expect(buildBreadcrumb("a", undefined, "Engineering")).toBe("Engineering");
  });

  it("returns just the collection name when the structure is empty", () => {
    expect(buildBreadcrumb("a", [], "Engineering")).toBe("Engineering");
  });
});

describe("optionalString", () => {
  const schema = optionalString();

  it("returns undefined when input is omitted", () => {
    expect(schema.parse(undefined)).toBeUndefined();
  });

  it("coerces an empty string to undefined", () => {
    expect(schema.parse("")).toBeUndefined();
  });

  it("passes through a non-empty string", () => {
    expect(schema.parse("hello")).toBe("hello");
  });

  it("preserves whitespace-only strings", () => {
    expect(schema.parse(" ")).toBe(" ");
  });
});

describe("getBreadcrumbsForDocuments", () => {
  it("returns the collection name for a root-level document", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const collection = await buildCollection({
      teamId: team.id,
      permission: CollectionPermission.ReadWrite,
      name: "Engineering",
    });
    const doc = await buildDocument({
      teamId: team.id,
      collectionId: collection.id,
    });

    const result = await getBreadcrumbsForDocuments([doc], user);
    expect(result.get(doc.id)).toBe("Engineering");
  });

  it("includes ancestor titles for a nested document", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const collection = await buildCollection({
      teamId: team.id,
      permission: CollectionPermission.ReadWrite,
      name: "Engineering",
    });
    const parent = await buildDocument({
      teamId: team.id,
      collectionId: collection.id,
      title: "Onboarding",
    });
    const child = await buildDocument({
      teamId: team.id,
      collectionId: collection.id,
      parentDocumentId: parent.id,
    });

    const result = await getBreadcrumbsForDocuments([child], user);
    expect(result.get(child.id)).toBe("Engineering › Onboarding");
  });

  it("omits documents whose collection the user cannot read", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const collection = await buildCollection({
      teamId: team.id,
      permission: null,
      name: "Secrets",
    });
    const doc = await buildDocument({
      teamId: team.id,
      collectionId: collection.id,
    });

    const result = await getBreadcrumbsForDocuments([doc], user);
    expect(result.has(doc.id)).toBe(false);
  });

  it("returns an empty map for empty input", async () => {
    const user = await buildUser();
    const result = await getBreadcrumbsForDocuments([], user);
    expect(result.size).toBe(0);
  });

  it("omits documents that have no collection", async () => {
    const user = await buildUser();
    const result = await getBreadcrumbsForDocuments(
      [{ id: "doc-without-collection", collectionId: null }],
      user
    );
    expect(result.has("doc-without-collection")).toBe(false);
  });

  it("falls back to the collection name for a document missing from the structure", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const collection = await buildCollection({
      teamId: team.id,
      permission: CollectionPermission.ReadWrite,
      name: "Engineering",
    });

    const result = await getBreadcrumbsForDocuments(
      [{ id: "not-in-structure", collectionId: collection.id }],
      user
    );
    expect(result.get("not-in-structure")).toBe("Engineering");
  });

  it("resolves breadcrumbs across multiple collections in one call", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const c1 = await buildCollection({
      teamId: team.id,
      permission: CollectionPermission.ReadWrite,
      name: "One",
    });
    const c2 = await buildCollection({
      teamId: team.id,
      permission: CollectionPermission.ReadWrite,
      name: "Two",
    });
    const d1 = await buildDocument({ teamId: team.id, collectionId: c1.id });
    const d2 = await buildDocument({ teamId: team.id, collectionId: c2.id });

    const result = await getBreadcrumbsForDocuments([d1, d2], user);
    expect(result.get(d1.id)).toBe("One");
    expect(result.get(d2.id)).toBe("Two");
  });
});
