import { Trans, useLingui } from "@lingui/react/macro";
import type { TaughtSkill } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { CornerDownLeft } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { enqueueTeachComputerInput } from "./teach-computer-input-chain";

export function formatRemaining(expiresAt: string | null): string {
  if (!expiresAt) return "10:00";
  const ms = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function TeachRecordingChrome({
  recording,
  botId,
  busy,
  onStop,
  variant = "panel",
}: {
  recording: TaughtSkill;
  botId: string;
  busy?: boolean;
  onStop: () => void | Promise<void>;
  variant?: "panel" | "overlay";
}) {
  const [remaining, setRemaining] = useState(() => formatRemaining(recording.expiresAt));

  useEffect(() => {
    setRemaining(formatRemaining(recording.expiresAt));
    const timer = window.setInterval(() => {
      setRemaining(formatRemaining(recording.expiresAt));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording.expiresAt]);

  const protectedInput = (
    <ProtectedTeachInput key={recording.id} botId={botId} skillId={recording.id} />
  );

  if (variant === "overlay") {
    return (
      <div
        data-testid="teach-recording-overlay"
        className="flex min-w-0 flex-1 flex-col gap-1 px-3"
      >
        <div className="truncate text-body-sm text-foreground">
          <Trans>Recording: {recording.goal}</Trans>
        </div>
        <div className="flex flex-wrap gap-x-2 text-label text-muted-foreground">
          <span>
            <Trans>{remaining} left</Trans>
          </span>
          <span>
            <Trans>Bot is watching, not acting</Trans>
          </span>
        </div>
        <div className="text-label text-muted-foreground">
          <Trans>Use Protected input for passwords.</Trans>
        </div>
        {protectedInput}
      </div>
    );
  }

  return (
    <div
      data-testid="teach-recording"
      className="rounded-[11px] border border-border bg-card px-3 py-3"
    >
      <div className="text-body text-foreground">
        <Trans>Recording: {recording.goal}</Trans>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-2 text-body-sm text-muted-foreground">
        <span>
          <Trans>{remaining} left</Trans>
        </span>
        <span>
          <Trans>Bot is watching, not acting</Trans>
        </span>
      </div>
      <div className="mt-2 text-body-sm text-muted-foreground">
        <Trans>Use Protected input for passwords.</Trans>
      </div>
      <div className="mt-2">{protectedInput}</div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        disabled={busy}
        data-testid="teach-stop-button"
        onClick={() => void onStop()}
      >
        <Trans>Stop teaching</Trans>
      </Button>
    </div>
  );
}

function ProtectedTeachInput({ botId, skillId }: { botId: string; skillId: string }) {
  const { t } = useLingui();
  const protectedInputRef = useRef<HTMLInputElement>(null);
  const activeSkillIdRef = useRef<string | null>(skillId);
  const pendingRef = useRef(false);
  const [protectedText, setProtectedText] = useState("");
  const [pending, setPending] = useState(false);
  activeSkillIdRef.current = skillId;

  useEffect(() => {
    return () => {
      if (activeSkillIdRef.current === skillId) activeSkillIdRef.current = null;
    };
  }, [skillId]);

  function submitProtectedInput(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = protectedText;
    if (!text || pendingRef.current) return;
    const queuedSkillId = skillId;
    pendingRef.current = true;
    setPending(true);
    void enqueueTeachComputerInput(botId, async () => {
      try {
        if (activeSkillIdRef.current !== queuedSkillId) return;
        await rpc.computer.input({
          botId,
          kind: "clipboard",
          payload: { text, sensitive: true, skillId: queuedSkillId },
        });
        if (activeSkillIdRef.current !== queuedSkillId) return;
        setProtectedText((current) => (current === text ? "" : current));
      } catch {
        if (activeSkillIdRef.current === queuedSkillId) protectedInputRef.current?.focus();
      } finally {
        pendingRef.current = false;
        if (activeSkillIdRef.current === queuedSkillId) setPending(false);
      }
    });
    protectedInputRef.current?.blur();
  }

  return (
    <form
      data-testid="teach-protected-input"
      className="flex min-w-0 items-center gap-1"
      onSubmit={submitProtectedInput}
    >
      <Input
        ref={protectedInputRef}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={protectedText}
        onChange={(event) => setProtectedText(event.target.value)}
        placeholder={t`Protected input`}
        aria-label={t`Protected input`}
        className="h-8 min-w-0 flex-1"
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon-sm"
        aria-label={t`Type without recording`}
        disabled={!protectedText || pending}
      >
        <CornerDownLeft size={16} strokeWidth={1.8} />
      </Button>
    </form>
  );
}

export function TeachStopButton({
  busy,
  onStop,
}: {
  busy?: boolean;
  onStop: () => void | Promise<void>;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      data-testid="teach-stop-overlay"
      onClick={() => void onStop()}
    >
      <Trans>Stop teaching</Trans>
    </Button>
  );
}
