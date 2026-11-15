export type GroupMemberRef = {
  id: string;
  name: string;
};

export function memberName(
  members: readonly { botId: string; name: string }[] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}

export function botDisplayName(
  members: readonly { botId: string; name: string }[] | undefined,
  bots: readonly { id: string; name: string }[],
  botId: string | undefined,
): string | undefined {
  return memberName(members, botId) ?? bots.find((bot) => bot.id === botId)?.name;
}

const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_-]{0,39})/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasMentionToken(text: string, name: string): boolean {
  const normalized = name.trim();
  if (!normalized) return false;
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}_-])@${escapeRegExp(normalized)}(?![\\p{L}\\p{N}_-])`,
    "iu",
  ).test(text);
}

export function parseMentionNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const name = match[1];
    if (name) names.add(name.toLowerCase());
  }
  return [...names];
}

type GroupTargetInput = {
  text: string;
  members: GroupMemberRef[];
  /** Bot ids from typed mention chips (non-members are ignored for wake). */
  explicitMentions?: string[];
};

/** Members a message names (chip, @Name or @everyone). Empty when it names nobody. */
export function mentionedGroupBotIds(input: GroupTargetInput): string[] {
  const membersById = new Map(input.members.map((member) => [member.id, member]));
  const targetIds = new Set<string>();

  for (const mentionId of input.explicitMentions ?? []) {
    // Out-of-chat bots stay as @Name in the prompt; only members are woken here.
    if (membersById.has(mentionId)) targetIds.add(mentionId);
  }

  const names = ["everyone", ...input.members.map((member) => member.name.trim())]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  // Consume each mention once so a full name cannot also wake its prefix.
  const alternatives = names.map(escapeRegExp).join("|");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_-])@(${alternatives})(?![\\p{L}\\p{N}_-])`, "giu");
  const mentions = [...input.text.matchAll(pattern)].map((match) => match[1]!);
  const isMentioned = (name: string) => {
    const exactName = new RegExp(`^${escapeRegExp(name.trim())}$`, "iu");
    return mentions.some((mention) => exactName.test(mention));
  };

  if (isMentioned("everyone")) {
    for (const member of input.members) targetIds.add(member.id);
  } else {
    for (const member of input.members) {
      if (isMentioned(member.name)) targetIds.add(member.id);
    }
  }

  return [...targetIds];
}

/** Named members wake; a message that names nobody reaches every member. */
export function resolveGroupTargetBotIds(input: GroupTargetInput): string[] {
  const mentioned = mentionedGroupBotIds(input);
  return mentioned.length > 0 ? mentioned : input.members.map((member) => member.id);
}

export function inferHandoffTargetName(prompt: string): string | undefined {
  const handoffMatch =
    /hand(?:\s+this|\s+off|\s+it)?\s+to\s+@?([A-Za-z0-9][A-Za-z0-9_-]{0,39})/i.exec(prompt) ??
    /@([A-Za-z0-9][A-Za-z0-9_-]{0,39})\s+take/i.exec(prompt);
  return handoffMatch?.[1];
}

export function inferHandoffTargetBotId(
  prompt: string,
  members: GroupMemberRef[],
): string | undefined {
  const handedTo = members.find((member) => {
    const escaped = escapeRegExp(member.name.trim());
    return escaped
      ? new RegExp(`\\bto\\s+@?${escaped}(?![\\p{L}\\p{N}_-])`, "iu").test(prompt)
      : false;
  });
  if (handedTo) return handedTo.id;
  const mentioned = members.find((member) => hasMentionToken(prompt, member.name));
  if (mentioned) return mentioned.id;
  const name = inferHandoffTargetName(prompt)?.toLowerCase();
  return name ? members.find((member) => member.name.toLowerCase() === name)?.id : undefined;
}
