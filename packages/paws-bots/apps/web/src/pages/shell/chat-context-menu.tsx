import type { Bot, BotSection, Group } from "@rakazo/contracts";
import { chatSnoozed } from "@rakazo/core";
import { ContextMenu } from "@rakazo/ui-web";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Suspense, useEffect } from "react";
import { lazyOverlay } from "../../components/ErrorBoundary";
import type { createSpaceRpc } from "../../lib/rpc";
import type { ShellDialogsState } from "./shell-dialogs";
import type { useChatRead } from "./use-chat-read";
import type { SnoozeChat } from "./use-chat-snooze";

const BotContextMenu = lazyOverlay(() =>
  import("../BotContextMenu").then((module) => module.BotContextMenu),
);

type ChatRead = ReturnType<typeof useChatRead>;

export type ChatMenuTarget = { kind: "bot" | "group"; id: string };

/** Which chat's right-click menu is open, shared by the roster and search results. */
export type ChatMenuState = {
  menu: ChatMenuTarget | null;
  setMenu: Dispatch<SetStateAction<ChatMenuTarget | null>>;
  content: ReactNode;
  /** Whether the menu can act on this chat. */
  has: (target: ChatMenuTarget) => boolean;
};

/** Opens the shared chat menu when its trigger child is right-clicked. */
export function ChatMenu({
  target,
  state,
  disabled,
  children,
}: {
  target: ChatMenuTarget;
  state: ChatMenuState;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { menu, setMenu, content } = state;
  const { kind, id } = target;
  const open = menu?.kind === kind && menu.id === id;
  // The menu doesn't report closing when it unmounts open, such as when new search results
  // replace this row; release it so it can't reopen on its own later.
  useEffect(() => {
    if (!open) return;
    return () =>
      setMenu((current) => (current?.kind === kind && current.id === id ? null : current));
  }, [open, kind, id, setMenu]);
  return (
    <ContextMenu
      disabled={disabled}
      open={open}
      // A sibling row's menu may already own the state; only clear our own.
      onOpenChange={(next) =>
        setMenu((current) =>
          next ? { kind, id } : current?.kind === kind && current.id === id ? null : current,
        )
      }
    >
      {children}
      {open ? <Suspense fallback={null}>{content}</Suspense> : null}
    </ContextMenu>
  );
}

/** The right-click menu for a bot or group in the roster or search results. */
export function ChatContextMenu({
  rpc,
  bot,
  group,
  sections,
  spaceId,
  onClose,
  refreshBots,
  read,
  snooze,
  dialogs,
  openChatSettings,
  navigate,
}: {
  rpc: ReturnType<typeof createSpaceRpc>;
  bot: Bot | undefined;
  group: Group | undefined;
  sections: BotSection[];
  spaceId: string | undefined;
  onClose: () => void;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  read: Pick<ChatRead, "markBotRead" | "markBotUnread" | "toggleGroupUnread">;
  snooze: SnoozeChat;
  dialogs: ShellDialogsState;
  openChatSettings: (kind: "bot" | "group", id: string) => void;
  navigate: (path: string) => void;
}) {
  const chat = bot ?? group;
  if (!chat) return null;
  const target = bot
    ? { kind: "bot" as const, chat: bot }
    : { kind: "group" as const, chat: group! };
  return (
    <BotContextMenu
      bot={chat}
      onClose={onClose}
      sections={sections}
      onTogglePinned={() => {
        onClose();
        const request = bot
          ? rpc.bots.update({ botId: bot.id, pinned: !bot.pinned })
          : rpc.groups.update({
              groupId: group!.id,
              pinned: !group!.pinned,
            });
        void request.then(() => refreshBots());
      }}
      onToggleUnread={() => {
        const unread = !chat.unread;
        onClose();
        if (bot) {
          const request = unread ? read.markBotUnread(bot.id) : read.markBotRead(bot.id);
          void request.catch(() => undefined);
        } else {
          read.toggleGroupUnread(group!.id, unread);
        }
      }}
      snoozed={chatSnoozed({ snoozedUntil: chat.snoozedUntil }, Date.now())}
      onSnooze={(until) => {
        onClose();
        snooze({ kind: target.kind, ...chat }, until);
      }}
      onMoveToSection={(sectionId) => {
        onClose();
        if (sectionId === chat.sectionId) return;
        const request = bot
          ? rpc.bots.update({ botId: bot.id, sectionId })
          : rpc.groups.update({ groupId: group!.id, sectionId });
        void request.then(() => refreshBots());
      }}
      onCreateSection={() => {
        dialogs.setNewSectionTarget(target);
        onClose();
      }}
      onRenameSection={(sectionId) => {
        const section = sections.find((item) => item.id === sectionId);
        if (section && spaceId) dialogs.setRenameSectionTarget({ section, spaceId });
        onClose();
      }}
      onEdit={() => {
        openChatSettings(bot ? "bot" : "group", chat.id);
        onClose();
      }}
      onDuplicate={() => {
        onClose();
        const request = bot
          ? rpc.bots.duplicate({ botId: bot.id })
          : rpc.groups.duplicate({ groupId: group!.id });
        void request.then(async (copy) => {
          await refreshBots();
          navigate(bot ? `/app/${copy.id}` : `/app/g/${copy.id}`);
        });
      }}
      onClear={() => {
        dialogs.setClearTarget(target);
        onClose();
      }}
      onArchive={() => {
        onClose();
        const request = bot
          ? rpc.bots.archive({ botId: bot.id })
          : rpc.groups.archive({ groupId: group!.id });
        void request.then(() => refreshBots(true));
      }}
      onDelete={() => {
        if (bot) dialogs.setDeleteTarget(bot);
        else dialogs.setDeleteGroupTarget(group!);
        onClose();
      }}
    />
  );
}
