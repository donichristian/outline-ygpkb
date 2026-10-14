import { AIChatSession } from "@server/models";
import type { User } from "@server/models";
import type { APIContext } from "@server/types";

type Props = {
  /** The user the session belongs to. */
  user: User;
  /** A title for the session, derived from the first message when omitted. */
  title?: string;
  /** The request context, supplying the transaction to write within. */
  ctx: APIContext;
};

/**
 * Creates an empty AI chat session owned by the given user. The session is
 * only visible to that user, a session belonging to another user in the same
 * team is not their session.
 *
 * @param props the session owner and request context.
 * @returns the created session.
 */
export default async function aiChatSessionCreator({
  user,
  title,
  ctx,
}: Props) {
  return AIChatSession.createWithCtx(ctx, {
    teamId: user.teamId,
    userId: user.id,
    title: title ?? null,
  });
}
