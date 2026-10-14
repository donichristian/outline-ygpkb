// The stores singleton must be imported before RootStore so that the module
// cycle through AuthStore -> developer.ts -> ~/stores resolves in the same
// order as the application entry point.
import "~/stores";
import AIChatMessagesStore from "~/stores/AIChatMessagesStore";
import AIChatSessionsStore from "~/stores/AIChatSessionsStore";
import RootStore from "~/stores/RootStore";

describe("RootStore AIChat registration", () => {
  it("exposes the AI chat stores under their explicit field names", () => {
    const rootStore = new RootStore();

    expect(rootStore.aiChatSessions).toBeInstanceOf(AIChatSessionsStore);
    expect(rootStore.aiChatMessages).toBeInstanceOf(AIChatMessagesStore);
  });

  it("does not fall back to the pluralized `aIChat...` field names", () => {
    const registeredKeys = Object.keys(new RootStore());

    // `pluralize(lowerFirst("AIChatSession"))` yields `aIChatSessions`, so this
    // fails with the actual wrong key printed when the explicit names are
    // dropped from RootStore.
    expect(
      registeredKeys.filter((key) => key.toLowerCase().startsWith("aichat"))
    ).toEqual(["aiChatSessions", "aiChatMessages"]);
  });

  it("resolves the stores by their model name for relation lookups", () => {
    const rootStore = new RootStore();

    expect(rootStore.getStoreForModelName("AIChatSession")).toBe(
      rootStore.aiChatSessions
    );
    expect(rootStore.getStoreForModelName("AIChatMessage")).toBe(
      rootStore.aiChatMessages
    );
  });

  it("constructs without a duplicate-registration invariant error", () => {
    expect(() => new RootStore()).not.toThrow(/No store found/);
  });
});