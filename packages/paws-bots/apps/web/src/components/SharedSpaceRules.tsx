import { Trans } from "@lingui/react/macro";
import { cn } from "@rakazo/ui-web";
import { KeyRound, Lock, Users } from "lucide-react";

/** What joining a shared space means, shown once: on the invite, when someone agrees to it. */
export function SharedSpaceRules({ className }: { className?: string }) {
  return (
    <ul
      className={cn(
        "w-full space-y-3 rounded-xl border border-border px-4 py-3.5 text-start text-body text-muted-foreground",
        className,
      )}
    >
      <li className="flex items-center gap-3">
        <Users aria-hidden="true" className="size-4 shrink-0 text-foreground" />
        <Trans>Everyone here sees its chats, bots and memory</Trans>
      </li>
      <li className="flex items-center gap-3">
        <Lock aria-hidden="true" className="size-4 shrink-0 text-foreground" />
        <Trans>Your other spaces stay private</Trans>
      </li>
      <li className="flex items-center gap-3">
        <KeyRound aria-hidden="true" className="size-4 shrink-0 text-foreground" />
        <Trans>Bots use the accounts of whoever messages them</Trans>
      </li>
    </ul>
  );
}
