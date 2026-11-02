import { autorun, runInAction } from "mobx";
import stores from "~/stores";
import type { AiChatToolCallDigest } from "~/utils/aiChat";
import AIChatMessage from "./AIChatMessage";

describe("AIChatMessage model", () => {
  const messages = stores.aiChatMessages;

  const buildMessage = (fields: Record<string, unknown>) =>
    new AIChatMessage({ id: "message-1", seq: 1, role: "assistant", ...fields }, messages);

  describe("toolCallDigest", () => {
    it("hydrates the digest from the API payload", () => {
      const digest: AiChatToolCallDigest = {
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

      const message = buildMessage({ toolCallDigest: digest });

      expect(message.toolCallDigest).toEqual(digest);
    });

    it("is absent for a turn that called no tool", () => {
      const message = buildMessage({});

      expect(message.toolCallDigest).toBeUndefined();
    });

    it("is observable so a redraw follows the digest", () => {
      const message = buildMessage({});
      const seen: (AiChatToolCallDigest | undefined)[] = [];

      const dispose = autorun(() => seen.push(message.toolCallDigest));
      runInAction(() => {
        message.toolCallDigest = { toolCalls: [{ toolCallId: "call-2" }] };
      });
      dispose();

      expect(seen).toEqual([undefined, { toolCalls: [{ toolCallId: "call-2" }] }]);
    });
  });

  describe("citationMiss", () => {
    it("defaults to unset for a turn the server did not flag", () => {
      expect(buildMessage({}).citationMiss).toBeUndefined();
    });

    it("reflects a flagged turn", () => {
      expect(buildMessage({ citationMiss: true }).citationMiss).toBe(true);
    });
  });
});
