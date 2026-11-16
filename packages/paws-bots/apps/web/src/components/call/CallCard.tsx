import { listenWindow, ownsHostKeyboard } from "../../paws/runtime";
import { useLingui } from "@lingui/react/macro";
import { BotAvatar, Button, cn, defaultBotAvatarValue } from "@rakazo/ui-web";
import { Captions, ChevronDown, Mic, MicOff, PhoneOff, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { CallState } from "../../lib/call-session";
import {
  endCall,
  setCallMinimized,
  toggleMute,
  toggleTranscript,
  useCallSession,
} from "../../lib/call-session";
import { CallWindow } from "./CallWindow";

const BARS = [9, 15, 21, 15, 9];
const TRANSCRIPT_LINES = 4;
const EDITABLE = /^(?:input|textarea|select)$/i;

function callClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Whole seconds the call has been connected, ticking while it is. */
function useCallElapsed(call: CallState | null): number {
  const connectedAt = call?.connectedAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (connectedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connectedAt]);
  return connectedAt === null ? 0 : Math.max(0, Math.floor((now - connectedAt) / 1000));
}

export function CallCard({ onSettings }: { onSettings: () => void }) {
  const { t } = useLingui();
  const call = useCallSession();
  const elapsed = useCallElapsed(call);
  const navigate = useNavigate();
  const { botId } = useParams();
  const onCall = Boolean(call);
  useEffect(() => {
    if (!onCall) return;
    function onKey(event: KeyboardEvent) {
      if (!ownsHostKeyboard(event)) return;
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || EDITABLE.test(target?.tagName ?? "")) return;
      endCall();
    }
    listenWindow("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCall]);
  if (!call || call.minimized) return null;
  const onBotScreen = botId === call.botId;
  const ringing = call.phase === "ringing";
  const activity =
    call.phase === "speaking"
      ? t`Speaking`
      : call.phase === "thinking"
        ? t`Thinking`
        : call.muted
          ? t`Muted`
          : t`Listening`;
  return (
    <CallWindow
      data-testid="call-view"
      role="dialog"
      aria-label={t`Call with ${call.botName}`}
      className="fixed inset-0 z-50 flex flex-col bg-background px-5 pt-[max(env(safe-area-inset-top),12px)] pb-[max(env(safe-area-inset-bottom),24px)] md:inset-auto md:end-4 md:top-16 md:w-[360px] md:rounded-[22px] md:border md:border-border md:bg-card md:px-4 md:pt-2 md:pb-5 md:shadow-lg"
    >
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground"
          aria-label={t`Minimize call`}
          onClick={() => setCallMinimized(true)}
        >
          <ChevronDown />
        </Button>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground"
          aria-label={t`Transcript`}
          aria-pressed={call.transcriptOpen}
          onClick={toggleTranscript}
        >
          <Captions />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full text-muted-foreground"
          aria-label={t`Settings`}
          onClick={onSettings}
        >
          <Settings />
        </Button>
      </div>

      <div className="relative flex flex-1 flex-col items-center justify-center gap-4 py-6 md:flex-none">
        <button
          type="button"
          aria-label={t`Open chat with ${call.botName}`}
          onClick={() => {
            if (!onBotScreen) navigate(`/app/${call.botId}`);
          }}
          className="relative grid size-32 place-items-center md:size-24"
        >
          {ringing ? (
            <span
              aria-hidden="true"
              className="absolute inset-0 animate-ping rounded-full border-2"
              style={{ borderColor: defaultBotAvatarValue(call.botColor) }}
            />
          ) : null}
          <BotAvatar
            avatarSet={call.botAvatarSet}
            color={call.botColor}
            identity={call.botId}
            size={96}
          />
        </button>
        <div className="flex flex-col items-center gap-1 text-center">
          <span className="text-heading1 font-semibold text-foreground md:text-heading2" dir="auto">
            {call.botName}
          </span>
          <span
            className="flex gap-2 text-body tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {ringing ? (
              t`Calling…`
            ) : (
              <>
                <span>{callClock(elapsed)}</span>
                <span>{activity}</span>
              </>
            )}
          </span>
        </div>
        {!ringing ? (
          <div className="flex h-7 items-center gap-[4px]" aria-hidden="true">
            {BARS.map((height, index) => (
              <span
                key={`bar-${index + 1}`}
                className={cn(
                  "w-1 rounded-full",
                  call.phase === "speaking"
                    ? "animate-pulse bg-foreground"
                    : "animate-pulse bg-muted-foreground/50",
                )}
                style={{
                  height,
                  animationDelay: `${index * 90}ms`,
                  animationDuration: call.phase === "speaking" ? "600ms" : "1400ms",
                }}
              />
            ))}
          </div>
        ) : null}
      </div>

      {call.transcriptOpen ? (
        <div className="mb-4 flex flex-col gap-1.5 border-t border-border pt-2.5 text-body leading-[1.45]">
          {call.exchanges.slice(-TRANSCRIPT_LINES).map((exchange, index) => (
            <p
              key={`${exchange.role}-${index + 1}-${exchange.text.slice(0, 24)}`}
              className={cn(
                "truncate",
                exchange.role === "bot" ? "text-foreground" : "text-muted-foreground",
              )}
              dir="auto"
            >
              {exchange.text}
            </p>
          ))}
          {call.caption || call.heard ? (
            <p className="truncate text-muted-foreground/70" dir="auto">
              {call.caption || call.heard}
            </p>
          ) : null}
        </div>
      ) : call.caption ? (
        <p className="mb-4 text-center text-body text-muted-foreground" dir="auto">
          {call.caption}
        </p>
      ) : null}

      <div className="flex items-center justify-center gap-3">
        <Button
          variant={call.muted ? "default" : "secondary"}
          size="icon-lg"
          className="size-14 rounded-full md:size-12"
          aria-label={call.muted ? t`Unmute` : t`Mute`}
          aria-pressed={call.muted}
          onClick={toggleMute}
        >
          {call.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
        </Button>
        <Button
          variant="destructive"
          size="icon-lg"
          className="size-14 rounded-full md:size-12"
          aria-label={t`Hang up`}
          onClick={endCall}
        >
          <PhoneOff className="size-5" />
        </Button>
      </div>
    </CallWindow>
  );
}

/** Shown while the call window is minimized, so the call is never out of reach. */
export function CallReturnBar() {
  const { t } = useLingui();
  const call = useCallSession();
  const elapsed = useCallElapsed(call);
  if (!call?.minimized) return null;
  return (
    <button
      type="button"
      data-testid="call-return-bar"
      onClick={() => setCallMinimized(false)}
      className="app-no-drag flex min-h-10 w-full shrink-0 items-center justify-center gap-1.5 bg-success px-3 text-body font-medium text-background"
    >
      <span dir="auto">{t`Return to call with ${call.botName}`}</span>
      <span className="ms-1 tabular-nums">
        {call.phase === "ringing" ? t`Calling…` : callClock(elapsed)}
      </span>
    </button>
  );
}
