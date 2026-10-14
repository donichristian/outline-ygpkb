import { createContext } from "@server/context";
import Logger from "@server/logging/Logger";
import { Event, AIChatSession } from "@server/models";
import type { User } from "@server/models";
import AIChatMessage, {
  AIChatMessageRole,
  AIChatMessageStatus,
} from "@server/models/AIChatMessage";
import { buildTeam, buildUser } from "@server/test/factories";
import { withAPIContext } from "@server/test/support";
import type { APIContext } from "@server/types";
import aiChatMessageCreator from "./aiChatMessageCreator";
import aiChatSessionCreator from "./aiChatSessionCreator";
import aiChatSessionDestroyer from "./aiChatSessionDestroyer";

/**
 * Builds a committed session. It must be committed before a message is
 * appended, as the append locks its row from a separate connection.
 */
function buildSession(user: User) {
  return withAPIContext(user, (ctx) => aiChatSessionCreator({ user, ctx }));
}

/**
 * Builds a context shaped like the one the streaming route uses, which does
 * not run the transaction middleware.
 */
function buildStreamingCtx(user: User): APIContext {
  return {
    ...createContext({ user }),
    request: { ip: "127.0.0.1" },
  } as APIContext;
}

function append(user: User, sessionId: string, content: string) {
  return aiChatMessageCreator({
    user,
    sessionId,
    role: AIChatMessageRole.User,
    content,
    ctx: buildStreamingCtx(user),
  });
}

function messagesIn(sessionId: string) {
  return AIChatMessage.findAll({
    where: { sessionId },
    order: [["seq", "ASC"]],
  });
}

describe("aiChatMessageCreator", () => {
  it("assigns the next sequence number to each turn", async () => {
    const user = await buildUser();
    const session = await buildSession(user);

    const first = await append(user, session.id, "What is Outline?");
    const second = await append(user, session.id, "What is a collection?");

    expect(first.seq).toEqual(1);
    expect(second.seq).toEqual(2);
    expect(await messagesIn(session.id)).toHaveLength(2);
  });

  it("advances the session updatedAt", async () => {
    const user = await buildUser();
    const session = await buildSession(user);
    const before = session.updatedAt.getTime();

    await append(user, session.id, "Hello");

    await session.reload();
    expect(session.updatedAt.getTime()).toBeGreaterThan(before);
  });

  it("titles the session from the first turn only", async () => {
    const user = await buildUser();
    const session = await buildSession(user);

    await append(user, session.id, "What is Outline?");
    await session.reload();
    expect(session.title).toEqual("What is Outline?");

    await append(user, session.id, "What is a collection?");
    await session.reload();
    expect(session.title).toEqual("What is Outline?");
  });

  it("truncates a derived title to the column width", async () => {
    const user = await buildUser();
    const session = await buildSession(user);

    await append(user, session.id, "a".repeat(300));
    await session.reload();

    expect(session.title).toHaveLength(255);
  });

  it("keeps a title given at creation", async () => {
    const user = await buildUser();
    const session = await withAPIContext(user, (ctx) =>
      aiChatSessionCreator({ user, ctx, title: "My chat" })
    );

    await append(user, session.id, "What is Outline?");
    await session.reload();

    expect(session.title).toEqual("My chat");
  });

  it("writes nothing for a session owned by another user", async () => {
    const owner = await buildUser();
    const session = await buildSession(owner);
    const other = await buildUser();
    const before = session.updatedAt.getTime();

    await expect(append(other, session.id, "Let me in")).rejects.toThrow(
      "Resource not found"
    );

    await session.reload();
    expect(await messagesIn(session.id)).toHaveLength(0);
    expect(session.title).toBeNull();
    expect(session.updatedAt.getTime()).toEqual(before);
  });

  it("writes nothing for a session owned by a user in another team", async () => {
    const owner = await buildUser();
    const session = await buildSession(owner);
    const team = await buildTeam();
    const other = await buildUser({ teamId: team.id });

    await expect(append(other, session.id, "Let me in")).rejects.toThrow(
      "Resource not found"
    );

    expect(await messagesIn(session.id)).toHaveLength(0);
  });

  it("gives concurrent appends to one session distinct sequence numbers", async () => {
    const user = await buildUser();
    const session = await buildSession(user);

    await Promise.all([
      append(user, session.id, "first"),
      append(user, session.id, "second"),
    ]);

    const messages = await messagesIn(session.id);
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((message) => message.seq))).toEqual(
      new Set([1, 2])
    );
    expect(messages.map((message) => message.content).sort()).toEqual([
      "first",
      "second",
    ]);
  });

  it("locks the session row for update before reading the next sequence number", async () => {
    const user = await buildUser();
    const session = await buildSession(user);
    const findByPk = vi.spyOn(AIChatSession, "findByPk");

    try {
      await append(user, session.id, "Hello");

      expect(findByPk).toHaveBeenCalledTimes(1);
      expect(findByPk.mock.calls[0][0]).toEqual(session.id);
      expect(findByPk.mock.calls[0][1]).toMatchObject({
        lock: "UPDATE",
        rejectOnEmpty: true,
      });
    } finally {
      findByPk.mockRestore();
    }
  });

  it("writes the message inside the transaction", async () => {
    const user = await buildUser();
    const session = await buildSession(user);
    const warnSpy = vi.spyOn(Logger, "warn").mockImplementation(() => {});

    try {
      const message = await append(user, session.id, "Hello");

      expect(
        warnSpy.mock.calls.filter(
          ([warning]) => warning === "No transaction provided to insertEvent"
        )
      ).toHaveLength(0);

      const event = await Event.findOne({ where: { modelId: message.id } });
      expect(event?.name).toEqual("ai_chat_messages.create");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("defaults the status to completed and the run to none", async () => {
    const user = await buildUser();
    const session = await buildSession(user);

    const message = await append(user, session.id, "Hello");

    expect(message.status).toEqual(AIChatMessageStatus.Completed);
    expect(message.runId).toBeNull();
  });
});

describe("aiChatSessionCreator", () => {
  it("creates an empty session owned by the user and records it", async () => {
    const user = await buildUser();

    const session = await buildSession(user);

    expect(session.userId).toEqual(user.id);
    expect(session.teamId).toEqual(user.teamId);
    expect(session.title).toBeNull();
    expect(await messagesIn(session.id)).toHaveLength(0);

    const event = await Event.findOne({ where: { modelId: session.id } });
    expect(event?.name).toEqual("ai_chat_sessions.create");
  });
});

describe("aiChatSessionDestroyer", () => {
  it("deletes the session and cascades its messages", async () => {
    const user = await buildUser();
    const session = await buildSession(user);
    await append(user, session.id, "Hello");

    await withAPIContext(user, (ctx) =>
      aiChatSessionDestroyer({ session, ctx })
    );

    expect(await AIChatSession.findByPk(session.id)).toBeNull();
    expect(await messagesIn(session.id)).toHaveLength(0);
  });
});
