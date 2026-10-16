import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  BelongsTo,
  Column,
  DataType,
  Default,
  ForeignKey,
  Table,
} from "sequelize-typescript";
import AIChatSession from "./AIChatSession";
import IdModel from "./base/IdModel";

/**
 * Who authored a message in the conversation.
 */
export enum AIChatMessageRole {
  User = "user",
  Assistant = "assistant",
}

/**
 * How a message finished being written.
 */
export enum AIChatMessageStatus {
  /** The message was generated in full. */
  Completed = "completed",
  /** The user stopped generation before it finished. */
  Aborted = "aborted",
  /** Generation failed, `content` holds whatever was produced before it. */
  Error = "error",
  /** Generation hit an output limit, `content` holds the partial result. */
  Truncated = "truncated",
}

/**
 * A single turn of an AI chat session.
 *
 * Authorization is deliberately not carried on this model: a message has no
 * owner of its own, it is owned by its session, so permission is always
 * resolved through {@link AIChatSession}.
 */
@Table({ tableName: "ai_chat_messages", modelName: "ai_chat_message" })
class AIChatMessage extends IdModel<
  InferAttributes<AIChatMessage>,
  Partial<InferCreationAttributes<AIChatMessage>>
> {
  /**
   * Who authored the message.
   */
  @Column(DataType.ENUM(...Object.values(AIChatMessageRole)))
  role: AIChatMessageRole;

  /**
   * Position of the message within its session, starting at 1. Unique per
   * session, which is what makes a row-locked append safe under concurrency.
   */
  @Column(DataType.INTEGER)
  seq: number;

  /**
   * The message text. For a non-completed status this holds whatever was
   * produced before generation stopped.
   */
  @Column(DataType.TEXT)
  content: string;

  /**
   * How the message finished being written.
   */
  @Default(AIChatMessageStatus.Completed)
  @Column(DataType.ENUM(...Object.values(AIChatMessageStatus)))
  status: AIChatMessageStatus;

  /**
   * Identifies the generation run that produced this message, when known.
   */
  @Column(DataType.UUID)
  runId: string | null;

  // associations

  @BelongsTo(() => AIChatSession, "sessionId")
  session: AIChatSession;

  @ForeignKey(() => AIChatSession)
  @Column(DataType.UUID)
  sessionId: string;
}

export default AIChatMessage;