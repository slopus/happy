import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@rakazo/ui-web";
import { ArrowUp, ChevronUp, Lock, Mic, Trash2 } from "lucide-react";
import type { PointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { dictation } from "../../lib/dictation";
import { IconTooltip } from "../IconTooltip";

/** How far the finger travels up before the recording locks hands-free. */
export const LOCK_DISTANCE_PX = 64;
/** A press shorter than this is a tap: nothing was said, so it only shows the hint. */
export const TAP_MS = 350;
const HINT_MS = 2_500;

type Recording = { locked: boolean; startedAt: number } | null;

/**
 * Telegram-style dictation: hold to talk and release to send the text; slide up
 * while holding to lock, then send or discard by hand. Keyboard activation starts
 * locked, since a key cannot be held and slid.
 */
export function useHoldToTalk({
  transcribe,
  disabled,
  onText,
}: {
  transcribe?: boolean;
  disabled?: boolean;
  onText: (text: string) => void;
}) {
  const { t } = useLingui();
  const [recording, setRecording] = useState<Recording>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [lift, setLift] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const recordingRef = useRef(recording);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  }, [onText]);
  /** Dictation reported listening for this recording, so a later idle means it ended. */
  const started = useRef(false);
  const gesture = useRef<{ startY: number; startedAt: number } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), HINT_MS);
  }, []);

  useEffect(
    () =>
      dictation.subscribe((snapshot) => {
        if (!recordingRef.current) return;
        if (snapshot.status === "listening") started.current = true;
        setTranscript(snapshot.transcript);
        setTranscribing(snapshot.status === "transcribing");
        if (snapshot.status !== "idle" || !started.current) return;
        started.current = false;
        recordingRef.current = null;
        setRecording(null);
        setTranscribing(false);
        setLift(0);
        if (snapshot.error) showNotice(snapshot.error);
      }),
    [showNotice],
  );

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      // Words already on their way to the server were meant to be kept, so only a recording
      // still listening is cancelled; `onText` decides where late words go.
      if (recordingRef.current && dictation.state.status !== "transcribing")
        dictation.stop("cancel");
    },
    [],
  );

  const start = useCallback(
    (locked: boolean) => {
      started.current = false;
      setNotice(null);
      setTranscript("");
      const next = { locked, startedAt: Date.now() };
      recordingRef.current = next;
      setRecording(next);
      void dictation.listen({
        mode: "hold",
        transcribe,
        onFinal: (text) => onTextRef.current(text),
      });
    },
    [transcribe],
  );

  const submit = useCallback(() => {
    if (!recordingRef.current) return;
    dictation.submitHold();
  }, []);

  const cancel = useCallback(() => {
    gesture.current = null;
    started.current = false;
    recordingRef.current = null;
    setRecording(null);
    setTranscribing(false);
    setLift(0);
    dictation.stop("cancel");
  }, []);

  const lock = useCallback(() => {
    gesture.current = null;
    setLift(0);
    const current = recordingRef.current;
    if (!current) return;
    const next = { ...current, locked: true };
    recordingRef.current = next;
    setRecording(next);
  }, []);

  const startHandsFree = useCallback(() => {
    if (disabled || recordingRef.current) return;
    start(true);
  }, [disabled, start]);

  return {
    recording,
    transcribing,
    transcript,
    lift,
    notice,
    submit,
    cancel,
    startHandsFree,
    buttonProps: {
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (disabled || event.button !== 0 || recordingRef.current) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        gesture.current = { startY: event.clientY, startedAt: Date.now() };
        start(false);
      },
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        const hold = gesture.current;
        if (!hold || !recordingRef.current || recordingRef.current.locked) return;
        const travel = Math.max(0, hold.startY - event.clientY);
        if (travel >= LOCK_DISTANCE_PX) {
          lock();
          return;
        }
        setLift(travel);
      },
      onPointerUp: () => {
        const hold = gesture.current;
        gesture.current = null;
        setLift(0);
        if (!hold || !recordingRef.current || recordingRef.current.locked) return;
        if (Date.now() - hold.startedAt < TAP_MS) {
          cancel();
          showNotice(t`Hold to talk, release to send`);
          return;
        }
        submit();
      },
      onPointerCancel: () => {
        if (!gesture.current) return;
        gesture.current = null;
        if (!recordingRef.current?.locked) cancel();
      },
      onClick: (event: { detail: number }) => {
        // detail 0 is a keyboard press; pointer presses are handled above.
        if (event.detail === 0) startHandsFree();
      },
      onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
    },
  };
}

