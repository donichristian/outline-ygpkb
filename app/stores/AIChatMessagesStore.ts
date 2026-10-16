import { action, runInAction } from "mobx";
import invariant from "invariant";
import AIChatMessage from "~/models/AIChatMessage";
import { client } from "~/utils/ApiClient";
import type RootStore from "./RootStore";
import Store, { RPCAction } from "./base/Store";

/** Parameters accepted when listing the messages of a session. */
export type AIChatMessagesListParams = {
  /** The session to read messages for. */
  sessionId: string;
  /** Return messages with a lower sequence, for paginating older turns. */
  beforeSeq?: number;
};

/** A page of messages, plus the cursor to read older turns with. */
export type AIChatMessagesPage = {
  messages: AIChatMessage[];
  /** Whether older messages were dropped from the server's window. */
  truncated: boolean;
  /** The sequence to pass as `beforeSeq` for the next older page. */
  cursor?: number;
};

/**
 * The messages of AI assistant chat sessions.
 *
 * This store is deliberately never persisted to IndexedDB: hydrating messages
 * from a cache resurrects the messages of a deleted session and double-renders
 * a conversation that has since been re-fetched. Messages are cheap to re-read
 * from the server and are only ever needed while a session is open.
 *
 * `Info` is deliberately omitted from `actions`: a single-message fetch is not
 * part of the API, so `Store.fetch(id)` throws loudly rather than issuing a
 * request that would 404.
 */
export default class AIChatMessagesStore extends Store<AIChatMessage> {
  constructor(rootStore: RootStore) {
    super(rootStore, AIChatMessage);
  }

  /** The RPC endpoint these actions are requested from. */
  apiEndpoint = "ai.messages";

  /** The key under which messages appear in mixed API responses. */
  responseKey = "messages";

  /** Messages are re-fetched on demand and never written to IndexedDB. */
  persistable = false;

  actions = [RPCAction.List];

  /**
   * Fetches a page of a session's messages, newest first. Messages are added
   * rather than replaced, so walking the cursor backwards accumulates the
   * conversation in the store.
   *
   * @param params the session to read, and an optional sequence cursor.
   * @returns the fetched messages, with the server's truncation flag and cursor.
   */
  @action
  async list(params: AIChatMessagesListParams): Promise<AIChatMessagesPage> {
    this.isFetching = true;

    try {
      const res = await client.post(`/${this.apiEndpoint}.list`, params);
      invariant(res?.data, "Data should be available");

      return runInAction(() => {
        this.addPolicies(res.policies);

        // The session is not part of the payload, so it is stamped onto every
        // message — deleting a session cascades through it to its messages.
        const messages: AIChatMessage[] = (res.data.messages ?? []).map(
          (message: AIChatMessage) =>
            this.add({ ...message, sessionId: params.sessionId })
        );

        this.isLoaded = true;
        return {
          messages,
          truncated: res.data.truncated ?? false,
          cursor: res.data.cursor,
        };
      });
    } finally {
      runInAction(() => {
        this.isFetching = false;
      });
    }
  }
}
