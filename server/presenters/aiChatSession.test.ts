import AIChatMessage, {
  AIChatMessageRole,
  AIChatMessageStatus,
} from "@server/models/AIChatMessage";
import AIChatSession from "@server/models/AIChatSession";
import { presentAIChatMessage, presentAIChatSession } from "@server/presenters";

describe("presentAIChatSession", () => {
  it("presents the documented session shape", () => {
    const now = new Date();
    const session = AIChatSession.build({
      id: "session-1",
      title: "Roadmap review",
      userId: "user-1",
      teamId: "team-1",
      createdAt: now,
      updatedAt: now,
    });

    expect(presentAIChatSession(session)).toEqual({
      id: "session-1",
      title: "Roadmap review",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("keeps a null title rather than coercing it", () => {
    const session = AIChatSession.build({ title: null });

    expect(presentAIChatSession(session).title).toBeNull();
  });

  it("does not leak ownership internals", () => {
    const session = AIChatSession.build({
      id: "session-1",
      userId: "user-1",
      teamId: "team-1",
    });

    const result = presentAIChatSession(session);

    expect(Object.keys(result)).not.toContain("teamId");
    expect(Object.keys(result)).not.toContain("userId");
    expect(Object.keys(result).sort()).toEqual([
      "createdAt",
      "id",
      "title",
      "updatedAt",
    ]);
  });
});

describe("presentAIChatMessage", () => {
  it("presents the documented message shape", () => {
    const now = new Date();
    const message = AIChatMessage.build({
      id: "message-1",
      seq: 1,
      role: AIChatMessageRole.Assistant,
      content: "Here is the summary.",
      status: AIChatMessageStatus.Completed,
      runId: "run-1",
      sessionId: "session-1",
      createdAt: now,
    });

    expect(presentAIChatMessage(message)).toEqual({
      id: "message-1",
      seq: 1,
      role: "assistant",
      content: "Here is the summary.",
      status: "completed",
      runId: "run-1",
      toolCallDigest: undefined,
      citationMiss: false,
      createdAt: now,
    });
  });

  it("returns the body-free digest and the citation-miss flag", () => {
    const digest = {
      toolCalls: [
        {
          toolCallId: "call-1",
          toolName: "fetch_document",
          documentIds: ["doc-1"],
          titles: ["Onboarding"],
          characterCount: 120,
          truncated: false,
        },
      ],
    };
    const message = AIChatMessage.build({
      id: "message-1",
      seq: 1,
      role: AIChatMessageRole.Assistant,
      content: "See Onboarding.",
      status: AIChatMessageStatus.Completed,
      toolCallDigest: digest,
      citationMiss: true,
    });

    expect(presentAIChatMessage(message).toolCallDigest).toEqual(digest);
    expect(presentAIChatMessage(message).citationMiss).toBe(true);
  });

  it("keeps a null runId rather than coercing it", () => {
    const message = AIChatMessage.build({ runId: null });

    expect(presentAIChatMessage(message).runId).toBeNull();
  });

  it("does not leak ownership internals", () => {
    const message = AIChatMessage.build({
      id: "message-1",
      sessionId: "session-1",
    });

    const result = presentAIChatMessage(message);

    expect(Object.keys(result)).not.toContain("teamId");
    expect(Object.keys(result)).not.toContain("userId");
    expect(Object.keys(result).sort()).toEqual([
      "citationMiss",
      "content",
      "createdAt",
      "id",
      "role",
      "runId",
      "seq",
      "status",
      "toolCallDigest",
    ]);
  });
});