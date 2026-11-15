import { Trans } from "@lingui/react/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import {
  BotAvatar,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { ChevronDown } from "lucide-react";

export type AgentAccess = { allBots: boolean; botIds: string[] };

type AccessBot = { id: string; name: string; color: string; avatarSet?: BotAvatarSet };

const SHOWN_AVATARS = 4;

/**
 * Which bots can use something: all of them, or the ones picked, shown by their avatars. With
 * one bot it only shows when that bot is left out, since "all" already covers it.
 */
export function AgentAccessControl({
  bots,
  access,
  disabled,
  withOneBot,
  onChange,
}: {
  bots: AccessBot[];
  access: AgentAccess;
  disabled?: boolean;
  /** Shown also for one bot: every bot then includes later ones, and none is a choice too. */
  withOneBot?: boolean;
  onChange: (next: AgentAccess) => void;
}) {
  const chosen = access.allBots ? bots.map((bot) => bot.id) : access.botIds;
  if (bots.length === 0 || (!withOneBot && bots.length === 1 && chosen.length === 1)) return null;
  const picked = bots.filter((bot) => chosen.includes(bot.id));
  const summary = access.allBots ? (
    <Trans>All bots</Trans>
  ) : picked.length === 0 ? (
    <Trans>No bots</Trans>
  ) : (
    <>
      <span className="flex gap-0.5">
        {picked.slice(0, SHOWN_AVATARS).map((bot) => (
          <BotAvatar
            key={bot.id}
            color={bot.color}
            avatarSet={bot.avatarSet}
            identity={bot.id}
            size={18}
          />
        ))}
      </span>
      {picked.length > SHOWN_AVATARS ? (
        <span className="text-muted-foreground">+{picked.length - SHOWN_AVATARS}</span>
      ) : null}
      <span className="sr-only">{picked.map((bot) => bot.name).join(", ")}</span>
    </>
  );
  const toggle = (botId: string) =>
    onChange({
      allBots: false,
      botIds: chosen.includes(botId) ? chosen.filter((id) => id !== botId) : [...chosen, botId],
    });

  return (
    <div data-testid="agent-access" className="flex flex-wrap items-center gap-1 text-label">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              className="h-7 gap-1 px-1.5 text-label font-normal text-foreground"
            />
          }
        >
          {summary}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuCheckboxItem
            checked={access.allBots}
            onCheckedChange={(allBots) => onChange({ ...access, allBots })}
          >
            <Trans>All bots</Trans>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {bots.map((bot) => (
            <DropdownMenuCheckboxItem
              key={bot.id}
              checked={chosen.includes(bot.id)}
              onCheckedChange={() => toggle(bot.id)}
            >
              <BotAvatar color={bot.color} avatarSet={bot.avatarSet} identity={bot.id} size={18} />
              {bot.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
