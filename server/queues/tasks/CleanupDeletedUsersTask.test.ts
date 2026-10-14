import { subDays } from "date-fns";
import { Minute } from "@shared/utils/time";
import type { User } from "@server/models";
import { AIChatMessage, AIChatSession } from "@server/models";
import { AIChatMessageRole } from "@server/models/AIChatMessage";
import { buildUser } from "@server/test/factories";
import { TaskPriority } from "./base/BaseTask";
import { TaskInterval } from "./base/CronTask";
import CleanupDeletedTeamsTask from "./CleanupDeletedTeamsTask";
import CleanupDeletedUsersTask from "./CleanupDeletedUsersTask";

const props = {
  limit: 1000,
  partition: {
    partitionIndex: 0,
    partitionCount: 1,
  },
};

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

describe("CleanupDeletedUsersTask", () => {
  it("should run hourly with the same partition window as the sibling cleanup task", () => {
    const { cron } = new CleanupDeletedUsersTask();

    expect(cron.interval).toBe(TaskInterval.Hour);
    expect(cron.partitionWindow).toBe(15 * Minute.ms);
    expect(cron).toEqual(new CleanupDeletedTeamsTask().cron);
  });

  it("should run once at background priority", () => {
    expect(new CleanupDeletedUsersTask().options).toEqual({
      attempts: 1,
      priority: TaskPriority.Background,
    });
  });

  it("should purge ai chat data of users deleted more than 30 days ago", async () => {
    const user = await buildUser({ deletedAt: subDays(new Date(), 45) });
    const session = await buildSessionWithMessages(user);
    expect(await AIChatSession.count({ where: { userId: user.id } })).toBe(1);

    await new CleanupDeletedUsersTask().perform(props);

    expect(await AIChatSession.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await AIChatMessage.count({ where: { sessionId: session.id } })
    ).toBe(0);
  });

  it("should not purge ai chat data of users deleted less than 30 days ago", async () => {
    const user = await buildUser({ deletedAt: subDays(new Date(), 5) });
    await buildSessionWithMessages(user);

    await new CleanupDeletedUsersTask().perform(props);

    expect(await AIChatSession.count({ where: { userId: user.id } })).toBe(1);
  });

  it("should not purge ai chat data of users that are not deleted", async () => {
    const user = await buildUser();
    await buildSessionWithMessages(user);

    await new CleanupDeletedUsersTask().perform(props);

    expect(await AIChatSession.count({ where: { userId: user.id } })).toBe(1);
  });
});
