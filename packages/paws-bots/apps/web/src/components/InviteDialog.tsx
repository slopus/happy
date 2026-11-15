import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { BillingStatus } from "@rakazo/contracts";
import { DEFAULT_NEW_BOT_AVATAR_SET, INVITED_TRIAL_WEEKS } from "@rakazo/contracts";
import { INVITE_AVATAR_COLORS } from "@rakazo/core";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { CalendarPlus, Check, Copy, Gift } from "lucide-react";
import { useCopyText } from "../lib/copy-text";

type Referral = NonNullable<BillingStatus["referral"]>;
// Named for the copy's placeholder.
const weeks = INVITED_TRIAL_WEEKS;

export function InviteDialog({
  referral,
  open,
  onOpenChange,
}: {
  referral: Referral;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const [copied, copy] = useCopyText();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <div aria-hidden="true" className="flex items-center justify-center gap-1 pt-2">
          {INVITE_AVATAR_COLORS.map((color, index) => (
            <BotAvatar
              key={color}
              identity={`invite-${index}`}
              color={color}
              avatarSet={DEFAULT_NEW_BOT_AVATAR_SET}
              size={index === 2 ? 64 : 48}
            />
          ))}
        </div>
        <DialogHeader className="items-center text-center">
          <DialogTitle>
            <Trans>Give a friend {weeks} weeks free</Trans>
          </DialogTitle>
        </DialogHeader>
        <ul className="flex flex-col gap-3 text-body">
          <li className="flex items-center gap-3">
            <Gift aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
            <Trans>They get {weeks} weeks free.</Trans>
          </li>
          <li className="flex items-center gap-3">
            <CalendarPlus aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
            <Trans>You get a free month when they start their trial with a new card.</Trans>
          </li>
        </ul>
        {referral.rewards > 0 ? (
          <p className="text-center text-body text-muted-foreground">
            <Plural
              value={referral.rewards}
              one="# free month earned"
              other="# free months earned"
            />
          </p>
        ) : null}
        {/* Shown as well, so the link can be copied by hand where the clipboard is unavailable. */}
        <Input
          readOnly
          aria-label={t`Invite link`}
          value={referral.url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button size="lg" className="w-full" onClick={() => copy(referral.url)}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? <Trans>Copied</Trans> : <Trans>Copy link</Trans>}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