function useSeconds(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** Takes the text field's place while recording: a live dot, the time, and what was heard. */
export function HoldToTalkStrip({ talk }: { talk: ReturnType<typeof useHoldToTalk> }) {
  const { t } = useLingui();
  const startedAt = talk.recording?.startedAt ?? Date.now();
  const seconds = useSeconds(startedAt);
  if (!talk.recording) return null;
  const hint = talk.transcribing
    ? t`Transcribing…`
    : talk.recording.locked
      ? t`Listening…`
      : t`Slide up to lock`;
  return (
    <div
      data-testid="hold-to-talk-strip"
      className="flex min-h-6 min-w-0 flex-1 items-center gap-2.5 py-0.5 text-body"
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 animate-pulse rounded-full bg-destructive"
      />
      <span className="shrink-0 tabular-nums text-foreground/80">
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
      </span>
      <span
        className={cn("truncate", talk.transcript ? "text-foreground" : "text-muted-foreground")}
        dir="auto"
        aria-live="polite"
      >
        {talk.transcript || hint}
      </span>
    </div>
  );
}

/** The microphone button, plus the lock target above it and Cancel/Send once locked. */
export function HoldToTalkControls({
  talk,
  disabled,
}: {
  talk: ReturnType<typeof useHoldToTalk>;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const { recording } = talk;
  if (recording?.locked) {
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t`Discard recording`}
          onClick={talk.cancel}
          className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
        >
          <Trash2 size={16} strokeWidth={1.8} />
        </Button>
        <Button
          size="icon"
          aria-label={t`Send recording`}
          disabled={talk.transcribing}
          onClick={talk.submit}
          className="size-8 shrink-0 rounded-full shadow-sm"
        >
          <ArrowUp size={16} strokeWidth={2.2} />
        </Button>
      </>
    );
  }
  return (
    <span className="relative inline-flex">
      {recording ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full start-1/2 mb-3 flex flex-col items-center gap-0.5 rounded-full border border-border bg-card px-2 py-2 text-muted-foreground shadow-md transition-transform"
          style={{ transform: `translate(-50%, ${-talk.lift}px)` }}
        >
          <Lock size={14} strokeWidth={1.8} />
          <ChevronUp size={14} strokeWidth={1.8} className="animate-bounce" />
        </span>
      ) : null}
      {talk.notice && !recording ? (
        <span
          role="status"
          className="pointer-events-none absolute bottom-full end-0 mb-2 w-max max-w-64 rounded-lg border border-border bg-card px-2.5 py-1.5 text-label text-foreground shadow-md"
        >
          {talk.notice}
        </span>
      ) : null}
      <IconTooltip label={t`Hold to talk, release to send`}>
        <Button
          variant="outline"
          size="icon"
          aria-label={t`Hold to talk`}
          disabled={disabled}
          {...talk.buttonProps}
          className={cn(
            "size-8 shrink-0 touch-none select-none rounded-full text-foreground/75 [-webkit-touch-callout:none]",
            // The pointer is over the button while holding, so the outline variant's hover
            // colours (a grey fill in dark, dark text) must not win over the recording red.
            recording &&
              "scale-125 border-destructive-fill bg-destructive-fill text-destructive-foreground hover:bg-destructive-fill hover:text-destructive-foreground dark:hover:bg-destructive-fill",
          )}
        >
          <Mic size={16} strokeWidth={1.8} />
        </Button>
      </IconTooltip>
    </span>
  );
}
