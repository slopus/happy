import type { Actor } from "@rakazo/contracts";
import type { RosterChange } from "@rakazo/db";

type RosterScope = (actor: Actor, input: unknown, output: unknown) => RosterChange;

const field = (value: unknown, key: string): string | undefined => {
  const found =
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  return typeof found === "string" ? found : undefined;
};
const ids = (...values: (string | undefined)[]) => values.filter((value) => value !== undefined);

const actorSpace: RosterScope = (actor) => ({ spaceIds: [actor.spaceId] });
const actorOnly: RosterScope = (actor) => ({ userIds: [actor.userId] });
const namedSpace: RosterScope = (actor, input) => ({
  spaceIds: ids(field(input, "spaceId")),
  userIds: [actor.userId],
});

/**
 * Procedures that change what `spaces.list` returns, and who sees the change. Chat activity
 * (messages, runs, unread from a reply) reaches the roster through each chat's own events. One
 * table, so a new roster mutation is signalled by adding a line here.
 */
export const ROSTER_PROCEDURES: Record<string, RosterScope> = {
  "bots.create": actorSpace,
  "bots.importCreate": actorSpace,
  "bots.createFromTemplate": actorSpace,
  "bots.duplicate": actorSpace,
  "bots.reorder": actorSpace,
  "bots.update": actorSpace,
  "bots.restoreInstructions": actorSpace,
  "bots.setComputer": actorSpace,
  "bots.archive": actorSpace,
  "bots.restore": actorSpace,
  "bots.remove": actorSpace,
  "bots.rotateWebhookSecret": actorSpace,
  "groups.create": actorSpace,
  "groups.duplicate": actorSpace,
  "groups.update": actorSpace,
  "groups.archive": actorSpace,
  "groups.restore": actorSpace,
  "groups.remove": actorSpace,
  "botSections.create": actorSpace,
  "botSections.update": actorSpace,
  "botSections.remove": actorSpace,
  "externalConversations.updatePolicy": actorSpace,
  "organizations.create": actorOnly,
  "organizations.remove": actorOnly,
  "threads.markRead": actorOnly,
  "threads.markUnread": actorOnly,
  "threads.snooze": actorOnly,
  "spaces.create": actorOnly,
  "spaces.rename": namedSpace,
  "spaces.remove": namedSpace,
  "spaces.members.leave": namedSpace,
  "spaces.members.remove": (actor, input) => ({
    spaceIds: ids(field(input, "spaceId")),
    userIds: ids(actor.userId, field(input, "userId")),
  }),
  "spaces.invites.accept": (actor, _input, output) => ({
    spaceIds: ids(field(output, "spaceId")),
    userIds: [actor.userId],
  }),
};

export function rosterChangeFor(
  path: readonly string[],
  actor: Actor,
  input: unknown,
  output: unknown,
): RosterChange | undefined {
  return ROSTER_PROCEDURES[path.join(".")]?.(actor, input, output);
}
