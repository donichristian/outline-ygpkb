import { action, computed, observable, runInAction } from "mobx";
import invariant from "invariant";
import AIChatSession from "~/models/AIChatSession";
import { client } from "~/utils/ApiClient";
import type RootStore from "./RootStore";
import Store, { RPCAction } from "./base/Store";

/**
 * The sessions of the AI assistant chat. Sessions are persisted to IndexedDB
 * so that a previously loaded conversation list is available immediately at
 * boot; because `list` replaces the local set rather than merging into it, a
 * session deleted on the server or on another device cannot be resurrected
 * from the cache.
 *
 * `Info` is deliberately omitted from `actions`: a single-session fetch is not
 * part of the API, so `Store.fetch(id)` throws loudly rather than issuing a
 * request that would 404.
 */
export default class AIChatSessionsStore extends Store<AIChatSession> {
  constructor(rootStore: RootStore) {
    super(rootStore, AIChatSession);
  }

  /** The RPC endpoint these actions are requested from. */
  apiEndpoint = "ai.sessions";

  /** The key under which sessions appear in mixed API responses. */
  responseKey = "sessions";

  /** Whether IndexedDB persistence is enabled for this store. */
  persistable = true;

  actions = [RPCAction.List, RPCAction.Create, RPCAction.Delete];

  /**
   * The conversation the chat panel is currently showing, or `null` when it is
   * composing a new one.
   *
   * This lives on the store rather than in the panel because the panel is
   * unmounted the moment it is closed, and a selection held in component state
   * dies with it — leaving a reopen on an empty conversation and forcing the
   * user to re-pick the conversation they had just been reading. The store
   * outlives the panel, so the choice survives the close. Auto-selecting
   * `sessionsByRecency[0]` instead would tie the open conversation to
   * recency: any turn sent in another session would silently move the user out
   * of the one they chose.
   */
  @observable
  selectedSessionId: string | null = null;

  /**
   * Points the chat panel at a conversation, or at a new one when `null`.
   *
   * @param id the session to show, or null to start a new conversation.
   */
  @action
  setSelectedSessionId(id: string | null): void {
    this.selectedSessionId = id;
  }

  /**
   * Lists every session belonging to the current user and replaces the local
   * set with the result. Sessions absent from the response are removed rather
   * than left in place, so that a session deleted on the server or on another
   * device (or restored from the IndexedDB cache at boot) is not resurrected.
   *
   * @returns the fetched sessions.
   */
  @action
  async list(): Promise<AIChatSession[]> {
    this.isFetching = true;

    try {
      const res = await client.post(`/${this.apiEndpoint}.list`);
      invariant(res?.data, "Data should be available");

      return runInAction(() => {
        this.addPolicies(res.policies);

        const sessions: AIChatSession[] = res.data.sessions ?? [];

        // A merge would leave server-deleted sessions in place, where the
        // IndexedDB cache could hydrate them back into the list.
        Array.from(this.data.keys()).forEach((id) => {
          if (!sessions.some((session) => session.id === id)) {
            this.remove(id);
          }
        });

        // A selection pointing at a session this response did not return would
        // otherwise leave the panel reading a conversation that no longer
        // exists. Drop it with the session so the panel falls back to a new one.
        if (
          this.selectedSessionId !== null &&
          !sessions.some((session) => session.id === this.selectedSessionId)
        ) {
          this.selectedSessionId = null;
        }

        this.isLoaded = true;
        return sessions.map((session) => this.add(session));
      });
    } finally {
      runInAction(() => {
        this.isFetching = false;
      });
    }
  }

  /**
   * The sessions ordered by the most recently updated first. This is the order
   * a conversation list needs, and differs from the inherited `orderedData`,
   * which sorts by `createdAt` and would surface a long-running conversation
   * that was just continued below a newer, inactive one.
   */
  @computed
  get sessionsByRecency(): AIChatSession[] {
    return Array.from(this.data.values()).sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : -1
    );
  }
}
