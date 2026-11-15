import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { computerUpdates } from "../lib/computer-updates";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { ConfirmDialog } from "./ConfirmDialog";

type Action = "recover" | "reset" | "update";

const rowClass =
  "flex min-h-12 w-full items-center text-start text-body disabled:cursor-not-allowed disabled:opacity-50";

export function ComputerMaintenanceActions({
  botId,
  computer,
  onChanged,
  visibleRecover = false,
}: {
  botId: string;
  computer: ComputerStatus | null;
  onChanged: () => Promise<void>;
  visibleRecover?: boolean;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState<Action | null>(null);
  const [confirmAction, setConfirmAction] = useState<"reset" | "recover" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The shared status can belong to another bot's open computer; acting on this bot needs its own.
  if (computer?.botId !== botId) return null;

  const busy = Boolean(computer.busyBotName) || computer.state === "booting";
  const showReset =
    computer.state === "error" ||
    computer.state === "running" ||
    computer.state === "suspended" ||
    computer.state === "stopped";
  // Recover rebuilds the computer's system, which only computers that can update have.
  const showRecover = showReset && computer.canUpdate;
  const showUpdate = computer.canUpdate;

  async function run(action: Action) {
    setPending(action);
    setError(null);
    try {
      if (action === "recover") await computerUpdates.start(botId, "recover");
      else if (action === "reset") await rpc.computer.reset({ botId });
      else await computerUpdates.start(botId);
      setConfirmAction(null);
      await onChanged();
    } catch (err) {
      setError(errorText(err, t`Could not update computer`));
    } finally {
      setPending(null);
    }
  }

  function openConfirm(action: "reset" | "recover") {
    setError(null);
    setConfirmAction(action);
  }

  const confirmationDialog = (
    <ConfirmDialog
      open={confirmAction !== null}
      onCancel={() => setConfirmAction(null)}
      title={
        confirmAction === "recover" ? (
          <Trans>Recover computer?</Trans>
        ) : (
          <Trans>Reset computer?</Trans>
        )
      }
      description={
        confirmAction === "recover" ? (
          <Trans>Recovery restores the last saved workspace. Unsaved work may be lost.</Trans>
        ) : (
          <Trans>Restore the last saved workspace. Unsaved work on the computer is lost.</Trans>
        )
      }
      error={error}
      confirmDisabled={pending !== null}
      onConfirm={() => {
        if (confirmAction) void run(confirmAction);
      }}
      confirmLabel={
        pending === "recover" ? (
          <Trans>Recovering…</Trans>
        ) : confirmAction === "recover" ? (
          <Trans>Recover computer</Trans>
        ) : pending === "reset" ? (
          <Trans>Resetting…</Trans>
        ) : (
          <Trans>Reset</Trans>
        )
      }
    />
  );

  if (visibleRecover)
    return showRecover ? (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || pending !== null}
          onClick={() => openConfirm("recover")}
        >
          <Trans>Recover computer</Trans>
        </Button>
        {confirmationDialog}
      </>
    ) : null;

  if (!showUpdate && !showReset) return null;

  return (
    <>
      <div className="overflow-hidden rounded-xl bg-muted/50 px-4 [&>*+*]:border-t [&>*+*]:border-border">
        {showUpdate ? (
          <button
            type="button"
            className={rowClass}
            disabled={busy || pending !== null}
            onClick={() => void run("update")}
          >
            {pending === "update" ? <Trans>Updating…</Trans> : <Trans>Update computer</Trans>}
          </button>
        ) : null}
        {showReset ? (
          <button
            type="button"
            className={`${rowClass} text-destructive`}
            disabled={busy || pending !== null}
            onClick={() => openConfirm("reset")}
          >
            <Trans>Reset computer</Trans>
          </button>
        ) : null}
      </div>
      {error && confirmAction === null ? (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      {confirmationDialog}
    </>
  );
}
