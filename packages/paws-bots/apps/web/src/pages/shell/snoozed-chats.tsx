import { Trans, useLingui } from "@lingui/react/macro";
import type { Space } from "@rakazo/contracts";
import { snoozeWakeDay } from "@rakazo/core";
import { BotAvatar, Button, GroupAvatar } from "@rakazo/ui-web";
import { SidebarShelf } from "./sidebar-shelf";
import type { SnoozeChat } from "./use-chat-snooze";

export type SnoozedChat =
  | { kind: "bot"; chat: Space["bots"][number] }
  | { kind: "group"; chat: Space["groups"][number] };

/** Snoozed chats from every listed space, folded at the bottom of the sidebar, with wake times. */
export function SnoozedChats({
  snoozed,
  showSpaceSearch,
  now,
  snooze,
  openSpaceChat,
}: {
  snoozed: SnoozedChat[];
  showSpaceSearch: boolean;
  now: number;
  snooze: SnoozeChat;
  openSpaceChat: (spaceId: string, path: string) => void;
}) {
  const { t, i18n } = useLingui();
  if (snoozed.length === 0 || showSpaceSearch) return null;
  const wakeLabel = (until: string | null | undefined) => {
    const wake = new Date(until ?? "");
    const day = snoozeWakeDay(wake, new Date(now));
    return i18n.date(wake, { ...day, hour: "numeric", minute: "2-digit" });
  };
  return (
    <SidebarShelf title={<Trans>Snoozed</Trans>} count={snoozed.length}>
      {snoozed.map(({ kind, chat }) => (
        <div
          key={`${kind}:${chat.id}`}
          className="group/shelf flex items-center gap-2 rounded-lg px-2.5 py-1 hover:bg-sidebar-accent"
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-start"
            onClick={() =>
              openSpaceChat(chat.spaceId, kind === "bot" ? `/app/${chat.id}` : `/app/g/${chat.id}`)
            }
          >
            {kind === "bot" ? (
              <BotAvatar
                avatarSet={chat.avatarSet}
                color={chat.color}
                identity={chat.id}
                size={28}
                status={chat.status}
              />
            ) : (
              <GroupAvatar members={chat.members} size={28} />
            )}
            <span className="min-w-0 flex-1 truncate text-body text-foreground/75" dir="auto">
              {chat.name}
            </span>
            <span className="shrink-0 text-label text-faint-foreground tabular-nums group-focus-within/shelf:hidden group-hover/shelf:hidden">
              {wakeLabel(chat.snoozedUntil)}
            </span>
          </button>
          <Button
            variant="ghost"
            size="xs"
            className="sr-only focus-visible:not-sr-only group-hover/shelf:not-sr-only"
            aria-label={t`Unsnooze ${chat.name}`}
            onClick={() => snooze({ kind, ...chat }, null)}
          >
            <Trans>Unsnooze</Trans>
          </Button>
        </div>
      ))}
    </SidebarShelf>
  );
}
