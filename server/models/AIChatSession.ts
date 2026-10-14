import type { Context } from "koa";
import type { InferAttributes, InferCreationAttributes } from "sequelize";
import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  HasMany,
  Table,
} from "sequelize-typescript";
import type { APIContext } from "@server/types";
import AIChatMessage from "./AIChatMessage";
import Team from "./Team";
import User from "./User";
import IdModel from "./base/IdModel";

/**
 * A conversation between a single user and the assistant.
 *
 * Sessions are scoped to the user that started them and to that user's team,
 * so every read has to resolve ownership through {@link AIChatSession.findOwned}
 * rather than a bare `findByPk`.
 */
@Table({ tableName: "ai_chat_sessions", modelName: "ai_chat_session" })
class AIChatSession extends IdModel<
  InferAttributes<AIChatSession>,
  Partial<InferCreationAttributes<AIChatSession>>
> {
  // static methods

  /**
   * Finds a session only when it belongs to the given user in the user's team.
   * A mismatch is not an error, it is simply not their session.
   *
   * @param ctx the request context, supplying the transaction to read within.
   * @param id the id of the session to find.
   * @param user the user the session must belong to.
   * @returns the session, or null when no row matches.
   */
  public static async findOwned(
    ctx: Context | APIContext,
    id: string,
    user: User
  ): Promise<AIChatSession | null> {
    return this.findOne({
      where: {
        id,
        userId: user.id,
        teamId: user.teamId,
      },
      transaction: ctx.state.transaction,
    });
  }

  // columns

  /**
   * The user-supplied name of the conversation, null until one is given.
   */
  @Column(DataType.STRING)
  title: string | null;

  // associations

  @BelongsTo(() => Team, "teamId")
  team: Team;

  @ForeignKey(() => Team)
  @Column(DataType.UUID)
  teamId: string;

  @BelongsTo(() => User, "userId")
  user: User;

  @ForeignKey(() => User)
  @Column(DataType.UUID)
  userId: string;

  @HasMany(() => AIChatMessage, "sessionId")
  messages: AIChatMessage[];
}

export default AIChatSession;