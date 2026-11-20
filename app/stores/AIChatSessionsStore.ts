import { action, computed, observable, runInAction } from "mobx";
import invariant from "invariant";
import AIChatSession from "~/models/AIChatSession";
import { client } from "~/utils/ApiClient";
import type RootStore from "./RootStore";
import Store, { RPCAction } from "./base/Store";

/**
 * The number of sessions requested per page. The server clamps this to its own
 * hard cap, so the two never disagree about the bound.
 */
const sessionsPageSize = 100;

/**
 * The sessions of the AI assistant chat. Sessions are persisted to IndexedDB
 * so that a previously loaded conversation list is available immediately at
 * boot; a session deleted on the server or on another device cannot be
 * resurrected from the cache because `list` reconciles the local set against
 * the fetched page rather than merging into it.
 *
 * The list is paged server-side, so reconciliation is limited to the window
 * this page covered: a cached session older than the oldest row fetched may
 * still exist, and is kept rather than guessed away.
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
   * Lists one page of the current user's sessions, most recently updated first.
   *
   * Only the rows this page returned can be compared against the local set: a
   * cached session older than the page was not fetched, so its absence proves
   * nothing about deletion and it is kept. Once the server reports no further
   * pages the window is the whole list, and absent sessions are removed as
   * before.
   *
   * @returns the fetched sessions.
   */
  @action
  async list(): Promise<AIChatSession[]> {
    this.isFetching = true;

    try {
      const res = await client.post(`/${this.apiEndpoint}.list`, {
        limit: sessionsPageSize,
      });
      invariant(res?.data, "Data should be available");

      return runInAction(() => {
        this.addPolicies(res.policies);

        const sessions: AIChatSession[] = res.data.sessions ?? [];
        const hasNextPage = res.data.hasNextPage === true;

        // Rows are ordered newest first, so the last one marks the oldest
        // position this page covered. Anything below it was not fetched.
        const windowStart = sessions.length
          ? sessions[sessions.length - 1].updatedAt
          : undefined;
        const isInWindow = (updatedAt: string | undefined) =>
          !hasNextPage ||
          (updatedAt !== undefined &&
            windowStart !== undefined &&
            updatedAt >= windowStart);

        const present = new Set(sessions.map((session) => session.id));

        // A selection pointing at a session this page covered but did not
        // return no longer exists; one beyond the window may still exist, so
        // dropping it would close a conversation the user can still open.
        if (
          this.selectedSessionId !== null &&
          !present.has(this.selectedSessionId) &&
          isInWindow(this.data.get(this.selectedSessionId)?.updatedAt)
        ) {
          this.selectedSessionId = null;
        }

        // A merge would leave server-deleted sessions in place, where the
        // IndexedDB cache could hydrate them back into the list. Evict only
        // what the fetched window can prove is gone.
        Array.from(this.data.keys()).forEach((id) => {
          if (!present.has(id) && isInWindow(this.data.get(id)?.updatedAt)) {
            this.remove(id);
          }
        });

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
