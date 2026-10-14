import { observable } from "mobx";
import type AIChatMessagesStore from "~/stores/AIChatMessagesStore";
import AIChatSession from "./AIChatSession";
import Model from "./base/Model";
import Field from "./decorators/Field";
import Relation from "./decorators/Relation";

/** Who authored a message. */
export type AIChatMessageRole = "user" | "assistant";

/** The terminal state of a message, mirrored from the server. */
export type AIChatMessageStatus =
  | "completed"
  | "aborted"
  | "error"
  | "truncated";

/**
 * A single turn within an {@link AIChatSession}. Messages are never persisted
 * to IndexedDB – they are re-fetched from the server, cursor-paginated by
 * descending sequence, whenever a session is opened.
 */
class AIChatMessage extends Model {
  static modelName = "AIChatMessage";

  constructor(fields: Record<string, unknown>, store: AIChatMessagesStore) {
    super(fields, store);
    this.initialize(fields);
  }

  /** The monotonically increasing sequence number of this message in the session. */
  @Field
  @observable
  seq: number;

  /** Who authored the message. */
  @Field
  @observable
  role: AIChatMessageRole;

  /** The markdown content of the message. */
  @Field
  @observable
  content: string;

  /** The terminal state of the message. */
  @Field
  @observable
  status?: AIChatMessageStatus;

  /** The ID of the run that produced this message. */
  @Field
  @observable
  runId?: string;

  /**
   * The session this message belongs to. Not part of the API payload — the
   * listing store stamps the session it requested onto every message it adds,
   * so that deleting a session cascades to its messages.
   */
  sessionId: string;

  /** The session this message belongs to. */
  @Relation(() => AIChatSession, { onDelete: "cascade" })
  session: AIChatSession;

  store: AIChatMessagesStore;
}

export default AIChatMessage;
