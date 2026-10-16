import { AIChatSession, User } from "@server/models";
import { allow } from "./cancan";
import { isOwner } from "./utils";

// A session belongs to exactly one user, and only that user may read, rename or
// delete it. Messages deliberately have no policy of their own — a message has
// no owner column, so authorization for one is resolved through its session.
allow(User, ["read", "update", "delete"], AIChatSession, isOwner);