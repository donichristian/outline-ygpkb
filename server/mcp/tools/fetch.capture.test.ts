// Captures the external MCP fetch tool's document payload for byte-identity
// evidence: run before and after the reader refactor and diff the outputs.
// A stable seed makes the document content identical across runs; the
// per-run identifiers (share/breadcrumb URLs) are normalized before
// comparison.
import { buildCollection, buildDocument } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import { buildOAuthUser, callMcpTool } from "@server/test/McpHelper";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const server = getTestServer();

/** Strips per-run identifiers so two captures of the same document diff cleanly. */
function normalize(text: unknown): unknown {
  if (typeof text !== "string") {
    return text;
  }
  const withoutUrls = text.replace(/https?:\/\/[^\s"]+/g, "<URL>");
  let json: unknown;
  try {
    json = JSON.parse(withoutUrls);
  } catch {
    return withoutUrls;
  }
  if (typeof json !== "object" || json === null) {
    return withoutUrls;
  }
  const meta = (json as { document?: Record<string, unknown> }).document;
  if (meta) {
    delete meta.createdAt;
    delete meta.updatedAt;
    delete meta.publishedAt;
  }
  return JSON.stringify(json);
}

describe("fetch byte-identity capture", () => {
  it("captures payload bytes for the document branch", async () => {
    const { user, accessToken } = await buildOAuthUser();
    const collection = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
    });
    const document = await buildDocument({
      teamId: user.teamId,
      userId: user.id,
      collectionId: collection.id,
      text: "# Structured Doc\n\n## Alpha\n\nAlpha body.\n\n## Beta\n\nBeta body.",
    });

    // Default read (small body, no paging)
    const base = await callMcpTool(server, accessToken, "fetch", {
      resource: "document",
      id: document.id,
    });
    // Section branch (section paging shape)
    const sectioned = await callMcpTool(server, accessToken, "fetch", {
      resource: "document",
      id: document.id,
      section: "Beta",
    });
    // Offset/limit branch (offset paging shape)
    const paged = await callMcpTool(server, accessToken, "fetch", {
      resource: "document",
      id: document.id,
      offset: 0,
      limit: 40,
    });
    // Unmatched section error
    const missing = await callMcpTool(server, accessToken, "fetch", {
      resource: "document",
      id: document.id,
      section: "Nope",
    });
    // Missing id error
    const notFound = await callMcpTool(server, accessToken, "fetch", {
      resource: "document",
      id: "00000000-0000-4000-8000-000000000000",
    });

    const capture = {
      base: base?.result?.content?.map((c) => normalize(c.text)),
      sectioned: sectioned?.result?.content?.map((c) => normalize(c.text)),
      paged: paged?.result?.content?.map((c) => normalize(c.text)),
      missingSection: missing?.result?.content?.map((c) => normalize(c.text)),
      missingId: notFound?.result?.content?.map((c) => normalize(c.text)),
    };

    // Persist the capture so the before/after payloads can be diffed.
    const outFile = process.env.CAPTURE_OUT || "capture.json";
    writeFileSync(
      resolve(outFile),
      JSON.stringify(capture, null, 2),
      "utf8"
    );

    expect(capture.missingSection?.[0]).toBe(
      'No section heading matching "Nope" was found in the document.'
    );
    expect(capture.missingId?.[0]).toBe(
      "Document doesn't exist with id: 00000000-0000-4000-8000-000000000000"
    );
    expect(capture.base?.[1]).toContain("Alpha body.");
    expect(capture.sectioned?.[1]).toContain("Beta body.");
    expect((capture.paged?.[1] as string)?.length).toBe(40);
  });
});
