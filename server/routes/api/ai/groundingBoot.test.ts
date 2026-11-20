// @vitest-isolate true
import type Logger from "@server/logging/Logger";
import { RateLimiterStrategy } from "@server/utils/RateLimiter";

interface BootLog {
  category: string;
  message: string;
  extra: Record<string, unknown> | undefined;
}

interface Boot {
  lines: BootLog[];
  logAiChatGroundingState: () => void;
}

/**
 * Simulates one boot: a fresh module registry, the grounding configuration the
 * environment resolves to, and exactly the calls the boot site makes.
 *
 * @param grounding the value \`AI_CHAT_GROUNDING\` resolves to for this boot.
 * @returns the grounding lines the boot emitted, plus the emitter under test.
 */
async function boot(grounding: boolean): Promise<Boot> {
  vi.resetModules();

  const { default: env } = await import("@server/env");
  const { default: logger } = await import("@server/logging/Logger");
  const { logAiChatGroundingState } = await import("./enabled");

  env.AI_CHAT_GROUNDING = grounding;

  const info = vi
    .spyOn(logger as unknown as typeof Logger, "info")
    .mockImplementation(() => {});

  // A boot calls the emitter once; a second call must not duplicate the line.
  logAiChatGroundingState();
  logAiChatGroundingState();

  const lines = info.mock.calls
    .filter(([category]) => category === "ai-chat")
    .map(([category, message, extra]) => ({
      category: String(category),
      message,
      extra: extra as Record<string, unknown> | undefined,
    }));

  return { lines, logAiChatGroundingState };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("ai chat grounding boot log", () => {
  it("emits exactly one line per boot with the resolved values when grounding is enabled", async () => {
    const { lines } = await boot(true);
    const rateLimit = RateLimiterStrategy.TenPerMinute;

    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("grounding=enabled fail-closed");
    expect(lines[0].extra).toEqual({
      grounding: true,
      maxProbeTerms: 8,
      untokenizableScriptRatio: 0.5,
      rateLimit: `${rateLimit.requests}/${rateLimit.duration}s`,
    });
  });

  it("reports the resolved off state when AI_CHAT_GROUNDING is disabled", async () => {
    const { lines } = await boot(false);
    const rateLimit = RateLimiterStrategy.TenPerMinute;

    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe("grounding=disabled");
    expect(lines[0].extra).toEqual({
      grounding: false,
      maxProbeTerms: 8,
      untokenizableScriptRatio: 0.5,
      rateLimit: `${rateLimit.requests}/${rateLimit.duration}s`,
    });
  });

  it("carries configuration only, never request data", async () => {
    const { lines, logAiChatGroundingState } = await boot(true);

    // No parameters means no request can reach the emitter.
    expect(logAiChatGroundingState.length).toBe(0);
    expect(Object.keys(lines[0].extra ?? {}).sort()).toEqual([
      "grounding",
      "maxProbeTerms",
      "rateLimit",
      "untokenizableScriptRatio",
    ]);
    expect(JSON.stringify(lines[0])).not.toMatch(
      /userId|sessionId|prompt|query|authorization|cookie/i
    );
  });
});
