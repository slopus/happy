import type { MessageBlock } from "@rakazo/contracts";
import { botMessageContext } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { loadMessageAuthors } from "@rakazo/db";

/** What the model reads for the person of a personal space: never their real name. */
export const USER_SPEAKER = "User";
/** Label for a bot whose record is gone, so its messages are still not mistaken for the receiver's own. */
export const UNKNOWN_BOT_SPEAKER = "another bot";

/**
 * A bot's name as it appears in a label: one line, no brackets (so a name cannot close or fake
 * a `[Name]:` label), and never the human's label (a bot called "user" reads as "User (bot)").
 */
export function speakerName(name: string): string {
  const clean = labelText(name);
  if (!clean) return UNKNOWN_BOT_SPEAKER;
  return clean.toLowerCase() === USER_SPEAKER.toLowerCase() ? `${USER_SPEAKER} (bot)` : clean;
}

/** A display name is free text; a label only needs to tell people apart. */
const PERSON_NAME_MAX = 64;

/**
 * A person's name as it appears in a label in a space several people share: the same cleaning
 * as a bot's, so a name cannot fake another speaker's label.
 */
export function personSpeakerName(name: string): string {
  // Cut by character, not UTF-16 unit, so an emoji at the limit is never split.
  return Array.from(labelText(name)).slice(0, PERSON_NAME_MAX).join("").trim() || USER_SPEAKER;
}

/** One line with no brackets, so a name can never close or fake a `[Name]:` label. */
function labelText(name: string): string {
  return name
    .replace(/[[\]]/g, (bracket) => (bracket === "[" ? "(" : ")"))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Labels for the people of a space several people share, by user id: the runner and every author
 * in `rows`, former members included. Null in a personal space, whose prompts never name anyone.
 */
export async function loadSpacePeople(
  prisma: Pick<PrismaClient, "user">,
  memberCount: number,
  runnerUserId: string,
  rows: Array<{ authorUserId?: string | null }>,
): Promise<Map<string, string> | null> {
  if (memberCount < 2) return null;
  const authors = await loadMessageAuthors(prisma, [
    runnerUserId,
    ...rows.map((row) => row.authorUserId),
  ]);
  return new Map([...authors].map(([id, author]) => [id, personSpeakerName(author.name)]));
}

/** The label of a person's line: their name in a shared space, otherwise "User". */
export function personSpeaker(
  people: ReadonlyMap<string, string> | null | undefined,
  userId: string | null | undefined,
): string {
  return (userId && people?.get(userId)) || USER_SPEAKER;
}

/**
 * A line that starts like a `[Name]:` label, with the brackets swapped for parentheses, so text
 * inside a message cannot pose as another speaker's turn once turns are joined.
 */
export function neutralizeSpeakerLabels(text: string): string {
  return text.replace(/^([ \t]*)\[([^\]\n]*)\]:/gm, "$1($2):");
}

/**
 * Who is speaking in a group thread or a space several people share, from the receiving bot's
 * side. A direct chat in a personal space has no speakers: the bot and the user are the only two
 * parties there, so roles say it all.
 */
export interface ThreadSpeakers {
  /** The receiving bot; its own messages stay unlabelled assistant turns. */
  botId: string;
  /** Current names of the other bots, archived ones included. A renamed bot has one name everywhere. */
  names: Map<string, string>;
  /** People's labels by user id in a shared space; without them every person is "User". */
  people?: ReadonlyMap<string, string> | null;
}

type SpeakerRow = {
  role: string;
  botId?: string | null;
  authorUserId?: string | null;
  blocks?: unknown;
};

/** Names for bot ids in the space, deleted bots simply absent. No archived filter on purpose. */
export async function loadBotNames(
  prisma: Pick<PrismaClient, "bot">,
  spaceId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const bots = await prisma.bot.findMany({
    where: { id: { in: ids }, spaceId },
    select: { id: true, name: true },
  });
  return new Map(bots.map((bot) => [bot.id, speakerName(bot.name)]));
}

/** Null for a direct chat in a personal space, which needs neither labels nor a lookup. */
export async function loadThreadSpeakers(
  prisma: Pick<PrismaClient, "bot">,
  thread: { groupId?: string | null },
  run: { spaceId: string; bot: { id: string } },
  rows: SpeakerRow[],
  people?: ReadonlyMap<string, string> | null,
): Promise<ThreadSpeakers | null> {
  if (!thread.groupId && !people) return null;
  const others = new Set(
    rows.flatMap((row) =>
      row.role === "bot" && row.botId && row.botId !== run.bot.id ? [row.botId] : [],
    ),
  );
  return {
    botId: run.bot.id,
    names: await loadBotNames(prisma, run.spaceId, [...others]),
    ...(people ? { people } : {}),
  };
}

/**
 * The label of a person's line. A messaging group's line names its own sender inside the text
 * and stores no author, since that sender may not belong to the Space, so it stays "User".
 */
export function personLineSpeaker(
  people: ReadonlyMap<string, string> | null | undefined,
  row: { authorUserId?: string | null; blocks?: unknown },
): string {
  return isChannelMessage(row.blocks) ? USER_SPEAKER : personSpeaker(people, row.authorUserId);
}

function isChannelMessage(blocks: unknown): boolean {
  return Array.isArray(blocks) && blocks.some((block) => block?.kind === "channel_message");
}

function isRelay(blocks: unknown): boolean {
  return Array.isArray(blocks) && Boolean(botMessageContext(blocks as MessageBlock[]));
}

/**
 * The label a message carries in the receiving bot's history, or undefined for an unlabelled one:
 * the bot's own replies, system rows, and a relayed peer message, which already says `[from X]`.
 * Another bot is named even after it was archived; once its record is gone it is "another bot".
 * Two bots with the same name share a label; the roster the model reads lists them apart.
 */
export function historySpeaker(
  speakers: ThreadSpeakers | null | undefined,
  row: SpeakerRow,
): string | undefined {
  if (!speakers) return undefined;
  if (row.role === "user")
    return isRelay(row.blocks) ? undefined : personLineSpeaker(speakers.people, row);
  if (row.role !== "bot" || !row.botId || row.botId === speakers.botId) return undefined;
  return speakers.names.get(row.botId) ?? UNKNOWN_BOT_SPEAKER;
}
