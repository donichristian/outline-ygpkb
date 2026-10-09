import { buildCollection, buildDocument } from "@server/test/factories";
import { getTestServer } from "@server/test/support";
import {
  buildOAuthUser,
  callMcpTool,
  parseMcpListContent,
} from "@server/test/McpHelper";

const server = getTestServer();

// Regression gate for KB citations: an agent (e.g. Matius) must be able to cite
// the source document — title + URL — and surface related documents, straight
// from the MCP tool output. If these fields go missing, the bot can retrieve
// content but can no longer say where it came from.
describe("KB citation data", () => {
  it("fetch exposes the title and URL needed to cite a source", async () => {
    const { user, accessToken } = await buildOAuthUser();
    const collection = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
      name: "Akademik",
    });
    const document = await buildDocument({
      title: "SOP Akademik",
      teamId: user.teamId,
      userId: user.id,
      collectionId: collection.id,
      text: "# Pendahuluan\n\nIsi SOP.",
    });

    const res = await callMcpTool(server, accessToken, "fetch", {
      resource: "document",
      id: document.id,
    });

    expect(res?.result?.isError).toBeFalsy();
    const metadata = JSON.parse(res!.result!.content![0].text ?? "{}");

    expect(metadata.document.title).toEqual("SOP Akademik");
    expect(metadata.document.url).toMatch(/^https?:\/\/.+\/doc\//);
    expect(metadata.document.url).toContain(document.urlId);
  });

  it("fetch returns a breadcrumb for collection context", async () => {
    const { user, accessToken } = await buildOAuthUser();
    const collection = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
      name: "Akademik",
    });
    const document = await buildDocument({
      title: "SOP Akademik",
      teamId: user.teamId,
      userId: user.id,
      collectionId: collection.id,
    });

    const res = await callMcpTool(server, accessToken, "fetch", {
      resource: "document",
      id: document.id,
    });

    const metadata = JSON.parse(res!.result!.content![0].text ?? "{}");
    expect(metadata.breadcrumb).toBe("Akademik");
  });

  it("search returns citable sources for related KB documents", async () => {
    const { user, accessToken } = await buildOAuthUser();
    const collection = await buildCollection({
      teamId: user.teamId,
      userId: user.id,
      name: "Akademik",
    });
    const first = await buildDocument({
      title: "Kurikulum PAUD",
      teamId: user.teamId,
      userId: user.id,
      collectionId: collection.id,
      text: "Struktur kurikulum PAUD.",
    });
    const second = await buildDocument({
      title: "Pedoman Kurikulum",
      teamId: user.teamId,
      userId: user.id,
      collectionId: collection.id,
      text: "Pedoman penerapan kurikulum.",
    });

    const res = await callMcpTool(server, accessToken, "list_documents", {
      query: "kurikulum",
    });
    const results = parseMcpListContent<{
      document: { id: string; title: string; url: string };
    }>(res?.result?.content);

    const ids = results.map((r) => r.document.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);

    for (const r of results) {
      expect(r.document.url).toMatch(/^https?:\/\/.+\/doc\//);
      expect(typeof r.document.title).toBe("string");
      expect(r.document.title.length).toBeGreaterThan(0);
    }
  });
});
