import { t } from "@lingui/core/macro";
import { botDisplayName } from "@rakazo/core";

type NamedBot = {
  id: string;
  name: string;
};

/**
 * Name for one group-transcript author. Current members win, then bots still in
 * the space, then archived bots. A bot in none of those keeps its own header.
 * A direct chat has no member roster and no speaker header.
 */
export function resolveTranscriptMemberName({
  botId,
  members,
  bots,
  archivedBots,
}: {
  botId: string | undefined;
  /** Absent in a 1:1 chat, where the transcript draws no speaker header. */
  members: readonly { botId: string; name: string }[] | undefined;
  bots: readonly NamedBot[];
  archivedBots: readonly NamedBot[];
}): string | undefined {
  if (members === undefined) return undefined;
  const current = botDisplayName(members, bots, botId);
  if (current !== undefined) return current;
  if (!botId) return undefined;
  return nameOf(archivedBots, botId) ?? t`Deleted bot`;
}

function nameOf(bots: readonly NamedBot[], botId: string): string | undefined {
  return bots.find((bot) => bot.id === botId)?.name;
}
