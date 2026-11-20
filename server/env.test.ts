import env, { Environment } from "@server/env";

const originalMaxTurnTokens = env.AI_CHAT_MAX_TURN_TOKENS;

afterEach(() => {
  delete process.env.AI_CHAT_MAX_TURN_TOKENS;
  env.AI_CHAT_MAX_TURN_TOKENS = originalMaxTurnTokens;
  vi.restoreAllMocks();
});

describe("AI_CHAT_MAX_TURN_TOKENS validation", () => {
  it("rejects a non-integer value at startup like every numeric setting", async () => {
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as typeof process.exit);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    process.env.AI_CHAT_MAX_TURN_TOKENS = "not-a-number";
    const candidate = new Environment();
    expect(candidate.AI_CHAT_MAX_TURN_TOKENS).toBeNaN();

    await vi.waitFor(
      () => {
        expect(exit).toHaveBeenCalledWith(1);
      },
      { timeout: 5000, interval: 10 }
    );

    const output = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Environment configuration is invalid");
    expect(output).toContain("must be a number");
  });

  it("accepts an integer value", () => {
    process.env.AI_CHAT_MAX_TURN_TOKENS = "2048";
    expect(new Environment().AI_CHAT_MAX_TURN_TOKENS).toEqual(2048);
  });

  it("leaves the ceiling unset when the variable is absent", () => {
    delete process.env.AI_CHAT_MAX_TURN_TOKENS;
    expect(new Environment().AI_CHAT_MAX_TURN_TOKENS).toBeUndefined();
  });
});
