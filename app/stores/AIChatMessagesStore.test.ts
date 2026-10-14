// The stores singleton must be imported before RootStore so that the module
// cycle through AuthStore -> developer.ts -> ~/stores resolves in the same
// order as the application entry point.
import "~/stores";
import { vi } from "vitest";
import AIChatMessagesStore from "~/stores/AIChatMessagesStore";
import RootStore from "~/stores/RootStore";
import { RPCAction } from "~/stores/base/Store";
import { client } from "~/utils/ApiClient";

const post = vi.mocked(client.post);

const messagesStore = (root: RootStore) =>
  root.getStoreForModelName<"aiChatMessages">("AIChatMessage");

const sessionsStore = (root: RootStore) =>
  root.getStoreForModelName<"aiChatSessions">("AIChatSession");

/** The shape of a message as returned by `ai.messages.list`. */
const message = (id: string, seq: number) => ({
  id,
  seq,
  role: seq % 2 === 1 ? "user" : "assistant",
  content: `Message ${id}`,
  status: "completed",
  runId: `run-${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("AIChatMessagesStore", () => {
  let rootStore: RootStore;
  let store: AIChatMessagesStore;

  beforeEach(() => {
    rootStore = new RootStore();
    store = messagesStore(rootStore);
    post.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("persistence and actions", () => {
    it("is not persistable, so messages are never written to IndexedDB", () => {
      expect(store.persistable).toBe(false);
    });

    it("only lists, and does not expose Info", () => {
      expect(store.actions).toEqual([RPCAction.List]);
      expect(store.actions).not.toContain(RPCAction.Info);
    });

    it("throws from fetch(id) rather than 404-ing", async () => {
      await expect(store.fetch("message-1")).rejects.toThrow(
        "Cannot fetch AIChatMessage"
      );
    });
  });

  describe("list", () => {
    it("posts to ai.messages.list with the sessionId", async () => {
      post.mockResolvedValueOnce({
        data: { messages: [], truncated: false },
      } as never);

      await store.list({ sessionId: "s1" });

      expect(post).toHaveBeenCalledWith("/ai.messages.list", {
        sessionId: "s1",
      });
    });

    it("passes the beforeSeq cursor through when paginating", async () => {
      post.mockResolvedValueOnce({
        data: { messages: [], truncated: false },
      } as never);

      await store.list({ sessionId: "s1", beforeSeq: 42 });

      expect(post).toHaveBeenCalledWith("/ai.messages.list", {
        sessionId: "s1",
        beforeSeq: 42,
      });
    });

    it("adds the messages from the response and returns the page metadata", async () => {
      post.mockResolvedValueOnce({
        data: {
          messages: [message("m1", 2), message("m2", 1)],
          truncated: true,
          cursor: 2,
        },
      } as never);

      const page = await store.list({ sessionId: "s1" });

      expect(page.messages.map((item) => item.id)).toEqual(["m1", "m2"]);
      expect(page.truncated).toBe(true);
      expect(page.cursor).toBe(2);
      expect(store.get("m1")?.seq).toBe(2);
      expect(store.get("m1")?.runId).toBe("run-m1");
    });

    it("stamps the sessionId onto every message so a cascade works", async () => {
      post.mockResolvedValueOnce({
        data: { messages: [message("m1", 1)], truncated: false },
      } as never);

      await store.list({ sessionId: "s1" });

      expect(store.get("m1")?.sessionId).toBe("s1");
      expect(store.get("m1")?.session).toBe(sessionsStore(rootStore).get("s1"));
    });

    it("never writes messages to IndexedDB, even once enabled", async () => {
      const persistable = store.persistable;
      post.mockResolvedValueOnce({
        data: { messages: [message("m1", 1)], truncated: false },
      } as never);

      await store.enablePersistence("team-1");
      await store.list({ sessionId: "s1" });

      expect(store.persistable).toBe(persistable);
    });
  });

  describe("store resolution", () => {
    it("resolves by model name to the aiChatMessages registration", () => {
      expect(rootStore.getStoreForModelName("AIChatMessage")).toBe(
        rootStore.aiChatMessages
      );
    });

    it("resolves to a store of the right class", () => {
      expect(messagesStore(rootStore)).toBeInstanceOf(AIChatMessagesStore);
    });
  });
});
