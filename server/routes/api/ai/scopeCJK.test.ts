// @vitest-isolate true
import type { User } from "@server/models";
import SearchProviderManager from "@server/utils/SearchProviderManager";
import { findUngroundedReason } from "./scope";

/**
 * A stand-in for the search provider whose only contract is the one
 * `findUngroundedReason` uses: `searchForUser` returning a `{ total }`.
 */
type ProbeProvider = {
  searchForUser: (user: User, args: { query: string }) => Promise<{
    total: number;
  }>;
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
 * Installs a search provider double and returns the `searchForUser` spy so a
 * test can assert the query the gate actually searched with.
 *
 * @param provider the provider to install.
 * @returns the installed spy.
 */
function stubProvider(provider: ProbeProvider) {
  return vi.spyOn(SearchProviderManager, "getProvider").mockReturnValue(
    provider as ReturnType<typeof SearchProviderManager.getProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

const cjkPrompt = "什么是我们的部署流程？";

describe("findUngroundedReason – untokenizable scripts fall back to retrieval", () => {
  it("(a) proceeds for a CJK prompt when retrieval returns a grounded document", async () => {
    const searchForUser = vi.fn(async () => ({ total: 1 }));
    stubProvider({ searchForUser });

    const reason = await findUngroundedReason(fakeUser(), userTurn(cjkPrompt));

    expect(reason).toBeUndefined();
    // The raw prompt, not the single unmatchable token `buildProbeQuery` would
    // have produced from it.
    expect(searchForUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ query: "什么是我们的部署流程" })
    );
  });

  it("(b) refuses a CJK prompt with `no_grounded_docs` when retrieval is empty", async () => {
    stubProvider({ searchForUser: async () => ({ total: 0 }) });

    const reason = await findUngroundedReason(fakeUser(), userTurn(cjkPrompt));

    expect(reason).toEqual("no_grounded_docs");
  });

  it.each([["———"], ["😀😀😀"]])(
    "(c) keeps the pre-existing answer for the prompt-less input %s",
    async (prompt) => {
      const searchForUser = vi.fn(async () => ({ total: 0 }));
      stubProvider({ searchForUser });

      const reason = await findUngroundedReason(fakeUser(), userTurn(prompt));

      expect(reason).toEqual("empty prompt");
      // Nothing survived normalization, so there is no text to search with.
      expect(searchForUser).not.toHaveBeenCalled();
    }
  );

  it.each([["the of to"], ["hi"], ["Can you tell me anything about it?"]])(
    "(c) leaves the topicless prompt %s ungated as before",
    async (prompt) => {
      const searchForUser = vi.fn(async () => ({ total: 0 }));
      stubProvider({ searchForUser });

      const reason = await findUngroundedReason(fakeUser(), userTurn(prompt));

      expect(reason).toBeUndefined();
      // Not a whitespace-free script, so nothing defeated tokenization: the
      // prompt carries no topic and the gate leaves it to the provider.
      expect(searchForUser).not.toHaveBeenCalled();
    }
  );

  it("(d) keeps a tokenizable Latin prompt bit-identical (grounded ⇒ proceeds)", async () => {
    const searchForUser = vi.fn(async () => ({ total: 3 }));
    stubProvider({ searchForUser });

    const reason = await findUngroundedReason(
      fakeUser(),
      userTurn("payments deployment runbook")
    );

    expect(reason).toBeUndefined();
    expect(searchForUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ query: "payments|deployment|runbook" })
    );
  });

  it("(d) keeps a tokenizable Latin prompt bit-identical (empty ⇒ `no matching document`)", async () => {
    const searchForUser = vi.fn(async () => ({ total: 0 }));
    stubProvider({ searchForUser });

    const reason = await findUngroundedReason(
      fakeUser(),
      userTurn("payments deployment runbook")
    );

    expect(reason).toEqual("no matching document");
  });

  it("(d) keeps a tokenizable Latin prompt bit-identical (Wifi password?)", async () => {
    const searchForUser = vi.fn(async () => ({ total: 0 }));
    stubProvider({ searchForUser });

    const reason = await findUngroundedReason(
      fakeUser(),
      userTurn("Wifi password?")
    );

    // Pre-change and post-change are the same value: the same extracted query,
    // one search, and the same reason. Only the whitespace-free branch differs.
    expect(reason).toEqual("no matching document");
    expect(searchForUser).toHaveBeenCalledTimes(1);
    expect(searchForUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ query: "wifi|password" })
    );
  });

  it("(d) keeps MaxProbeTerms at 8 for a tokenizable Latin prompt", async () => {
    const searchForUser = vi.fn(async () => ({ total: 0 }));
    stubProvider({ searchForUser });

    await findUngroundedReason(
      fakeUser(),
      userTurn("alpha bravo charlie delta echo foxtrot golf hotel india juliet")
    );

    expect(searchForUser).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        query: "alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel",
      })
    );
  });
});
