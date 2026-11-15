import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { nextIncomingCall, respondToIncomingCall } from "@rakazo/core";
import { BotAvatar, Button, defaultBotAvatarValue } from "@rakazo/ui-web";
import { Phone, PhoneOff } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  isLeavingSession,
  prepareCallAudio,
  startCall,
  useCallSession,
} from "../../lib/call-session";
import { rpc, selectedSpaceId } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { CallWindow } from "./CallWindow";

/** Two short rising tones every two seconds: an incoming ring, unlike the outgoing ringback. */
function startRingtone(): () => void {
  const Context =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return () => undefined;
  let context: AudioContext;
  try {
    context = new Context();
  } catch {
    return () => undefined;
  }
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0;
  oscillator.connect(gain);
  gain.connect(context.destination);
  const ring = () => {
    const at = context.currentTime + 0.05;
    for (const offset of [0, 0.5]) {
      oscillator.frequency.setValueAtTime(659, at + offset);
      gain.gain.setValueAtTime(0.08, at + offset);
      oscillator.frequency.setValueAtTime(784, at + offset + 0.18);
      gain.gain.setValueAtTime(0, at + offset + 0.36);
    }
  };
  ring();
  const timer = setInterval(ring, 2000);
  oscillator.start();
  return () => {
    clearInterval(timer);
    try {
      oscillator.stop();
    } catch {
      // Already stopped.
    }
    void context.close().catch(() => undefined);
  };
}

/**
 * The bot is calling: rings until the user answers, declines, or
 * the call rings out. Answering hands over to the regular call window.
 */
