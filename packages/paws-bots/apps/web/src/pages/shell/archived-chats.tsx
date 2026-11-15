import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, Group } from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  GroupAvatar,
} from "@rakazo/ui-web";
import { ArchiveRestore, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { createSpaceRpc } from "../../lib/rpc";
import { SidebarShelf } from "./sidebar-shelf";

/** Archived chats folded at the bottom of the sidebar; Restore on hover, Delete on right-click. */
export function ArchivedChats({
  archivedBots,
  archivedGroups,
  showSpaceSearch,
  rpc,
  refreshBots,
  setDeleteTarget,
  setDeleteGroupTarget,
}: {
  archivedBots: Bot[];
  archivedGroups: Group[];
  showSpaceSearch: boolean;
  rpc: ReturnType<typeof createSpaceRpc>;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  setDeleteTarget: (bot: Bot) => void;
  setDeleteGroupTarget: (group: Group) => void;
}) {
  const { t } = useLingui();
  if (archivedBots.length + archivedGroups.length === 0 || showSpaceSearch) return null;
  const row = (
    key: string,
    name: string,
    avatar: ReactNode,
    restore: () => Promise<unknown>,
    remove: () => void,
  ) => {
    const onRestore = () => void restore().then(() => refreshBots(true));
    return (
      <ContextMenu key={key}>
        <ContextMenuTrigger className="group/shelf flex items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-sidebar-accent">
          {avatar}
          <span className="min-w-0 flex-1 truncate text-body text-foreground/75" dir="auto">
            {name}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="sr-only focus-visible:not-sr-only group-hover/shelf:not-sr-only"
            aria-label={t`Restore ${name}`}
            onClick={onRestore}
          >
            <Trans>Restore</Trans>
          </Button>
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={t`Actions for ${name}`} className="w-[180px]">
          <ContextMenuItem onClick={onRestore}>
            <ArchiveRestore />
            <Trans>Restore</Trans>
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={remove}>
            <Trash2 />
            <Trans>Delete</Trans>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };
  return (
    <SidebarShelf
      title={<Trans>Archived</Trans>}
      count={archivedBots.length + archivedGroups.length}
    >
      {archivedBots.map((bot) =>
        row(
          `bot:${bot.id}`,
          bot.name,
          <BotAvatar
            avatarSet={bot.avatarSet}
            color={bot.color}
            identity={bot.id}
            size={28}
            status={bot.status}
          />,
          () => rpc.bots.restore({ botId: bot.id }),
          () => setDeleteTarget(bot),
        ),
      )}
      {archivedGroups.map((group) =>
        row(
          `group:${group.id}`,
          group.name,
          <GroupAvatar members={group.members} size={28} />,
          () => rpc.groups.restore({ groupId: group.id }),
          () => setDeleteGroupTarget(group),
        ),
      )}
    </SidebarShelf>
  );
}
