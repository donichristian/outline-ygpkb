import { subDays } from "date-fns";
import type { User } from "@server/models";
import AIChatMessage, { AIChatMessageRole } from "@server/models/AIChatMessage";
import AIChatSession from "@server/models/AIChatSession";
import { buildUser } from "@server/test/factories";
import { errToString } from "@shared/utils/error";
import userPermanentDeleter from "./userPermanentDeleter";

/**
 * Builds a session owned by the given user, with two messages.
 *
 * @param user the owner of the session.
 * @returns the created session.
 */
async function buildSessionWithMessages(user: User) {
  const session = await AIChatSession.create({
    teamId: user.teamId,
    userId: user.id,
    title: "Session",
  });
  await AIChatMessage.create({
    sessionId: session.id,
    role: AIChatMessageRole.User,
    seq: 1,
    content: "Hello",
  });
  await AIChatMessage.create({
    sessionId: session.id,
    role: AIChatMessageRole.Assistant,
    seq: 2,
    content: "Hi",
  });
  return session;
}

/**
 * Counts the sessions owned by a user, and the messages of the given sessions.
 *
 * Messages are counted by their own session id rather than through a join so
 * that a surviving message row is still counted after its session is gone –
 * that is what makes the cascade assertion meaningful.
 *
 * @param user the owner of the sessions.
 * @param sessionIds the sessions whose messages should be counted.
 * @returns the number of sessions and messages found.
 */
async function countRows(user: User, sessionIds: string[]) {
  return {
    sessions: await AIChatSession.count({ where: { userId: user.id } }),
    messages: await AIChatMessage.count({ where: { sessionId: sessionIds } }),
  };
}

describe("userPermanentDeleter", () => {
  it("should destroy ai chat sessions and cascade their messages", async () => {
    const user = await buildUser({ deletedAt: subDays(new Date(), 90) });
    const session = await buildSessionWithMessages(user);
    expect(await countRows(user, [session.id])).toEqual({
      sessions: 1,
      messages: 2,
    });

    await userPermanentDeleter(user);

    expect(await countRows(user, [session.id])).toEqual({
      sessions: 0,
      messages: 0,
    });
  });

  it("should not destroy sessions belonging to other users", async () => {
    const deleted = await buildUser({ deletedAt: subDays(new Date(), 90) });
    const other = await buildUser();
    const deletedSession = await buildSessionWithMessages(deleted);
    const otherSession = await buildSessionWithMessages(other);

    await userPermanentDeleter(deleted);

    expect(await countRows(deleted, [deletedSession.id])).toEqual({
      sessions: 0,
      messages: 0,
    });
    expect(await countRows(other, [otherSession.id])).toEqual({
      sessions: 1,
      messages: 2,
    });
  });

  it("should error when trying to destroy an undeleted user", async () => {
    const user = await buildUser();
    const session = await buildSessionWithMessages(user);
    let error;

    try {
      await userPermanentDeleter(user);
    } catch (err) {
      error = errToString(err);
    }

    expect(error).toEqual(
      `Cannot permanently delete ${user.id} user. Please delete it and try again.`
    );
    expect(await countRows(user, [session.id])).toEqual({
      sessions: 1,
      messages: 2,
    });
  });

  it("should be idempotent", async () => {
    const user = await buildUser({ deletedAt: subDays(new Date(), 90) });
    const session = await buildSessionWithMessages(user);

    await userPermanentDeleter(user);
    await expect(userPermanentDeleter(user)).resolves.not.toThrow();

    expect(await countRows(user, [session.id])).toEqual({
      sessions: 0,
      messages: 0,
    });
  });

  it("should not throw for a deleted user without sessions", async () => {
    const user = await buildUser({ deletedAt: subDays(new Date(), 90) });

    await expect(userPermanentDeleter(user)).resolves.not.toThrow();
  });
});
