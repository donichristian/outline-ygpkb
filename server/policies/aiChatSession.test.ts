import { UserRole } from "@shared/types";
import { AIChatSession } from "@server/models";
import { buildTeam, buildUser } from "@server/test/factories";
import { can, serialize } from "./index";

describe("policies/aiChatSession", () => {
  it("allows the owner to read, update and delete their session", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const session = AIChatSession.build({
      userId: user.id,
      teamId: team.id,
    });

    expect(can(user, "read", session)).toBe(true);
    expect(can(user, "update", session)).toBe(true);
    expect(can(user, "delete", session)).toBe(true);
  });

  it("does not allow another user in the same team to touch the session", async () => {
    const team = await buildTeam();
    const owner = await buildUser({ teamId: team.id });
    const other = await buildUser({ teamId: team.id });
    const session = AIChatSession.build({
      userId: owner.id,
      teamId: team.id,
    });

    expect(can(other, "read", session)).toBe(false);
    expect(can(other, "update", session)).toBe(false);
    expect(can(other, "delete", session)).toBe(false);
  });

  it("does not let a team admin reach a session they do not own", async () => {
    const team = await buildTeam();
    const owner = await buildUser({ teamId: team.id });
    const admin = await buildUser({ teamId: team.id, role: UserRole.Admin });
    const session = AIChatSession.build({
      userId: owner.id,
      teamId: team.id,
    });

    expect(can(admin, "read", session)).toBe(false);
  });

  it("grants nothing beyond the registered abilities", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const session = AIChatSession.build({
      userId: user.id,
      teamId: team.id,
    });

    // Unregistered actions stay denied even to the owner, so widening the allow
    // list is a deliberate act rather than an accident nobody notices.
    expect(can(user, "create", session)).toBe(false);
    expect(can(user, "share", session)).toBe(false);
    expect(can(user, "destroy", session)).toBe(false);
  });

  it("serializes exactly the three abilities the policy registered", async () => {
    const team = await buildTeam();
    const user = await buildUser({ teamId: team.id });
    const session = AIChatSession.build({
      userId: user.id,
      teamId: team.id,
    });

    // The exact key set is the assertion: a fourth ability added to the policy
    // shows up here even if no test happens to check that action by name.
    const abilities = serialize(user, session);

    expect(Object.keys(abilities).sort()).toEqual(["delete", "read", "update"]);
    expect(abilities.read).toBe(true);
    expect(abilities.update).toBe(true);
    expect(abilities.delete).toBe(true);
  });

  it("denies every ability once the session belongs to someone else", async () => {
    const team = await buildTeam();
    const owner = await buildUser({ teamId: team.id });
    const other = await buildUser({ teamId: team.id });
    const session = AIChatSession.build({
      userId: owner.id,
      teamId: team.id,
    });

    const abilities = serialize(other, session);

    expect(Object.keys(abilities).sort()).toEqual(["delete", "read", "update"]);
    expect(abilities.read).toBe(false);
    expect(abilities.update).toBe(false);
    expect(abilities.delete).toBe(false);
  });
});