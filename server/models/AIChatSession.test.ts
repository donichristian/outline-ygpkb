import { withAPIContext } from "@server/test/support";
import { buildTeam, buildUser } from "@server/test/factories";
import type { User } from "@server/models";
import AIChatMessage, {
  AIChatMessageRole,
  AIChatMessageStatus,
} from "./AIChatMessage";
import AIChatSession from "./AIChatSession";

/**
 * Builds a session owned by the given user.
 */
function buildSession(user: User) {
  return AIChatSession.create({
    teamId: user.teamId,
    userId: user.id,
    title: "Session",
  });
}

describe("AIChatSession.findOwned", () => {
  it("returns the session for the user that owns it", async () => {
    const user = await buildUser();
    const session = await buildSession(user);

    const found = await withAPIContext(user, (ctx) =>
      AIChatSession.findOwned(ctx, session.id, user)
    );

    expect(found?.id).toEqual(session.id);
  });

  it("returns null for a session owned by another user in the same team", async () => {
    const team = await buildTeam();
    const owner = await buildUser({ teamId: team.id });
    const other = await buildUser({ teamId: team.id });
    const session = await buildSession(owner);

    const found = await withAPIContext(other, (ctx) =>
      AIChatSession.findOwned(ctx, session.id, other)
    );

    expect(found).toBeNull();
  });

  it("returns null for a session owned by a user in another team", async () => {
    const owner = await buildUser();
    const other = await buildUser();
    const session = await buildSession(owner);

    const found = await withAPIContext(other, (ctx) =>
      AIChatSession.findOwned(ctx, session.id, other)
    );

    expect(found).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    const user = await buildUser();

    const found = await withAPIContext(user, (ctx) =>
      AIChatSession.findOwned(
        ctx,
        "8b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b",
        user
      )
    );

    expect(found).toBeNull();
  });
});

describe("AIChatMessage", () => {
  it("defaults status to completed and keeps its sequence position", async () => {
    const user = await buildUser();
    const session = await buildSession(user);

    const message = await AIChatMessage.create({
      sessionId: session.id,
      role: AIChatMessageRole.User,
      seq: 1,
      content: "Hello",
    });

    expect(message.status).toEqual(AIChatMessageStatus.Completed);
    expect(message.runId).toBeNull();
  });

  it("loads in order through the session messages relation", async () => {
    const user = await buildUser();
    const session = await buildSession(user);

    await AIChatMessage.bulkCreate([
      {
        sessionId: session.id,
        role: AIChatMessageRole.User,
        seq: 1,
        content: "Hello",
      },
      {
        sessionId: session.id,
        role: AIChatMessageRole.Assistant,
        seq: 2,
        content: "Hi",
        status: AIChatMessageStatus.Truncated,
      },
    ]);

    const found = await AIChatSession.findByPk(session.id, {
      include: [{ model: AIChatMessage, as: "messages" }],
    });

    expect(found?.messages).toHaveLength(2);
    expect(found?.messages[0].content).toEqual("Hello");
    expect(found?.messages[1].status).toEqual(AIChatMessageStatus.Truncated);
  });

  it("rejects a duplicate sequence number within a session", async () => {
    const user = await buildUser();
    const session = await buildSession(user);

    await AIChatMessage.create({
      sessionId: session.id,
      role: AIChatMessageRole.User,
      seq: 1,
      content: "Hello",
    });

    await expect(
      AIChatMessage.create({
        sessionId: session.id,
        role: AIChatMessageRole.User,
        seq: 1,
        content: "Hello again",
      })
    ).rejects.toThrow();
  });
});