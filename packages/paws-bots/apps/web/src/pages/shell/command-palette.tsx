import { listenWindow, ownsHostKeyboard } from "../../paws/runtime";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { PageIcon } from "@rakazo/chat-ui/web";
import type { Bot, PageSummary } from "@rakazo/contracts";
import {
  BotAvatar,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  Kbd,
} from "@rakazo/ui-web";
import { Check } from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useMemo, useState } from "react";
import { formatRelativeTime } from "../../lib/relative-time";
import { isApplePlatform } from "./shell-shortcuts";

/** Pages listed before anything is typed. */
const RECENT_PAGES = 5;

export type CommandPaletteAction = {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
  checked?: boolean;
  onSelect: () => void;
};

function botSearchText(bot: Bot) {
  return `${bot.name} ${bot.description} ${bot.preview}`.toLowerCase();
}

function botSubtitle(bot: Bot) {
  return bot.description.trim() || bot.preview.trim();
}

export function CommandPalette({
  open,
  onOpenChange,
  bots,
  onSelectBot,
  actions,
  pages = [],
  onSelectPage,
  onSearchChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bots: Bot[];
  onSelectBot: (botId: string) => void;
  actions: CommandPaletteAction[];
  /** Pages bots built in this Space. */
  pages?: PageSummary[];
  onSelectPage?: (page: PageSummary) => void;
  /** The typed search, so pages beyond the first loaded can be asked for. */
  onSearchChange?: (search: string) => void;
}) {
  const [search, setSearch] = useState("");
  useEffect(() => onSearchChange?.(search), [search, onSearchChange]);
  const [modKey, setModKey] = useState("⌘");

  useEffect(() => {
    setModKey(isApplePlatform() ? "⌘" : "Ctrl");
  }, []);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const filteredBots = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return bots;
    return bots.filter((bot) => botSearchText(bot).includes(needle));
  }, [bots, search]);

  const filteredActions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return actions;
    return actions.filter((action) => action.label.toLowerCase().includes(needle));
  }, [actions, search]);

  // Without a search only the latest few pages show, so actions stay in reach; with one, titles
  // that start with it come first, and if one does the pages lead the menu.
  const needle = search.trim().toLowerCase();
  const filteredPages = useMemo(() => {
    if (!needle) return pages.slice(0, RECENT_PAGES);
    const starts = (page: PageSummary) => page.title.toLowerCase().startsWith(needle);
    return pages
      .filter((page) => page.title.toLowerCase().includes(needle))
      .sort((a, b) => Number(starts(b)) - Number(starts(a)));
  }, [pages, needle]);
  const pagesFirst =
    needle !== "" && filteredPages.some((page) => page.title.toLowerCase().startsWith(needle));
  const pagesGroup =
    filteredPages.length > 0 && onSelectPage ? (
      <CommandGroup heading={t`Pages`}>
        {filteredPages.map((page) => (
          <CommandItem
            key={page.id}
            value={`page:${page.id}`}
            onSelect={() => {
              onOpenChange(false);
              onSelectPage(page);
            }}
            className="items-center gap-3 rounded-xl! px-2.5 py-2.5"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-muted">
              <PageIcon className="h-[17px] w-[13px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-foreground" dir="auto">
                {page.title}
              </span>
              <span className="mt-0.5 block truncate text-body-sm text-muted-foreground">
                {formatRelativeTime(page.updatedAt)}
              </span>
            </span>
          </CommandItem>
        ))}
      </CommandGroup>
    ) : null;
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (!ownsHostKeyboard(event)) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) {
        return;
      }
      if (!/^[1-9]$/.test(event.key)) return;
      const bot = filteredBots[Number(event.key) - 1];
      if (!bot) return;
      event.preventDefault();
      onSelectBot(bot.id);
      onOpenChange(false);
    }
    listenWindow("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filteredBots, onOpenChange, onSelectBot, open]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t`Command menu`}
      description={t`Search bots, actions, and settings`}
      className="sm:max-w-xl"
    >
      <Command
        shouldFilter={false}
        className="rounded-xl! bg-popover"
        data-testid="command-palette"
      >
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder={t`Search`}
          data-testid="command-palette-search"
        />
        <CommandList className="max-h-80" data-testid="command-palette-list">
          <CommandEmpty>
            <Trans>No results</Trans>
          </CommandEmpty>
          {pagesFirst ? pagesGroup : null}
          <CommandGroup>
            {filteredBots.map((bot, index) => {
              const subtitle = botSubtitle(bot);
              const shortcut = index < 9 ? `${modKey}${index + 1}` : null;
              return (
                <CommandItem
                  key={bot.id}
                  value={bot.id}
                  data-testid={`command-palette-bot-${bot.id}`}
                  onSelect={() => {
                    onSelectBot(bot.id);
                    onOpenChange(false);
                  }}
                  className="items-center gap-3 rounded-xl! px-2.5 py-2.5"
                >
                  <BotAvatar
                    avatarSet={bot.avatarSet}
                    color={bot.color}
                    identity={bot.id}
                    size={32}
                    status={bot.status}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground" dir="auto">
                      {bot.name}
                    </div>
                    {subtitle ? (
                      <div
                        className="mt-0.5 truncate text-body-sm text-muted-foreground"
                        dir="auto"
                      >
                        {subtitle}
                      </div>
                    ) : null}
                  </div>
                  {shortcut ? (
                    <CommandShortcut className="tracking-normal">
                      <Kbd>{shortcut}</Kbd>
                    </CommandShortcut>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
          {pagesFirst ? null : pagesGroup}
          {filteredActions.length > 0 ? (
            <CommandGroup>
              {filteredActions.map((action) => (
                <CommandItem
                  key={action.id}
                  value={action.id}
                  aria-checked={action.checked}
                  data-testid={`command-palette-action-${action.id}`}
                  onSelect={() => {
                    onOpenChange(false);
                    action.onSelect();
                  }}
                  className="items-center gap-3 rounded-xl! px-2.5 py-2.5"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <action.icon size={16} strokeWidth={1.8} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                    {action.label}
                  </span>
                  {action.checked ? (
                    <Check
                      size={16}
                      strokeWidth={1.8}
                      className="text-muted-foreground"
                      aria-hidden
                    />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
