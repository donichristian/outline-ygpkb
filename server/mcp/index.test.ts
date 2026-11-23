import { McpServer } from "@modelcontextprotocol/server";
import { createMcpServer } from "./index";

/**
 * Returns the tool names registered while creating a server for the given
 * scopes.
 *
 * @param scopes - the scopes presented by the caller.
 * @returns the registered tool names.
 */
function registeredToolNames(scopes: string[]) {
  const spy = vi.spyOn(McpServer.prototype, "registerTool");

  try {
    createMcpServer("https://example.com", scopes);
    return spy.mock.calls.map(([name]) => name);
  } finally {
    spy.mockRestore();
  }
}

describe("createMcpServer", () => {
  it("registers no tools for a caller without scopes", () => {
    expect(registeredToolNames([])).toEqual([]);
  });

  it("registers only read tools for a read-only caller", () => {
    const names = registeredToolNames(["documents:read"]);

    expect(names).toContain("list_documents");
    expect(names).toContain("fetch");
    expect(names).not.toContain("create_document");
    expect(names).not.toContain("update_document");
    expect(names).not.toContain("delete_document");
    expect(names).not.toContain("list_users");
    expect(names.some((name) => name.includes("admin"))).toBe(false);
  });

  it("registers no admin-gated tools for a non-wildcard caller", () => {
    const names = registeredToolNames(["documents:read", "users:read"]);

    expect(names).toContain("list_users");
    expect(names.some((name) => name.includes("admin"))).toBe(false);
  });

  it("registers every tool for an explicit wildcard credential", () => {
    // `*` is only reachable through API keys; OAuth clients cannot request it.
    const names = registeredToolNames(["*"]);

    expect(names).toContain("create_document");
    expect(names).toContain("delete_document");
    expect(names).toContain("list_users");
    expect(names).toHaveLength(20);
  });
});
