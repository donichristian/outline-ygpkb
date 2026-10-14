import { observable } from "mobx";
import type AIChatSessionsStore from "~/stores/AIChatSessionsStore";
import Model from "./base/Model";
import Field from "./decorators/Field";

/**
 * A conversation between the current user and the AI assistant. Sessions are
 * owned by a single user and are not shared between teammates.
 *
 * The messages of a session are not related from here. They are loaded
 * separately, cursor-paginated, whenever a session is opened, and are removed
 * from the store through the inverse `AIChatMessage.session` relation.
 */
class AIChatSession extends Model {
  static modelName = "AIChatSession";

  constructor(fields: Record<string, unknown>, store: AIChatSessionsStore) {
    super(fields, store);
    this.initialize(fields);
  }

  /** The title of the conversation, shown in the session list. */
  @Field
  @observable
  title: string;

  store: AIChatSessionsStore;
}

export default AIChatSession;
