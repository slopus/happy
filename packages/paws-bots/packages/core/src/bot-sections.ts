export type BotListSection<T> = {
  key: string;
  title: string | null;
  bots: T[];
};

type Section = { id: string; name: string };
type SectionedBot = { pinned: boolean; sectionId: string | null };

export function groupBotsForSidebar<T extends SectionedBot>(
  bots: readonly T[],
  sections: readonly Section[],
  options: { includeEmptySections?: boolean; labels?: { pinned: string; unassigned: string } } = {},
): BotListSection<T>[] {
  const knownSectionIds = new Set(sections.map((section) => section.id));
  const pinned: T[] = [];
  const sectionMembers = new Map<string, T[]>();
  const unassigned: T[] = [];
  const grouped: BotListSection<T>[] = [];

  for (const bot of bots) {
    if (bot.pinned) {
      pinned.push(bot);
    } else if (bot.sectionId && knownSectionIds.has(bot.sectionId)) {
      const members = sectionMembers.get(bot.sectionId) ?? [];
      members.push(bot);
      sectionMembers.set(bot.sectionId, members);
    } else {
      unassigned.push(bot);
    }
  }

  if (pinned.length > 0) {
    grouped.push({ key: "pinned", title: options.labels?.pinned ?? "Pinned", bots: pinned });
  }
  for (const section of sections) {
    const members = sectionMembers.get(section.id) ?? [];
    if (members.length > 0 || options.includeEmptySections) {
      grouped.push({ key: `section:${section.id}`, title: section.name, bots: members });
    }
  }
  if (unassigned.length > 0) {
    grouped.push({
      key: "unassigned",
      title:
        pinned.length > 0 || sections.length > 0
          ? (options.labels?.unassigned ?? "Unassigned")
          : null,
      bots: unassigned,
    });
  }

  return grouped;
}

export function reorderBotTo<T extends { id: string }>(
  bots: readonly T[],
  sourceId: string,
  targetId: string,
): readonly T[] {
  const sourceIndex = bots.findIndex((bot) => bot.id === sourceId);
  const targetIndex = bots.findIndex((bot) => bot.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return bots;
  const reordered = [...bots];
  const [source] = reordered.splice(sourceIndex, 1);
  if (!source) return bots;
  reordered.splice(targetIndex, 0, source);
  return reordered;
}
