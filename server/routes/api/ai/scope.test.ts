// @vitest-isolate true
import type { User } from "@server/models";
import SearchProviderManager from "@server/utils/SearchProviderManager";
import { isUntokenizableScript } from "./scope";
import { findUngroundedReason } from "./scope";

/**
 * A stand-in for the search provider whose only contract is the one
 * `findUngroundedReason` uses: `searchForUser` returning a `{ total }`.
 */
type ProbeProvider = {
  searchForUser: (user: User, args: unknown) => Promise<{ total: number }>;
};

/**
 * Builds a minimal user. The provider is mocked for every test, so no field is
 * read other than `id` in the failure log path.
 *
 * @returns a user-shaped object cast to the model type.
 */
function fakeUser(): User {
  return { id: "user-1" } as User;
}

/**
 * A conversation with a single user turn.
 *
 * @param content the prompt text.
 * @returns the messages array accepted by `findUngroundedReason`.
 */
function userTurn(content: string) {
  return [{ role: "user" as const, content }];
}

/**
 * Installs a search provider double for the duration of a test.
 *
 * @param provider the provider to install.
 */
function stubProvider(provider: ProbeProvider): void {
  vi.spyOn(SearchProviderManager, "getProvider").mockReturnValue(
    provider as ReturnType<typeof SearchProviderManager.getProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

const hanPrompt = "支付服务的部署手册在哪里";

describe("findUngroundedReason", () => {
  it("reports `unsupported script` for a multi-character whitespace-free prompt with no match", async () => {
    stubProvider({ searchForUser: async () => ({ total: 0 }) });

    const reason = await findUngroundedReason(fakeUser(), userTurn(hanPrompt));

    expect(reason).toEqual("unsupported script");
  });

  it("still allows a grounded prompt (boundary intact, returns undefined)", async () => {
    // A Latin prompt whose OR-query lexically retrieves: this is the decision
    // path the script ceiling must not disturb. `total > 0` is still the only
    // route to `undefined`.
    stubProvider({ searchForUser: async () => ({ total: 3 }) });

    const reason = await findUngroundedReason(
      fakeUser(),
      userTurn("payments deployment runbook")
    );

    expect(reason).toBeUndefined();
  });

  it("DOCUMENTS THE LIMITATION: a whitespace-free prompt is refused even when a matching document exists", async () => {
    // The deployed `tsquery` config tokenizes on whitespace, so a Han sentence
    // arrives as one long unmatchable "word" and the provider returns zero hits
    // even though the workspace contains the document the user is asking about.
    // This test asserts the fail-closed refusal rather than real grounding.
    //
    // PROBE COULD NOT RUN: this environment has no live authenticated round-trip
    // against a Han-indexed corpus, so the 50% threshold ships as the documented
    // default and the limitation is pinned here instead.
    stubProvider({ searchForUser: async () => ({ total: 0 }) });

    const reason = await findUngroundedReason(fakeUser(), userTurn(hanPrompt));

    expect(reason).toEqual("unsupported script");
  });

  it("reports `no distinctive terms` for a single-token whitespace-free prompt", async () => {
    // `好` normalizes to one token of length 1, which `buildProbeQuery` drops
    // (`word.length < 2`). The function returns before the search, so the
    // ceiling looks different from the multi-character case above: the new
    // `unsupported script` reason only covers multi-character prompts.
    const searchForUser = vi.fn(async () => ({ total: 0 }));
    stubProvider({ searchForUser });

    const reason = await findUngroundedReason(fakeUser(), userTurn("好"));

    expect(reason).toEqual("no distinctive terms");
    expect(searchForUser).not.toHaveBeenCalled();
  });

  it("pins the 50% threshold on a mixed-script prompt", async () => {
    // `deploy 支付服务` is 6 Latin letters + 4 Han letters → 40% Han, below the
    // 50% threshold, so it classifies as `no matching document`, not
    // `unsupported script`. This pins the boundary direction.
    stubProvider({ searchForUser: async () => ({ total: 0 }) });

    const reason = await findUngroundedReason(
      fakeUser(),
      userTurn("deploy 支付服务")
    );

    expect(reason).toEqual("no matching document");
  });

  it("reports `unsupported script` on a mixed-script prompt at or above the threshold", async () => {
    // `支付服务的部署手册 deploy` is 8 Han letters + 6 Latin letters → 57% Han,
    // above the threshold, so it flips to `unsupported script`.
    stubProvider({ searchForUser: async () => ({ total: 0 }) });

    const reason = await findUngroundedReason(
      fakeUser(),
      userTurn("支付服务的部署手册 deploy")
    );

    expect(reason).toEqual("unsupported script");
  });

  it("reports `search failed` when retrieval throws, even for a whitespace-free prompt", async () => {
    // Proves the classifier never runs ahead of the search and that a throw
    // stays fail-closed, regardless of script.
    stubProvider({
      searchForUser: async () => {
        throw new Error("search unavailable");
      },
    });

    const reason = await findUngroundedReason(fakeUser(), userTurn(hanPrompt));

    expect(reason).toEqual("search failed");
  });

  it.each([
    ["Cyrillic", "развертывание платежного сервиса"],
    ["Greek", "ανάπτυξη υπηρεσίας πληρωμών"],
  ])(
    "does not classify space-delimited %s text as `unsupported script`",
    async (_script, prompt) => {
      stubProvider({ searchForUser: async () => ({ total: 0 }) });

      const reason = await findUngroundedReason(fakeUser(), userTurn(prompt));

      expect(reason).toEqual("no matching document");
    }
  );
});

describe("isUntokenizableScript", () => {
  it("classifies a pure Han prompt as untokenizable", () => {
    expect(isUntokenizableScript(hanPrompt)).toBe(true);
  });

  it("classifies a pure Latin prompt as tokenizable", () => {
    expect(isUntokenizableScript("payments deployment runbook")).toBe(false);
  });

  it("classifies a pure Cyrillic prompt as tokenizable", () => {
    expect(
      isUntokenizableScript("развертывание платежного сервиса")
    ).toBe(false);
  });

  it("does not fire on letterless input", () => {
    expect(isUntokenizableScript("12345")).toBe(false);
    expect(isUntokenizableScript("")).toBe(false);
  });
});
