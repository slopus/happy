import { chatSnoozed, chatWoke, groupBotsForSidebar } from "@rakazo/core";

type SidebarChat = {
  id: string;
  name: string;
  preview?: string | null;
  pinned: boolean;
  sectionId: string | null;
  snoozedUntil?: string | null;
};

type SidebarSpace<TBot extends SidebarChat, TGroup extends SidebarChat> = {
  id: string;
  name: string;
  canRename?: boolean;
  canDelete?: boolean;
  shared?: boolean;
  bots: readonly TBot[];
  groups: readonly TGroup[];
  botSections: readonly { id: string; name: string }[];
};

function spaceHeaderMenu(space: { canRename?: boolean; canDelete?: boolean }, hostsMenu: boolean) {
  return {
    canRenameSpace: hostsMenu && space.canRename === true,
    canDeleteSpace: hostsMenu && space.canDelete === true,
    // Every member can open a space's settings, so the menu does not depend on rename or delete.
    canOpenSpaceSettings: hostsMenu,
  };
}

export async function commitSpaceRename(input: {
  rename: () => Promise<void>;
  apply: () => void;
  refresh: () => Promise<void>;
}): Promise<void> {
  await input.rename();
  input.apply();
  await input.refresh().catch(() => undefined);
}

export function sidebarGroupsForSpaces<TBot extends SidebarChat, TGroup extends SidebarChat>(
  spaces: readonly SidebarSpace<TBot, TGroup>[],
  query: string,
  labels?: { pinned: string; unassigned: string },
  now = Date.now(),
) {
  const needle = query.toLowerCase();
  const showSpaceNames = spaces.length > 1;
  // Search still finds a snoozed chat; the list itself leaves it out until it wakes.
  const listed = (chat: SidebarChat) =>
    needle
      ? `${chat.name} ${chat.preview ?? ""}`.toLowerCase().includes(needle)
      : !chatSnoozed(chat, now);
  return spaces.flatMap((space) => {
    const visibleBots = space.bots.filter(listed);
    const visibleGroups = space.groups.filter(listed);
    const grouped = groupBotsForSidebar(
      [
        ...visibleBots.map((chat) => ({ kind: "bot" as const, chat })),
        ...visibleGroups.map((chat) => ({ kind: "group" as const, chat })),
      ].map((item) => ({
        ...item,
        id: item.chat.id,
        pinned: item.chat.pinned,
        sectionId: item.chat.sectionId,
        woke: chatWoke(item.chat, now),
      })),
      space.botSections,
      { labels },
    );
    // Keep destinations visible after their last bot is dragged out. Search
    // still hides empty lists, and spaces without sections keep their old layout.
    if (!needle && space.botSections.length > 0 && grouped.length > 0) {
      for (const section of space.botSections) {
        const key = `section:${section.id}`;
        if (!grouped.some((group) => group.key === key)) {
          grouped.push({ key, title: section.name, bots: [] });
        }
      }
      if (!grouped.some((group) => group.key === "unassigned")) {
        grouped.push({ key: "unassigned", title: labels?.unassigned ?? "Unassigned", bots: [] });
      }
      const order = [
        "pinned",
        ...space.botSections.map((section) => `section:${section.id}`),
        "unassigned",
      ];
      grouped.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    }
    const sections = grouped.map((group, index) => ({
      ...group,
      sectionId: group.key.startsWith("section:") ? group.key.slice("section:".length) : null,
      key: showSpaceNames ? `space:${space.id}:${group.key}` : group.key,
      // A header holding the space menu is never blank, even for the only space.
      title: showSpaceNames ? space.name : index === 0 && !group.title ? space.name : group.title,
      subtitle: showSpaceNames && group.title ? group.title : undefined,
      showLock: showSpaceNames,
      shared: space.shared === true,
      emptySpaceId: undefined as string | undefined,
      spaceId: space.id,
      spaceName: space.name,
      ...spaceHeaderMenu(space, index === 0),
    }));
    if (sections.length > 0) return sections;
    // Keep empty spaces selectable; chat clicks are the only switch control.
    if (needle && (space.bots.length > 0 || space.groups.length > 0)) return [];
    // Saved sections stay listed under the placeholder so they can still be
    // renamed or deleted after their last chat leaves.
    const emptySections = needle
      ? []
      : space.botSections.map((section) => ({
          key: showSpaceNames ? `space:${space.id}:section:${section.id}` : `section:${section.id}`,
          title: showSpaceNames ? space.name : section.name,
          subtitle: showSpaceNames ? section.name : undefined,
          bots: [] as (typeof sections)[number]["bots"],
          sectionId: section.id as string | null,
          showLock: showSpaceNames,
          shared: space.shared === true,
          emptySpaceId: undefined as string | undefined,
          spaceId: space.id,
          spaceName: space.name,
          ...spaceHeaderMenu(space, false),
        }));
    // A lone space is the selected one, so its settings stay in the account menu too.
    const lone = !showSpaceNames && !space.canRename && !space.canDelete;
    if (lone && (needle || emptySections.length > 0)) {
      return emptySections;
    }
    return [
      {
        key: showSpaceNames ? `space:${space.id}:empty` : `space:${space.id}:actions`,
        title: space.name,
        subtitle: undefined,
        bots: [],
        sectionId: null,
        showLock: showSpaceNames,
        shared: space.shared === true,
        emptySpaceId: showSpaceNames ? space.id : undefined,
        spaceId: space.id,
        spaceName: space.name,
        ...spaceHeaderMenu(space, true),
      },
      ...emptySections,
    ];
  });
}

/** Count the unread flags the roster renders. Pass unfiltered groups for the app badge. */
export function countUnreadChats(
  sections: readonly { bots: readonly { chat: { unread?: boolean } }[] }[],
): number {
  return sections.reduce(
    (count, section) => count + section.bots.filter((item) => item.chat.unread).length,
    0,
  );
}
