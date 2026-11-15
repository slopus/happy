import { hostNavigate } from "../../paws/runtime";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotAvatarSet, BotSection, Group, Space } from "@rakazo/contracts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Settings, Trash2 } from "lucide-react";
import type { ComponentProps, RefObject } from "react";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { PAGE_PARAM } from "../../lib/pages";
import { useSpaceQueries } from "../../lib/query";
import type { Panel } from "../../lib/right-panel-state";
import type { createSpaceRpc } from "../../lib/rpc";
import { selectSpace } from "../../lib/rpc";
import type { CommandPaletteAction } from "./command-palette";
import { CommandPalette } from "./command-palette";
import type { CreateBotDialogInput } from "./create-bot-dialog";
import { CreateBotDialog } from "./create-bot-dialog";
import {
  ClearConversationDialog,
  DeleteBotDialog,
  DeleteItemDialog,
  DeleteSpaceDialog,
  NewBotSectionDialog,
  NewSpaceDialog,
  RenameBotSectionDialog,
} from "./dialogs";

type ChatTarget = { kind: "bot"; chat: Bot } | { kind: "group"; chat: Group };
type SectionTarget = { section: BotSection; spaceId: string };

/** Which of the shell's dialogs and menus are open, and on what. */
export function useShellDialogs() {
  const [deleteTarget, setDeleteTarget] = useState<Bot | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<Group | null>(null);
  const [deleteSpaceTarget, setDeleteSpaceTarget] = useState<Space | null>(null);
  const [spaceMenu, setSpaceMenu] = useState<{
    id: string;
    position: { x: number; y: number };
  } | null>(null);
  const spaceMenuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (spaceMenu || !spaceMenuAnchor.current) return;
    spaceMenuAnchor.current.focus();
    spaceMenuAnchor.current = null;
  }, [spaceMenu]);
  const closeSpaceMenu = useCallback(() => setSpaceMenu(null), []);
  const [clearTarget, setClearTarget] = useState<ChatTarget | null>(null);
  const [newSectionTarget, setNewSectionTarget] = useState<ChatTarget | null>(null);
  const [renameSectionTarget, setRenameSectionTarget] = useState<SectionTarget | null>(null);
  const [deleteSectionTarget, setDeleteSectionTarget] = useState<SectionTarget | null>(null);
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [createBotOpen, setCreateBotOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  return {
    deleteTarget,
    setDeleteTarget,
    deleteGroupTarget,
    setDeleteGroupTarget,
    deleteSpaceTarget,
    setDeleteSpaceTarget,
    spaceMenu,
    setSpaceMenu,
    spaceMenuAnchor,
    closeSpaceMenu,
    clearTarget,
    setClearTarget,
    newSectionTarget,
    setNewSectionTarget,
    renameSectionTarget,
    setRenameSectionTarget,
    deleteSectionTarget,
    setDeleteSectionTarget,
    newSpaceOpen,
    setNewSpaceOpen,
    createBotOpen,
    setCreateBotOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
  };
}

export type ShellDialogsState = ReturnType<typeof useShellDialogs>;

