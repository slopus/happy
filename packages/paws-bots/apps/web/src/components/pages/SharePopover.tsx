import { Trans, useLingui } from "@lingui/react/macro";
import type { PageVisibility } from "@rakazo/contracts";
import { accountDisplay } from "@rakazo/core";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
} from "@rakazo/ui-web";
import { ArrowUpRight, Check, Globe, Lock, Share } from "lucide-react";
import type { ReactNode } from "react";
import { useCopyText } from "../../lib/copy-text";

const TILE = "grid size-8 shrink-0 place-items-center rounded-sm bg-foreground/[0.04]";
const LINK_PILL =
  "flex h-8 min-w-0 flex-1 items-center justify-center gap-2 rounded-full ring-[0.5px] ring-border px-3 text-body font-normal text-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring";

/** Two overlapping rounded squares: the Copy link glyph. */
function CopyGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      className="size-[14px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
    >
      <rect x="3.5" y="1" width="9.5" height="9.5" rx="1.5" />
      <path d="M1 4.5v6.75A1.25 1.25 0 0 0 2.25 12.5H9" strokeLinecap="round" />
    </svg>
  );
}

function OwnerImage({ initial, image }: { initial: string | null; image: string | null }) {
  if (image) return <img src={image} alt="" className="size-8 rounded-full object-cover" />;
  return (
    <span className="grid size-8 place-items-center rounded-full bg-foreground/[0.08] text-label font-medium text-foreground/60">
      {initial}
    </span>
  );
}

/** Who can open a page: only its owner, or anyone holding the link. */
export function SharePopover({
  title,
  owner,
  visibility,
  shareUrl,
  onVisibilityChange,
  pending = false,
  error = null,
  open,
  onOpenChange,
  compact = false,
}: {
  title: string;
  owner: { name: string; image: string | null };
  /** Null when a change's answer was lost and the page couldn't be read since: either choice sends. */
  visibility: PageVisibility | null;
  shareUrl: string | null;
  onVisibilityChange: (visibility: PageVisibility) => void;
  /** A change is being saved; the choice waits for it. */
  pending?: boolean;
  error?: string | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  compact?: boolean;
}) {
  const { t } = useLingui();
  const shownOwner = accountDisplay(owner, t`You`);
  const [copied, copy, copyFailed] = useCopyText();
  const shared = visibility === "link";
  const options: { value: PageVisibility; title: string; detail?: string; icon: ReactNode }[] = [
    {
      value: "private",
      title: t`Only you`,
      // Said where the choice is made: turning the link off breaks it for everyone holding it.
      detail: visibility === "private" ? undefined : t`The shared link stops working`,
      icon: <Lock className="size-4 text-foreground/70!" strokeWidth={1.5} />,
    },
    {
      value: "link",
      title: t`Anyone with the link`,
      detail: t`Can view without signing in`,
      icon: <Globe className="size-4 text-foreground/70!" strokeWidth={1.5} />,
    },
  ];
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label={
          shared ? t`Share, anyone with the link can view` : compact ? t`Share` : undefined
        }
        data-shared={shared || undefined}
        className={
          compact
            ? "relative grid size-11 place-items-center rounded-full border border-foreground/[0.06] text-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-foreground/[0.06]"
            : "flex h-[35px] items-center gap-1.5 rounded-full border border-foreground/[0.06] px-[15px] text-body text-foreground outline-none hover:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring data-popup-open:border-foreground/[0.1] data-popup-open:bg-foreground/[0.06] data-shared:pl-3"
        }
      >
        {compact ? (
          <>
            <Share className="size-5" strokeWidth={1.8} />
            {shared ? (
              <span className="absolute -top-0.5 -right-0.5 grid size-[18px] place-items-center rounded-full bg-primary text-primary-foreground ring-2 ring-card">
                <Globe className="size-3" strokeWidth={2} />
              </span>
            ) : null}
          </>
        ) : (
          <>
            {shared ? <Globe className="size-4 text-primary" strokeWidth={1.6} /> : null}
            <Trans>Share</Trans>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={7.5}
        data-testid="page-share"
        className="w-[360px] max-w-[calc(100vw-32px)] gap-3 rounded-xl ring-[0.5px] ring-border px-0 pt-[17px] pb-4 shadow-lg"
      >
        <PopoverTitle className="truncate px-4 text-body-lg font-medium tracking-[-0.44px]">
          <Trans>Share “{title}”</Trans>
        </PopoverTitle>
        <div className="flex flex-col gap-[11px] px-4">
          <div className="flex min-h-11 items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full">
              <OwnerImage initial={shownOwner.initial} image={shownOwner.image} />
            </span>
            <span className="min-w-0 flex-1 truncate text-body tracking-[0.14px]">
              {shownOwner.label}
            </span>
            <span className="px-2 text-label text-foreground/60">
              <Trans>Owner</Trans>
            </span>
          </div>
          <RadioGroup
            aria-label={t`Who can open this page`}
            value={visibility}
            disabled={pending}
            onValueChange={(value) => onVisibilityChange(value as PageVisibility)}
            className="-mx-1.5 gap-0.5"
          >
            {options.map((option) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the radio inside is the control.
              <label
                key={option.value}
                className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-[5px] hover:bg-foreground/[0.04] has-data-checked:bg-foreground/[0.06] has-disabled:cursor-default"
              >
                <span className={TILE}>{option.icon}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body tracking-[0.14px]">{option.title}</span>
                  {option.detail ? (
                    <span className="truncate text-label text-foreground/60">{option.detail}</span>
                  ) : null}
                </span>
                <RadioGroupItem value={option.value} className="me-1.5" />
              </label>
            ))}
          </RadioGroup>
        </div>
        {shared && shareUrl !== null ? (
          <div className="mt-0.5 flex flex-col gap-2 px-4">
            <div className="flex gap-2">
              <Button
                variant="ghost"
                className={`${LINK_PILL} ${copied ? "text-success" : ""}`}
                onClick={() => copy(shareUrl)}
              >
                {copied ? <Check className="size-[14px]" strokeWidth={1.8} /> : <CopyGlyph />}
                <span className="truncate">
                  {copied ? <Trans>Copied</Trans> : <Trans>Copy link</Trans>}
                </span>
              </Button>
              <a href={shareUrl} target="_blank" rel="noopener noreferrer" className={LINK_PILL}>
                <ArrowUpRight className="size-4" strokeWidth={1.6} />
                <span className="truncate">
                  <Trans>Open link</Trans>
                </span>
              </a>
            </div>
            {copyFailed ? <ManualCopy url={shareUrl} /> : null}
            <span role="status" className="sr-only">
              {copied ? t`Link copied` : ""}
            </span>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="px-4 text-label text-destructive">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** The link, selected, for when the browser would not copy it: the user copies it by hand. */
export function ManualCopy({ url }: { url: string }) {
  const { t } = useLingui();
  return (
    <label className="flex flex-col gap-1 text-label text-foreground/70">
      <span role="alert">
        <Trans>Couldn't copy. Select the link and copy it.</Trans>
      </span>
      <input
        readOnly
        value={url}
        aria-label={t`Page link`}
        // biome-ignore lint/a11y/noAutofocus: shown only once copying failed, to copy by hand
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        className="h-8 w-full min-w-0 rounded-sm bg-foreground/[0.04] px-2.5 text-body-sm text-foreground ring-[0.5px] ring-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  );
}
