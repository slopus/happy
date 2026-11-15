import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, BotSection, Group, Me, Space, ThreadSnapshot } from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  GroupAvatar,
} from "@rakazo/ui-web";
import {
  ChevronDown,
  CircleAlert,
  Lock,
  MoreHorizontal,
  Pencil,
  Trash2,
  Users,
} from "lucide-react";
import type { RefObject } from "react";
import { IconTooltip } from "../../components/IconTooltip";
import type { BotsSidebarDensity } from "../../lib/bots-sidebar-density-pref";
import {
  compactRosterStatusLabel,
  rosterHasUndismissedRunError,
  rosterWorkStatusLabel,
} from "../../lib/roster-status";
import type { ChatMenuState } from "./chat-context-menu";
import { ChatMenu } from "./chat-context-menu";
import type { RosterDropAction, RosterDropTarget } from "./roster-drop";
import type { sidebarGroupsForSpaces } from "./space-sidebar";
import { useRedrawAtMidnight } from "./use-redraw-at-midnight";

export function SidebarRoster({
  sidebarGroups,
  collapsedSidebarSections,
  bootstrapMe,
  botSections,
  spaces,
  rosterDropKey,
  setRosterDropKey,
  rosterDropAction,
  applyRosterDrop,
  openSpaceChat,
  spaceMenuAnchor,
  setSpaceMenu,
  setRenameSectionTarget,
  setDeleteSectionTarget,
  toggleSidebarSection,
  inGroup,
  active,
  activeGroup,
  botsSidebarDensity,
  dismissedRunErrorIds,
  displayedRunError,
  draggedBotId,
  setDraggedBotId,
  chatMenu,
  reorderRosterBot,
  activeSnapshot,
  mini = false,
}: {
  sidebarGroups: ReturnType<
    typeof sidebarGroupsForSpaces<Space["bots"][number], Space["groups"][number]>
  >;
  collapsedSidebarSections: ReadonlySet<string>;
  bootstrapMe: Pick<Me, "spaceId"> | null | undefined;
  botSections: BotSection[];
  spaces: Space[];
  rosterDropKey: string | null;
  setRosterDropKey: (key: string | null) => void;
  rosterDropAction: (target: RosterDropTarget, sameList: boolean) => RosterDropAction | null;
  applyRosterDrop: (target: RosterDropTarget, sameList: boolean, botIds: string[]) => void;
  openSpaceChat: (spaceId: string, path: string) => void;
  spaceMenuAnchor: RefObject<HTMLElement | null>;
  setSpaceMenu: (menu: { id: string; position: { x: number; y: number } }) => void;
  setRenameSectionTarget: (target: { section: BotSection; spaceId: string }) => void;
  setDeleteSectionTarget: (target: { section: BotSection; spaceId: string }) => void;
  toggleSidebarSection: (key: string) => void;
  inGroup: boolean;
  active: Pick<Bot, "id"> | undefined;
  activeGroup: Pick<Group, "id"> | undefined;
  botsSidebarDensity: BotsSidebarDensity;
  dismissedRunErrorIds: ReadonlySet<string>;
  displayedRunError: string | null;
  draggedBotId: string | null;
  setDraggedBotId: (id: string | null) => void;
  chatMenu: ChatMenuState;
  reorderRosterBot: (sourceId: string, targetId: string, groupBotIds: string[]) => void;
  activeSnapshot: ThreadSnapshot | null;
  mini?: boolean;
}) {
  useRedrawAtMidnight();
  const { t } = useLingui();
  return (
    <>
      {sidebarGroups.map((group, groupIndex) => {
        const collapsed = Boolean(group.title) && collapsedSidebarSections.has(group.key);
        const groupBotIds = group.bots.flatMap((item) =>
          item.kind === "bot" ? [item.chat.id] : [],
        );
        const hasSpaceActions = group.canOpenSpaceSettings;
        const headerDropTarget: RosterDropTarget | null =
          group.spaceId === bootstrapMe?.spaceId &&
          !group.emptySpaceId &&
          (group.sectionId || group.key.endsWith("unassigned"))
            ? { kind: "section", sectionId: group.sectionId }
            : null;
        const headerDropKey = `header:${group.key}`;
        const section = group.sectionId
          ? (group.spaceId === bootstrapMe?.spaceId
              ? botSections
              : (spaces.find((space) => space.id === group.spaceId)?.botSections ?? [])
            ).find((item) => item.id === group.sectionId)
          : undefined;
        return (
          <Collapsible
            key={group.key}
            open={mini || !collapsed}
            onOpenChange={() => {
              if (!mini) toggleSidebarSection(group.key);
            }}
            data-sidebar-group={group.key}
            className={`flex flex-col gap-0.5 ${mini && groupIndex > 0 ? "mt-2 border-t border-sidebar-border pt-2" : ""}`}
          >
            {!mini && (group.title || hasSpaceActions) ? (
              // biome-ignore lint/a11y/useSemanticElements: groups sidebar controls, not form fields; Move to remains the keyboard alternative.
              <div
                role="group"
                data-roster-drop={rosterDropKey === headerDropKey ? "true" : undefined}
                className={`${
                  group.title && hasSpaceActions
                    ? "grid pt-3 pb-0.5"
                    : `flex items-center pt-3 pb-0.5${group.title ? "" : " justify-end"}`
                } rounded-lg ${rosterDropKey === headerDropKey ? "bg-sidebar-accent" : ""}`}
                onDragOver={(event) => {
                  if (!headerDropTarget || !rosterDropAction(headerDropTarget, false)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (rosterDropKey !== headerDropKey) setRosterDropKey(headerDropKey);
                }}
                onDragLeave={() => {
                  if (rosterDropKey === headerDropKey) setRosterDropKey(null);
                }}
                onDrop={(event) => {
                  if (!headerDropTarget) return;
                  event.preventDefault();
                  applyRosterDrop(headerDropTarget, false, groupBotIds);
                }}
              >
                {group.title ? (
                  // Prefer the section menu over the space menu when both apply;
                  // the dedicated space-actions button still opens the space menu.
                  <ContextMenu disabled={!section}>
                    <ContextMenuTrigger
                      render={
                        group.emptySpaceId ? <button type="button" /> : <CollapsibleTrigger />
                      }
                      className={`flex min-w-0 items-center justify-between gap-2 rounded-lg px-2.5 py-1 text-label font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring ${hasSpaceActions ? "col-start-1 row-start-1 w-full" : "flex-1"}`}
                      onClick={() => {
                        if (group.emptySpaceId) {
                          openSpaceChat(group.emptySpaceId, "/onboarding");
                        }
                      }}
                      onContextMenu={
                        section
                          ? (event) => event.currentTarget.focus()
                          : hasSpaceActions
                            ? (event) => {
                                event.preventDefault();
                                spaceMenuAnchor.current = event.currentTarget;
                                setSpaceMenu({
                                  id: group.spaceId,
                                  position: { x: event.clientX, y: event.clientY },
                                });
                              }
                            : undefined
                      }
                      aria-label={
                        group.emptySpaceId
                          ? t`Open ${headerName(group)}`
                          : collapsed
                            ? t`Expand ${headerName(group)}`
                            : t`Collapse ${headerName(group)}`
                      }
                    >
                      <span
                        className={`flex min-w-0 items-center gap-1.5 truncate ${hasSpaceActions ? "pe-7" : ""}`}
                      >
                        {group.showLock ? (
                          group.shared ? (
                            <Users size={11} strokeWidth={2} aria-hidden="true" />
                          ) : (
                            <Lock size={11} strokeWidth={2} aria-hidden="true" />
                          )
                        ) : null}
                        <span className="truncate">{group.title}</span>
                        {group.subtitle ? (
                          <span className="ms-0.5 truncate text-muted-foreground">
                            {group.subtitle}
                          </span>
                        ) : null}
                      </span>
                      {group.emptySpaceId ? null : (
                        <ChevronDown
                          size={14}
                          strokeWidth={1.8}
                          className={
                            collapsed ? "-rotate-90 transition-transform" : "transition-transform"
                          }
                          aria-hidden="true"
                        />
                      )}
                    </ContextMenuTrigger>
                    {section ? (
                      <ContextMenuContent
                        aria-label={t`Actions for ${section.name}`}
                        className="w-[220px]"
                      >
                        <ContextMenuItem
                          onClick={() =>
                            setRenameSectionTarget({ section, spaceId: group.spaceId })
                          }
                        >
                          <Pencil />
                          {t`Rename section`}
                        </ContextMenuItem>
                        <ContextMenuItem
                          variant="destructive"
                          onClick={() =>
                            setDeleteSectionTarget({ section, spaceId: group.spaceId })
                          }
                        >
                          <Trash2 />
                          {t`Delete section`}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    ) : null}
                  </ContextMenu>
                ) : null}
                {hasSpaceActions ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={
                      group.title
                        ? `col-start-1 row-start-1 justify-self-end self-center ${group.emptySpaceId ? "" : "me-6"}`
                        : undefined
                    }
                    aria-label={t`Actions for ${group.spaceName}`}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      spaceMenuAnchor.current = event.currentTarget;
                      setSpaceMenu({
                        id: group.spaceId,
                        position: { x: rect.left, y: rect.bottom },
                      });
                    }}
                  >
                    <MoreHorizontal size={14} aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            ) : null}
            <CollapsibleContent className="flex flex-col gap-0.5">
              {group.bots.map((item) => {
                const selected =
                  (item.kind === "bot" && !inGroup && active?.id === item.chat.id) ||
                  (item.kind === "group" && inGroup && activeGroup?.id === item.chat.id);
                const compact = botsSidebarDensity === "compact";
                const workStatusLabel =
                  item.kind === "bot" ? rosterWorkStatusLabel(item.chat.status) : null;
                const rowError =
                  item.kind === "bot" &&
                  (rosterHasUndismissedRunError(item.chat.runErrorId, dismissedRunErrorIds) ||
                    (active?.id === item.chat.id && Boolean(displayedRunError)));
                const compactStatusLabel =
                  (compact || mini) && item.kind === "bot"
                    ? rowError
                      ? t`Error`
                      : compactRosterStatusLabel(item.chat.status)
                    : null;
                const rosterLine = compact
                  ? compactStatusLabel
                  : (workStatusLabel ??
                    (item.kind === "bot"
                      ? item.chat.preview || (item.chat.status !== "idle" ? item.chat.status : "")
                      : item.chat.preview ||
                        item.chat.members.map((member) => member.name).join(", ")));
                const rowDropTarget: RosterDropTarget | null =
                  item.chat.spaceId !== bootstrapMe?.spaceId
                    ? null
                    : item.kind === "bot"
                      ? { kind: "bot", chat: item.chat }
                      : {
                          kind: "group",
                          chat: {
                            id: item.chat.id,
                            memberIds: item.chat.members.map((member) => member.botId),
                          },
                        };
                const rowSameList =
                  Boolean(draggedBotId) && groupBotIds.includes(draggedBotId ?? "");
                const rowDropKey = `row:${item.kind}:${item.chat.id}`;
                const avatar =
                  item.kind === "bot" ? (
                    <BotAvatar
                      avatarSet={item.chat.avatarSet}
                      color={item.chat.color}
                      identity={item.chat.id}
                      size={mini ? 40 : compact ? 28 : 38}
                      status={item.chat.status}
                    />
                  ) : (
                    <GroupAvatar
                      members={
                        item.chat.id === activeSnapshot?.groupId
                          ? (activeSnapshot.members ?? item.chat.members)
                          : item.chat.members
                      }
                      size={mini ? 40 : compact ? 28 : 38}
                    />
                  );
                const chatTrigger = (
                  <ContextMenuTrigger
                    render={<button type="button" />}
                    draggable={item.kind === "bot"}
                    data-roster-bot-id={item.kind === "bot" ? item.chat.id : undefined}
                    data-roster-unread={item.chat.unread ? "true" : undefined}
                    data-roster-error={rowError && (compact || mini) ? "true" : undefined}
                    aria-current={selected ? "page" : undefined}
                    aria-label={mini ? item.chat.name : undefined}
                    aria-describedby={
                      mini
                        ? [
                            item.chat.unread ? `roster-unread-${item.kind}-${item.chat.id}` : null,
                            compactStatusLabel
                              ? `roster-status-${item.kind}-${item.chat.id}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined
                        : undefined
                    }
                    aria-keyshortcuts={
                      item.kind === "bot" ? "Alt+ArrowUp Alt+ArrowDown" : undefined
                    }
                    onDragStart={(event) => {
                      if (item.kind !== "bot") return;
                      setDraggedBotId(item.chat.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.chat.id);
                    }}
                    onDragOver={(event) => {
                      if (!rowDropTarget || !rosterDropAction(rowDropTarget, rowSameList)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      if (rosterDropKey !== rowDropKey) setRosterDropKey(rowDropKey);
                    }}
                    onDragLeave={() => {
                      if (rosterDropKey === rowDropKey) setRosterDropKey(null);
                    }}
                    onDrop={(event) => {
                      if (!rowDropTarget) return;
                      event.preventDefault();
                      applyRosterDrop(rowDropTarget, rowSameList, groupBotIds);
                    }}
                    onDragEnd={() => {
                      setDraggedBotId(null);
                      setRosterDropKey(null);
                    }}
                    data-roster-drop={rosterDropKey === rowDropKey ? "true" : undefined}
                    onKeyDown={(event) => {
                      if (
                        item.kind !== "bot" ||
                        !event.altKey ||
                        (event.key !== "ArrowUp" && event.key !== "ArrowDown")
                      )
                        return;
                      const siblings = groupBotIds;
                      const index = siblings.indexOf(item.chat.id);
                      const target = siblings[index + (event.key === "ArrowUp" ? -1 : 1)];
                      if (!target) return;
                      event.preventDefault();
                      reorderRosterBot(item.chat.id, target, groupBotIds);
                    }}
                    onClick={() => {
                      openSpaceChat(
                        item.chat.spaceId,
                        item.kind === "bot" ? `/app/${item.chat.id}` : `/app/g/${item.chat.id}`,
                      );
                    }}
                    // Focus the row so closing the menu returns focus here.
                    onContextMenu={(event) => event.currentTarget.focus()}
                    className={`flex items-center ${
                      mini
                        ? "mx-auto size-12 justify-center rounded-xl"
                        : compact
                          ? "w-full min-h-11 gap-2 rounded-xl px-2.5 py-1.5"
                          : "w-full gap-3 rounded-xl px-2.5 py-[10px]"
                    } text-start ${
                      item.kind === "bot" ? "cursor-grab active:cursor-grabbing" : ""
                    } ${
                      selected || rosterDropKey === rowDropKey
                        ? "bg-sidebar-accent"
                        : "group-hover/row:bg-accent"
                    }`}
                  >
                    {mini ? (
                      <span className="relative shrink-0">
                        {avatar}
                        {rowError ? (
                          <span
                            aria-hidden="true"
                            className="absolute -end-0.5 bottom-0 size-2 rounded-full bg-destructive ring-2 ring-sidebar"
                          />
                        ) : null}
                        {compactStatusLabel ? (
                          <span
                            className="sr-only"
                            id={`roster-status-${item.kind}-${item.chat.id}`}
                          >
                            {compactStatusLabel}
                          </span>
                        ) : null}
                        {item.chat.unread ? (
                          <>
                            <span
                              aria-hidden="true"
                              data-roster-unread-dot
                              className="absolute -end-0.5 top-0 size-2 rounded-full bg-unread ring-2 ring-sidebar"
                            />
                            <span
                              id={`roster-unread-${item.kind}-${item.chat.id}`}
                              className="sr-only"
                            >
                              <Trans> (unread)</Trans>
                            </span>
                          </>
                        ) : null}
                      </span>
                    ) : (
                      avatar
                    )}
                    {!mini ? (
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1.5">
                          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                            <span
                              dir="auto"
                              data-roster-bot-name={item.kind === "bot" ? "" : undefined}
                              className={`max-w-full shrink-0 truncate text-body-sm text-foreground ${
                                item.chat.unread ? "font-semibold" : "font-medium"
                              }`}
                            >
                              {item.chat.name}
                            </span>
                            {item.chat.unread ? (
                              <span className="sr-only">
                                <Trans> (unread)</Trans>
                              </span>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {item.woke ? (
                              <span
                                data-roster-woke
                                className="text-label font-medium text-foreground/75"
                              >
                                <Trans>Woke</Trans>
                              </span>
                            ) : !compact ? (
                              <span
                                data-roster-time
                                className="text-label text-faint-foreground tabular-nums"
                              >
                                {formatRosterTime(item.chat.updatedAt)}
                              </span>
                            ) : null}
                            {item.chat.unread ? (
                              <span
                                aria-hidden="true"
                                data-roster-unread-dot
                                className="inline-block h-2 w-2 rounded-full bg-unread"
                              />
                            ) : null}
                          </div>
                        </div>
                        {compact ? (
                          compactStatusLabel ? (
                            <div
                              dir="auto"
                              data-roster-status={
                                rowError
                                  ? "error"
                                  : item.kind === "bot"
                                    ? item.chat.status
                                    : undefined
                              }
                              className={`mt-0.5 flex items-center gap-1 text-label ${
                                rowError
                                  ? "font-medium text-destructive"
                                  : workStatusLabel
                                    ? "font-semibold text-status-working"
                                    : "font-medium text-foreground/75"
                              }`}
                            >
                              {rowError ? <CircleAlert size={12} aria-hidden="true" /> : null}
                              <span>{compactStatusLabel}</span>
                            </div>
                          ) : null
                        ) : (
                          <div
                            dir="auto"
                            data-roster-preview={!workStatusLabel ? "true" : undefined}
                            className={`mt-1 truncate text-label ${
                              workStatusLabel
                                ? "font-semibold text-status-working"
                                : item.chat.unread
                                  ? "font-medium text-foreground/75"
                                  : "text-muted-foreground"
                            }`}
                          >
                            {rosterLine}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </ContextMenuTrigger>
                );
                return (
                  <div
                    key={`${item.kind}:${item.chat.id}`}
                    className="group/row relative"
                    style={{
                      opacity: item.kind === "bot" && draggedBotId === item.chat.id ? 0.55 : 1,
                    }}
                  >
                    <ChatMenu
                      target={{ kind: item.kind, id: item.chat.id }}
                      state={chatMenu}
                      disabled={item.chat.spaceId !== bootstrapMe?.spaceId}
                    >
                      {mini ? (
                        <IconTooltip
                          side="inline-end"
                          label={
                            compactStatusLabel
                              ? `${item.chat.name}: ${compactStatusLabel}`
                              : item.chat.name
                          }
                        >
                          {chatTrigger}
                        </IconTooltip>
                      ) : (
                        chatTrigger
                      )}
                    </ChatMenu>
                  </div>
                );
              })}
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </>
  );
}

/** A space section header's name as one phrase, for accessible labels. */
function headerName(group: { title?: string | null; subtitle?: string }): string {
  return group.subtitle ? `${group.title}, ${group.subtitle}` : (group.title ?? "");
}

function formatRosterTime(isoDate?: string | null): string {
  if (!isoDate) return "";
  try {
    const d = new Date(isoDate);
    if (Number.isNaN(d.getTime())) return "";
    const locale = i18n.locale || "en";
    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();
    if (isToday) {
      return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday =
      d.getDate() === yesterday.getDate() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getFullYear() === yesterday.getFullYear();
    if (isYesterday) return t`Yesterday`;
    const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 7) {
      return d.toLocaleDateString(locale, { weekday: "short" });
    }
    return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}