export function IncomingCall({
  bots,
  transcribe,
  onAnswered,
}: {
  bots: Bot[];
  transcribe?: boolean;
  onAnswered: (botId: string) => void;
}) {
  const { t } = useLingui();
  const onCall = useCallSession() !== null;
  /** Calls this tab already acted on, so a stale roster poll cannot ring them again. */
  const [handled, setHandled] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notified = useRef(new Set<string>());
  /** Leaving the shell, switching space or a lazy route hiding the shell all clear this, so a late
   * answer must not start the call. A layout effect, because Suspense hides without passive cleanup. */
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const currentNow = Math.max(now, Date.now());
  const bot = onCall ? undefined : nextIncomingCall(bots, handled, currentNow);
  const call = bot?.incomingCall;
  const callId = call?.callId;

  useEffect(() => {
    if (!callId) return;
    setNow(Date.now());
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(call.expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [callId, call?.expiresAt]);

  useEffect(() => {
    if (!callId) return;
    setError(null);
    return startRingtone();
  }, [callId]);

  const notification = useRef<Notification | null>(null);
  useEffect(() => {
    return () => {
      notification.current?.close();
      notification.current = null;
    };
  }, [callId]);

  useEffect(() => {
    const notify = () => {
      if (!bot || !call || notified.current.has(call.callId)) return;
      if (document.visibilityState === "visible" || typeof Notification === "undefined") return;
      if (Notification.permission !== "granted") return;
      const notice = new Notification(t`${bot.name} is calling you`, {
        tag: `call:${call.callId}`,
        requireInteraction: true,
      });
      notification.current = notice;
      notified.current.add(call.callId);
      notice.onclick = () => {
        window.focus();
        notice.close();
      };
    };
    notify();
    document.addEventListener("visibilitychange", notify);
    return () => document.removeEventListener("visibilitychange", notify);
  }, [bot, call, t]);

  if (!bot || !call) return null;

  const settle = async () => {
    // The page reloads for another session: its cookie may belong to someone else now.
    if (isLeavingSession()) return;
    setBusy(true);
    setError(null);
    try {
      await respondToIncomingCall(call, () =>
        rpc.notifications.declineIncomingCall({ callId: call.callId }),
      );
      setHandled((current) => new Set(current).add(call.callId));
    } catch (cause) {
      // Already answered elsewhere or rung out: there is nothing left to decline.
      if ((cause as { code?: string } | null)?.code === "CONFLICT")
        setHandled((current) => new Set(current).add(call.callId));
      else setError(errorText(cause, t`Could not send that`));
    } finally {
      setBusy(false);
    }
  };

  const answer = async () => {
    if (isLeavingSession()) return;
    prepareCallAudio();
    setBusy(true);
    setError(null);
    const target = { botId: bot.id, callId: call.callId };
    const context = { spaceId: selectedSpaceId() };
    try {
      const answered = await respondToIncomingCall(call, () =>
        rpc.threads.answerCall(target, { context }),
      );
      // The page reloads for another session: a hang-up now would carry that session's cookie.
      if (isLeavingSession()) return;
      if (!mounted.current) {
        // Nobody is left to talk to: hang up the call the server now holds as answered.
        void rpc.threads.endCall(target, { context }).catch(() => undefined);
        return;
      }
      setHandled((current) => new Set(current).add(call.callId));
      startCall({
        botId: bot.id,
        botName: bot.name,
        botColor: bot.color,
        botAvatarSet: bot.avatarSet,
        transcribe,
        answered: { callId: call.callId, opening: answered.opening },
      });
      onAnswered(bot.id);
    } catch (cause) {
      if ((cause as { code?: string } | null)?.code === "CONFLICT") {
        setHandled((current) => new Set(current).add(call.callId));
      }
      setError(errorText(cause, t`This call is no longer ringing.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <CallWindow
      data-testid="incoming-call"
      role="alertdialog"
      aria-label={t`${bot.name} is calling you`}
      className="fixed inset-0 z-50 flex flex-col items-center bg-background px-7 pt-[max(env(safe-area-inset-top),56px)] pb-[max(env(safe-area-inset-bottom),40px)] md:inset-auto md:end-4 md:top-16 md:w-[360px] md:items-stretch md:gap-4 md:rounded-[22px] md:border md:border-border md:bg-card md:p-[18px] md:shadow-lg"
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-5 md:flex-none md:flex-row md:justify-start md:gap-3.5">
        <span className="relative grid size-32 shrink-0 place-items-center md:size-14">
          <span
            aria-hidden="true"
            className="absolute inset-0 animate-ping rounded-full border-2"
            style={{ borderColor: defaultBotAvatarValue(bot.color) }}
          />
          <span className="md:hidden">
            <BotAvatar avatarSet={bot.avatarSet} color={bot.color} identity={bot.id} size={120} />
          </span>
          <span className="hidden md:block">
            <BotAvatar avatarSet={bot.avatarSet} color={bot.color} identity={bot.id} size={52} />
          </span>
        </span>
        <span className="flex flex-col items-center gap-1 md:items-start">
          <span className="text-heading1 font-semibold text-foreground md:text-heading3" dir="auto">
            {bot.name}
          </span>
        </span>
      </div>
      <p
        className="my-4 max-w-80 rounded-xl bg-muted px-3 py-2 text-body text-foreground md:my-0 md:max-w-none"
        dir="auto"
      >
        {call.reason}
      </p>
      {error ? (
        <p role="alert" className="mb-4 text-center text-body text-destructive md:mb-0">
          {error}
        </p>
      ) : null}
      <div className="grid w-full max-w-80 grid-cols-2 gap-3 md:max-w-none">
        <Button
          variant="destructive"
          className="h-14 text-body md:h-11"
          disabled={busy}
          onClick={() => void settle()}
        >
          <PhoneOff className="size-5" aria-hidden="true" />
          {t`Decline`}
        </Button>
        <Button
          disabled={busy}
          className="h-14 bg-success text-body text-background hover:bg-success/90 md:h-11"
          onClick={() => void answer()}
        >
          <Phone className="size-5" aria-hidden="true" />
          {t({ message: "Answer", context: "incoming call" })}
        </Button>
      </div>
    </CallWindow>
  );
}
