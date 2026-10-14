// The stores singleton must be imported before RootStore so that the module
// cycle through AuthStore -> developer.ts -> ~/stores resolves in the same
// order as the application entry point.
import "~/stores";
import { vi } from "vitest";
import AIChatSessionsStore from "~/stores/AIChatSessionsStore";
import RootStore from "~/stores/RootStore";
import { RPCAction } from "~/stores/base/Store";
import { client } from "~/utils/ApiClient";

const post = vi.mocked(client.post);

const sessionsStore = (root: RootStore) =>
  root.getStoreForModelName<"aiChatSessions">("AIChatSession");

/** The shape of a session as returned by `ai.sessions.list`. */
const session = (id: string, createdAt: string, updatedAt: string) => ({
  id,
  title: `Session ${id}`,
  createdAt,
  updatedAt,
});

describe("AIChatSessionsStore", () => {
  let rootStore: RootStore;
  let store: AIChatSessionsStore;

  beforeEach(() => {
    rootStore = new RootStore();
    store = sessionsStore(rootStore);
    post.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("persistence and actions", () => {
    it("is persistable, so sessions are cached to IndexedDB", () => {
      expect(store.persistable).toBe(true);
    });

    it("does not expose Info, so fetch(id) throws rather than 404-ing", async () => {
      expect(store.actions).not.toContain(RPCAction.Info);
      await expect(store.fetch("session-1")).rejects.toThrow(
        "Cannot fetch AIChatSession"
      );
    });

    it("lists, creates and deletes, but does not update", () => {
      expect(store.actions).toEqual([
        RPCAction.List,
        RPCAction.Create,
        RPCAction.Delete,
      ]);
    });
  });

  describe("actions hit the correct RPC path", () => {
    it("create posts to ai.sessions.create", async () => {
      const data = session(
        "s1",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z"
      );
      post.mockResolvedValueOnce({ data } as never);

      await store.create({ title: "New chat" });

      expect(post).toHaveBeenCalledWith("/ai.sessions.create", {
        title: "New chat",
      });
    });

    it("delete posts to ai.sessions.delete", async () => {
      const item = store.add(
        session("s1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")
      );
      post.mockResolvedValueOnce({ data: {} } as never);

      await store.delete(item);

      expect(post).toHaveBeenCalledWith("/ai.sessions.delete", { id: "s1" });
    });

    it("list posts to ai.sessions.list", async () => {
      post.mockResolvedValueOnce({
        data: { sessions: [] },
      } as never);

      await store.list();

      expect(post).toHaveBeenCalledWith("/ai.sessions.list");
    });
  });

  describe("list", () => {
    it("adds the sessions from the response", async () => {
      post.mockResolvedValueOnce({
        data: {
          sessions: [
            session(
              "s1",
              "2026-01-01T00:00:00.000Z",
              "2026-01-01T00:00:00.000Z"
            ),
            session(
              "s2",
              "2026-01-02T00:00:00.000Z",
              "2026-01-02T00:00:00.000Z"
            ),
          ],
        },
      } as never);

      const result = await store.list();

      expect(result.map((item) => item.id)).toEqual(["s1", "s2"]);
      expect(store.get("s1")).toBeTruthy();
      expect(store.get("s2")).toBeTruthy();
    });

    it("removes a locally-present session that is absent from the response", async () => {
      // A session restored from the IndexedDB cache, no longer on the server.
      store.add(
        session("stale", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")
      );
      // A session that still exists.
      store.add(
        session("keep", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")
      );

      post.mockResolvedValueOnce({
        data: {
          sessions: [
            session(
              "keep",
              "2026-01-01T00:00:00.000Z",
              "2026-01-02T00:00:00.000Z"
            ),
          ],
        },
      } as never);

      await store.list();

      expect(store.get("stale")).toBeUndefined();
      expect(store.get("keep")).toBeTruthy();
    });
  });

  describe("sessionsByRecency", () => {
    it("orders by updatedAt descending", () => {
      store.add(
        session("old", "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z")
      );
      store.add(
        session("new", "2026-01-01T00:00:00.000Z", "2026-01-05T00:00:00.000Z")
      );

      expect(store.sessionsByRecency.map((item) => item.id)).toEqual([
        "new",
        "old",
      ]);
    });

    it("differs from orderedData, which sorts by createdAt", () => {
      // "continued" was created earlier but is the most recently updated, so
      // recency puts it first while orderedData (createdAt DESC) puts it last.
      store.add(
        session(
          "continued",
          "2026-01-01T00:00:00.000Z",
          "2026-01-05T00:00:00.000Z"
        )
      );
      store.add(
        session(
          "dormant",
          "2026-01-03T00:00:00.000Z",
          "2026-01-03T00:00:00.000Z"
        )
      );

      expect(store.sessionsByRecency.map((item) => item.id)).toEqual([
        "continued",
        "dormant",
      ]);
      expect(store.orderedData.map((item) => item.id)).toEqual([
        "dormant",
        "continued",
      ]);
    });
  });

  describe("store resolution", () => {
    it("resolves by model name to the aiChatSessions registration, not aIChatSessions", () => {
      expect(rootStore.getStoreForModelName("AIChatSession")).toBe(
        rootStore.aiChatSessions
      );
    });

    it("resolves to a store of the right class", () => {
      expect(sessionsStore(rootStore)).toBeInstanceOf(AIChatSessionsStore);
    });
  });
});
