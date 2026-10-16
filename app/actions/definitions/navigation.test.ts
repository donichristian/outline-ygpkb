import { TeamPreference } from "@shared/types";
import { resolve } from "~/actions";
import type { ActionContext } from "~/types";
import { openAIChat, rootNavigationActions } from "./navigation";

/**
 * Builds the smallest `ActionContext` the `openAIChat` action reads from –
 * only `stores.auth.team.getPreference` is exercised by its `visible`
 * predicate, so the remainder of the context is stubbed.
 *
 * @param aiChatEnabled whether the workspace AI chat preference is on.
 * @returns a context shaped like the one the command bar supplies.
 */
function fakeContext(aiChatEnabled: boolean): ActionContext {
  const team = {
    getPreference: (key: TeamPreference) =>
      key === TeamPreference.AIChat ? aiChatEnabled : false,
  };

  return {
    stores: { auth: { team } },
  } as unknown as ActionContext;
}

function isVisible(context: ActionContext): boolean {
  return resolve<boolean>(openAIChat.visible, context) === true;
}

describe("openAIChat action", () => {
  it("is registered in rootNavigationActions so it surfaces in the command bar", () => {
    expect(rootNavigationActions).toContain(openAIChat);
  });

  it("is hidden when the workspace AI chat preference is off", () => {
    expect(isVisible(fakeContext(false))).toBe(false);
  });

  it("is visible when the workspace AI chat preference is on", () => {
    expect(isVisible(fakeContext(true))).toBe(true);
  });

  it("is hidden when there is no current team", () => {
    const context = {
      stores: { auth: { team: undefined } },
    } as unknown as ActionContext;
    expect(isVisible(context)).toBe(false);
  });
});
