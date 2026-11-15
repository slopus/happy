import { useLingui } from "@lingui/react/macro";
import type { VoiceChatGroup } from "@rakazo/core";
import {
  callRequestBlock,
  speechFromBlocks,
  voiceChatDuration,
  voiceChatSummary,
} from "@rakazo/core";
import { Button, buttonVariants, Collapsible, CollapsibleContent, cn } from "@rakazo/ui-web";
import { ChevronDown, Phone, PhoneIncoming, PhoneMissed } from "lucide-react";
import { useState } from "react";
import { BuiCard } from "../ai/primitives";

export function VoiceChatCard({
  group,
  revealMessageId,
  onCallBack,
}: {
  group: VoiceChatGroup;
  revealMessageId?: string;
  onCallBack?: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const revealed =
    revealMessageId != null && group.messages.some((message) => message.id === revealMessageId);
  // A jump looks the row up in the same commit. Expand during render so the row exists,
  // and leave the card open after the request clears.
  if (revealed && !open) setOpen(true);
  /** Present when the bot placed this call; the card then follows the call's outcome. */
  const request = callRequestBlock(group.messages[0]?.blocks);
  const seconds = voiceChatDuration(group);
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const ringing = request?.status === "ringing" && Date.parse(request.expiresAt) > Date.now();
  // A call that rang out reads as missed even before the server's ring-out lands.
  const missed =
    request?.status === "declined" ||
    request?.status === "missed" ||
    (request?.status === "ringing" && !ringing);
  const title = !request
    ? t`Phone call`
    : ringing
      ? t`Calling you…`
      : missed
        ? t`Missed call`
        : t`Incoming call`;
  const detail = !request
    ? duration
    : ringing
      ? ""
      : request.status === "declined"
        ? t`You declined`
        : missed
          ? ""
          : duration;
  const summary = missed || ringing ? (request?.reason ?? "") : voiceChatSummary(group);
  // The opening was spoken, not posted: show it as the call's first bot turn.
  const transcript = [
    ...(request && !missed && !ringing && request.opening
      ? [{ id: `${group.key}:opening`, role: "bot", text: request.opening }]
      : []),
    ...group.messages.map((message) => ({
      id: message.id,
      role: message.role,
      // The request and the marker are the card's own lines, never transcript turns.
      text:
        message === group.marker || callRequestBlock(message.blocks)
          ? ""
          : speechFromBlocks(message.blocks).trim(),
    })),
  ];
  const expandable = transcript.some((line) => line.text);
  const Icon = !request ? Phone : missed ? PhoneMissed : PhoneIncoming;
  return (
    <BuiCard
      data-testid="voice-chat-card"
      data-call-status={request?.status}
      className={cn(
        "w-full max-w-[min(74%,calc(100%_-_6rem))]",
        // The user's own call sits on their side; the bot's call on the bot's.
        request ? "me-auto" : "ms-auto",
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          className="flex min-w-0 flex-1 items-center gap-2 text-start disabled:cursor-default"
        >
          <Icon
            className={cn(
              "size-4 shrink-0",
              missed ? "text-destructive" : ringing ? "text-success" : "text-muted-foreground",
            )}
            aria-hidden="true"
          />
          <span className="text-body font-medium text-foreground">{title}</span>
          {detail ? (
            <span className="truncate text-label tabular-nums text-muted-foreground">{detail}</span>
          ) : null}
          {expandable ? (
            <span
              className={cn(
                buttonVariants({ variant: "ghost", size: "icon-sm" }),
                "ms-auto pointer-events-none text-muted-foreground",
              )}
            >
              <span className="sr-only">{open ? t`Hide transcript` : t`Show transcript`}</span>
              <ChevronDown
                className={cn(
                  "size-4 transition-transform duration-150 ease-out motion-reduce:transition-none",
                  open && "rotate-180",
                )}
              />
            </span>
          ) : null}
        </button>
        {missed && onCallBack ? (
          <Button size="sm" className="shrink-0" onClick={onCallBack}>
            {t`Call back`}
          </Button>
        ) : null}
      </div>
      {!open && summary ? (
        <p className="truncate px-3 pb-2 text-body text-muted-foreground" dir="auto">
          {summary}
        </p>
      ) : null}
      <Collapsible open={open} className="contents">
        <CollapsibleContent className="flex flex-col">
          <div className="space-y-1.5 px-3 pb-3 text-body">
            {transcript.map((line) => {
              if (!line.text) {
                return <span key={line.id} data-message-id={line.id} className="sr-only" />;
              }
              return (
                <p
                  key={line.id}
                  data-message-id={line.id}
                  dir="auto"
                  className={cn(
                    line.role === "user"
                      ? "text-end text-muted-foreground"
                      : "rounded-md bg-muted/60 px-3 py-2 text-foreground",
                  )}
                >
                  {line.text}
                </p>
              );
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </BuiCard>
  );
}