/** The shell's confirmation dialogs, the space menu, and the command palette. */
export function ShellDialogs({
  dialogs,
  rpc,
  spaces,
  bots,
  activeId,
  activeGroupId,
  alive,
  navigate,
  setPanel,
  refreshBots,
  removeSpace,
  openSpaceSettings,
  closeMobileSidebar,
  createBot,
  botAvatarSet,
  clearOpenThread,
  discardChatAttachments,
  deleteRoutineDialogProps,
  paletteActions,
}: {
  dialogs: ShellDialogsState;
  rpc: ReturnType<typeof createSpaceRpc>;
  spaces: Space[];
  bots: Bot[];
  activeId: string | undefined;
  activeGroupId: string | undefined;
  alive: RefObject<boolean>;
  navigate: (path: string) => void;
  setPanel: (panel: Panel) => void;
  refreshBots: (includeArchived?: boolean) => Promise<void>;
  removeSpace: (spaceId: string) => Promise<void>;
  openSpaceSettings: (spaceId: string) => void;
  closeMobileSidebar: () => void;
  createBot: (input: CreateBotDialogInput) => Promise<void>;
  /** The account's set, which a new bot takes. */
  botAvatarSet: BotAvatarSet;
  clearOpenThread: () => void;
  /** Drops a deleted chat's pending attachments with their previews. */
  discardChatAttachments: (threadKey: string) => void;
  deleteRoutineDialogProps: ComponentProps<typeof DeleteItemDialog> | null;
  paletteActions: CommandPaletteAction[];
}) {
  const { t } = useLingui();
  const {
    deleteTarget,
    setDeleteTarget,
    deleteGroupTarget,
    setDeleteGroupTarget,
    deleteSpaceTarget,
    setDeleteSpaceTarget,
    spaceMenu,
    setSpaceMenu,
    closeSpaceMenu,
    clearTarget,
    setClearTarget,
    newSectionTarget,
    setNewSectionTarget,
    renameSectionTarget,
    setRenameSectionTarget,
    deleteSectionTarget,
    setDeleteSectionTarget,
    newSpaceOpen,
    setNewSpaceOpen,
    createBotOpen,
    setCreateBotOpen,
    commandPaletteOpen,
    setCommandPaletteOpen,
  } = dialogs;
  const spaceMenuTarget = spaceMenu
    ? (spaces.find((space) => space.id === spaceMenu.id) ?? null)
    : null;
  const queries = useSpaceQueries();
  const [pageSearch, setPageSearch] = useState("");
  const pageQuery = useDeferredValue(pageSearch.trim());
  const pages = useQuery({
    ...queries.pages.list.queryOptions({ input: pageQuery ? { query: pageQuery } : {} }),
    enabled: commandPaletteOpen,
    placeholderData: keepPreviousData,
  });
  return (
    <>
      {spaceMenu ? (
        <DropdownMenu
          open
          onOpenChange={(open) => {
            if (!open) closeSpaceMenu();
          }}
        >
          {/* Invisible anchor at the pointer position, mirroring the bot menu. */}
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                className="fixed size-0 p-0 opacity-0"
                style={{ left: spaceMenu.position.x, top: spaceMenu.position.y }}
              />
            }
          />
          <DropdownMenuContent
            aria-label={t`Actions for space`}
            align="start"
            sideOffset={0}
            className="w-[220px]"
          >
            {spaceMenuTarget ? (
              <DropdownMenuItem
                onClick={() => {
                  setSpaceMenu(null);
                  openSpaceSettings(spaceMenuTarget.id);
                }}
              >
                <Settings />
                {t`Settings`}
              </DropdownMenuItem>
            ) : null}
            {spaceMenuTarget?.canDelete ? (
              <DropdownMenuItem
                variant="destructive"
                onClick={() => {
                  setDeleteSpaceTarget(spaceMenuTarget);
                  setSpaceMenu(null);
                }}
              >
                <Trash2 />
                {t`Delete space`}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      {deleteTarget ? (
        <DeleteBotDialog
          bot={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={async (deleteMemories) => {
            await rpc.bots.remove({ botId: deleteTarget.id, deleteMemories });
            discardChatAttachments(deleteTarget.id);
            setDeleteTarget(null);
            setPanel(null);
            await refreshBots(true);
          }}
        />
      ) : null}

      {deleteGroupTarget ? (
        <DeleteItemDialog
          item={deleteGroupTarget}
          noun="group"
          onCancel={() => setDeleteGroupTarget(null)}
          onConfirm={async () => {
            await rpc.groups.remove({ groupId: deleteGroupTarget.id });
            discardChatAttachments(deleteGroupTarget.id);
            setDeleteGroupTarget(null);
            setPanel(null);
            await refreshBots(true);
          }}
        />
      ) : null}

      {deleteSpaceTarget ? (
        <DeleteSpaceDialog
          space={deleteSpaceTarget}
          onCancel={() => setDeleteSpaceTarget(null)}
          onConfirm={async () => {
            await removeSpace(deleteSpaceTarget.id);
            setDeleteSpaceTarget(null);
          }}
        />
      ) : null}

      {newSectionTarget ? (
        <NewBotSectionDialog
          bot={newSectionTarget.chat}
          onCancel={() => setNewSectionTarget(null)}
          onConfirm={async (name) => {
            await rpc.botSections.create(
              newSectionTarget.kind === "bot"
                ? { botId: newSectionTarget.chat.id, name }
                : { groupId: newSectionTarget.chat.id, name },
            );
            setNewSectionTarget(null);
            await refreshBots();
          }}
        />
      ) : null}

      {renameSectionTarget ? (
        <RenameBotSectionDialog
          section={renameSectionTarget.section}
          onCancel={() => setRenameSectionTarget(null)}
          onConfirm={async (name) => {
            await rpc.botSections.update(
              {
                sectionId: renameSectionTarget.section.id,
                name,
              },
              { context: { spaceId: renameSectionTarget.spaceId } },
            );
            setRenameSectionTarget(null);
            await refreshBots();
          }}
        />
      ) : null}

      {deleteSectionTarget ? (
        <DeleteItemDialog
          item={deleteSectionTarget.section}
          noun="section"
          description={<Trans>Its bots and groups are kept and leave the section.</Trans>}
          onCancel={() => setDeleteSectionTarget(null)}
          onConfirm={async () => {
            await rpc.botSections.remove(
              { sectionId: deleteSectionTarget.section.id },
              { context: { spaceId: deleteSectionTarget.spaceId } },
            );
            setDeleteSectionTarget(null);
            await refreshBots();
          }}
        />
      ) : null}

      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        bots={bots}
        onSelectBot={(id) => {
          closeMobileSidebar();
          navigate(`/app/${id}`);
        }}
        pages={pages.data?.items.filter((page) => page.groupId || page.botId)}
        onSearchChange={setPageSearch}
        onSelectPage={(page) => {
          closeMobileSidebar();
          const chat = page.groupId ? `/app/g/${page.groupId}` : `/app/${page.botId}`;
          navigate(`${chat}?${PAGE_PARAM}=${encodeURIComponent(page.id)}`);
        }}
        actions={paletteActions.map((action) => ({
          ...action,
          onSelect: () => {
            closeMobileSidebar();
            action.onSelect();
          },
        }))}
      />

      {createBotOpen ? (
        <CreateBotDialog
          avatarSet={botAvatarSet}
          onCancel={() => setCreateBotOpen(false)}
          onCreate={createBot}
        />
      ) : null}

      {newSpaceOpen ? (
        <NewSpaceDialog
          onCancel={() => setNewSpaceOpen(false)}
          onCreate={async (name) => (await rpc.spaces.create({ name })).id}
          loadItems={() => rpc.availability.items()}
          chooseItems={async (spaceId, items) => {
            await rpc.availability.chooseForSpace({
              spaceId,
              items: items.map(({ kind, id }) => ({ kind, id })),
            });
          }}
          onDone={(spaceId) => {
            if (!alive.current) return;
            if (!selectSpace(spaceId)) {
              setNewSpaceOpen(false);
              void refreshBots();
              return;
            }
            hostNavigate("/onboarding");
          }}
        />
      ) : null}

      {clearTarget ? (
        <ClearConversationDialog
          bot={clearTarget.chat}
          onCancel={() => setClearTarget(null)}
          onConfirm={async () => {
            await rpc.threads.clear(
              clearTarget.kind === "bot"
                ? { botId: clearTarget.chat.id }
                : { groupId: clearTarget.chat.id },
            );
            if (
              (clearTarget.kind === "bot" && activeId === clearTarget.chat.id) ||
              (clearTarget.kind === "group" && activeGroupId === clearTarget.chat.id)
            ) {
              clearOpenThread();
            }
            setClearTarget(null);
            await refreshBots();
          }}
        />
      ) : null}

      {deleteRoutineDialogProps ? <DeleteItemDialog {...deleteRoutineDialogProps} /> : null}
    </>
  );
}
