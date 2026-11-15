import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerUpdate } from "@rakazo/contracts";
import { COMPUTER_UPDATE_STAGES } from "@rakazo/contracts";
import { computerUpdateNeedsAttention, computerUpdateStages } from "@rakazo/core";
import { Button, cn, Dialog, DialogContent, DialogTitle, Spinner } from "@rakazo/ui-web";
import { CheckCircle2, Circle, CircleAlert } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { computerUpdates } from "../lib/computer-updates";
import { LoadingState } from "./ai/primitives";

export function ComputerUpdateProgress({ onCompleted }: { onCompleted: () => void }) {
  const { t } = useLingui();
  const { updates, openId } = useSyncExternalStore(
    computerUpdates.subscribe,
    computerUpdates.getSnapshot,
  );
  const previous = useRef<ComputerUpdate[]>([]);
  const completed = useRef(onCompleted);
  completed.current = onCompleted;
  const [error, setError] = useState(false);
  const [recovering, setRecovering] = useState(false);
  useEffect(() => computerUpdates.watch(), []);
  useEffect(() => {
    if (
      previous.current.some(
        (old) =>
          old.status !== "failed" &&
          (!updates.some((item) => item.id === old.id) ||
            updates.some((item) => item.id === old.id && item.status === "failed")),
      )
    )
      completed.current();
    previous.current = updates;
  }, [updates]);
  const labels = [
    t`Getting ready`,
    t`Saving your workspace`,
    t`Recreating the computer`,
    t`Restoring your workspace`,
    t`Reconnecting`,
  ];
  const title = (update: ComputerUpdate) =>
    computerUpdateNeedsAttention(update)
      ? update.action === "recover"
        ? t`Recovery failed`
        : t`Update failed`
      : update.action === "recover"
        ? update.mode === "team"
          ? t`Recovering Team Computer`
          : t`Recovering ${update.name}’s Computer`
        : update.mode === "team"
          ? t`Updating Team Computer`
          : t`Updating ${update.name}’s Computer`;
  const selected = updates.find((update) => update.id === openId);
  return (
    <>
      <div className="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
        {updates.map((update) => (
          <Button
            key={update.id}
            variant="outline"
            className="h-auto gap-3 rounded-xl bg-card px-4 py-2 shadow-sm"
            onClick={() => {
              setError(false);
              computerUpdates.open(update.id);
            }}
          >
            {computerUpdateNeedsAttention(update) ? (
              <CircleAlert className="text-destructive" />
            ) : (
              <LoadingState
                label={title(update)}
                indicator={<Spinner aria-hidden className="size-5 motion-reduce:animate-none" />}
              />
            )}
            <span className="text-center">
              <span className="block">{title(update)}</span>
              <span className="block text-label text-muted-foreground">
                {labels[COMPUTER_UPDATE_STAGES.indexOf(update.stage)]}
              </span>
            </span>
          </Button>
        ))}
      </div>
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) computerUpdates.open(null);
        }}
      >
        {selected ? (
          <DialogContent
            showCloseButton={false}
            className="gap-0 overflow-hidden rounded-3xl border border-border bg-card p-0 sm:max-w-xl"
            aria-describedby={undefined}
            data-testid="computer-update-dialog"
          >
            <div className="border-b border-border px-6 py-5">
              <DialogTitle className="text-heading3 font-semibold">{title(selected)}</DialogTitle>
            </div>
            {!computerUpdateNeedsAttention(selected) ? (
              <ol className="space-y-4 px-6 py-6" aria-label={t`Update progress`}>
                {computerUpdateStages(selected.action).map((stage, index) => {
                  const current = computerUpdateStages(selected.action).indexOf(selected.stage);
                  const Icon = index < current ? CheckCircle2 : Circle;
                  return (
                    <li
                      key={stage}
                      aria-current={index === current ? "step" : undefined}
                      className={cn(
                        "flex items-center gap-3 text-body-lg",
                        index === current ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {/* Stages only show while the update runs, so the current one spins. */}
                      {index === current ? (
                        <Spinner
                          aria-hidden
                          className="size-5 shrink-0 motion-reduce:animate-none"
                        />
                      ) : (
                        <Icon aria-hidden className="size-5 shrink-0" />
                      )}
                      {labels[COMPUTER_UPDATE_STAGES.indexOf(stage)]}
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {computerUpdateNeedsAttention(selected) ? (
              <p
                role="alert"
                className="mx-6 my-6 rounded-xl bg-muted px-4 py-4 text-body text-muted-foreground"
              >
                {selected.status === "interrupted" ? (
                  <Trans>Recovery is unavailable until the previous operation has stopped.</Trans>
                ) : (
                  <Trans>
                    Recovery restores the last saved workspace. Unsaved work may be lost.
                  </Trans>
                )}
              </p>
            ) : (
              <span role="status" className="sr-only">
                {labels[COMPUTER_UPDATE_STAGES.indexOf(selected.stage)]}
              </span>
            )}
            {error ? (
              <p role="alert" className="px-6 pb-3 text-body text-destructive">
                <Trans>Could not complete action</Trans>
              </p>
            ) : null}
            <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
              {selected.status === "failed" ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    void computerUpdates.dismiss(selected.id).catch(() => setError(true))
                  }
                >
                  <Trans>Dismiss</Trans>
                </Button>
              ) : (
                <Button variant="outline" onClick={() => computerUpdates.open(null)}>
                  <Trans>Continue in Background</Trans>
                </Button>
              )}
              {selected.status === "failed" ? (
                <Button
                  disabled={recovering}
                  onClick={() => {
                    setRecovering(true);
                    setError(false);
                    void computerUpdates
                      .start(selected.botId, "recover")
                      .catch(() => setError(true))
                      .finally(() => setRecovering(false));
                  }}
                >
                  <Trans>Recover computer</Trans>
                </Button>
              ) : null}
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
