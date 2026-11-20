// @vitest-isolate true
import { buildToolCallDigest, ToolCallDigestEntry } from "./middleware";
import {
  createToolCallBudget,
  DefaultMaxToolCalls,
  loadServerTools,
  MaxToolCalls,
  resolveToolCallCap,
  ToolBudgetExhausted,
} from "./tools";

vi.mock("./tanstack", () => ({
  loadTanstack: () => import("@tanstack/ai"),
}));

/** A frozen server tool, unwrapped to the callable surface the test drives. */
type CallableTool = {
  execute: (input: object, context: never) => Promise<unknown>;
};

/**
 * Views a frozen tool definition as callable.
 *
 * @param tool the tool definition.
 * @returns the same tool with its execute surface typed for the test.
 */
function callable(tool: unknown): CallableTool {
  return tool as CallableTool;
}

describe("resolveToolCallCap", () => {
  it("falls back to the documented default when unset or non-numeric", () => {
    expect(DefaultMaxToolCalls).toBe(12);
    expect(MaxToolCalls).toBe(40);
    expect(resolveToolCallCap(undefined)).toBe(12);
    expect(resolveToolCallCap(Number.NaN)).toBe(12);
    expect(resolveToolCallCap(0)).toBe(12);
  });

  it("keeps an operator value inside the documented range", () => {
    expect(resolveToolCallCap(1)).toBe(1);
    expect(resolveToolCallCap(2)).toBe(2);
    expect(resolveToolCallCap(40)).toBe(40);
  });

  it("clamps a value above the documented maximum", () => {
    expect(resolveToolCallCap(41)).toBe(40);
    expect(resolveToolCallCap(1000)).toBe(40);
  });
});

describe("createToolCallBudget", () => {
  it("counts on every invocation and never re-opens once exceeded", () => {
    const budget = createToolCallBudget(2);

    expect(budget.claim()).toBe(true);
    expect(budget.claim()).toBe(true);
    expect(budget.claim()).toBe(false);
    expect(budget.claim()).toBe(false);
  });

  it("lets a three-tool turn run under the default cap", () => {
    const budget = createToolCallBudget(resolveToolCallCap(undefined));

    expect([budget.claim(), budget.claim(), budget.claim()]).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe("server tool wrappers", () => {
  it("refuses every tool with the terminal message once the budget is spent", async () => {
    const tools = await loadServerTools();
    const spent = { claim: () => false };
    // Reading the user at all means the wrapper ran its body past the guard.
    const user = new Proxy(
      {},
      {
        get() {
          throw new Error("tool body ran after the budget was spent");
        },
      }
    );

    for (const tool of tools) {
      await expect(
        callable(tool).execute({}, { context: { user, toolBudget: spent } } as never)
      ).rejects.toThrow(new RegExp(ToolBudgetExhausted));
    }
  });

  it("counts a call against the shared counter before the body runs", async () => {
    const tools = await loadServerTools();
    let claims = 0;
    const budget = {
      claim: () => {
        claims += 1;
        return false;
      },
    };

    await expect(
      callable(tools[0]).execute(
        {},
        { context: { user: {}, toolBudget: budget } } as never
      )
    ).rejects.toThrow(new RegExp(ToolBudgetExhausted));
    expect(claims).toBe(1);
  });
});

describe("buildToolCallDigest", () => {
  const entry: ToolCallDigestEntry = {
    toolCallId: "call_1",
    toolName: "search_workspace",
    arguments: { query: "payments" },
    documentIds: [],
    titles: [],
    links: [],
    characterCount: 0,
    truncated: false,
  };

  it("records the typed budget event next to the turn's tool calls", () => {
    const digest = buildToolCallDigest([entry], true);

    expect(digest).toEqual({
      toolCalls: [entry],
      events: [{ type: "tool-call-budget-exhausted" }],
    });
  });

  it("records no event when the turn stayed inside the cap", () => {
    expect(buildToolCallDigest([entry], false)).toEqual({ toolCalls: [entry] });
  });

  it("persists nothing when no tool ran", () => {
    expect(buildToolCallDigest([], false)).toBeUndefined();
  });
});
