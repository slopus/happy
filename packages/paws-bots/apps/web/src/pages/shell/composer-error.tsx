import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { computerHoursOut } from "@rakazo/contracts";
import { isModelRequiredSendError, normalizeRunError } from "@rakazo/core";
import { translateRunError } from "@rakazo/i18n/run-error";
import { Button } from "@rakazo/ui-web";
import { FileIcon, X } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useId, useRef } from "react";
import { useBilling } from "../../components/SubscriptionGate";

export function ComposerError({
  sendError,
  imageConfirmation = false,
  onSendAsFile,
  runError,
  runErrorId,
  onRunErrorPresented,
  onOpenModels,
  onOpenConnections,
  onOpenBilling,
  onDismissError,
  textareaRef,
}: {
  sendError: string | null;
  /** A recoverable image/model mismatch: a warning with its two ways forward. */
  imageConfirmation?: boolean;
  onSendAsFile?: () => void;
  runError: string | null;
  runErrorId: string | null;
  onRunErrorPresented: (runId: string) => void;
  onOpenModels: () => void;
  onOpenConnections: () => void;
  onOpenBilling: () => void;
  onDismissError: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { t } = useLingui();
  const billing = useBilling().status;
  const runErrorRef = useRef<HTMLDivElement>(null);
  const fileNoteId = useId();
  const presentedRunErrorIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!runError || !runErrorId) return;
    const currentRunErrorId = runErrorId;
    if (presentedRunErrorIdRef.current === currentRunErrorId) return;
    let intersecting = false;
    let frame: number | undefined;
    let mutations: MutationObserver | undefined;
    function stopRechecking() {
      mutations?.disconnect();
      mutations = undefined;
      document.removeEventListener("transitionend", scheduleCheck);
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    }
    function cleanup() {
      stopRechecking();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", recordIfPresented);
    }
    function scheduleCheck() {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        recordIfPresented();
      });
    }
    function recordIfPresented() {
      const element = runErrorRef.current;
      if (!intersecting || !element || document.visibilityState !== "visible") return;
      if (presentedRunErrorIdRef.current === currentRunErrorId) return;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      // Without hit testing (older engines, test DOMs) an element with a box is
      // on screen, which is all this check can know.
      if (typeof document.elementFromPoint !== "function") {
        presentedRunErrorIdRef.current = currentRunErrorId;
        cleanup();
        onRunErrorPresented(currentRunErrorId);
        return;
      }
      const topElement = document.elementFromPoint(
        (Math.max(0, rect.left) + Math.min(window.innerWidth, rect.right)) / 2,
        (Math.max(0, rect.top) + Math.min(window.innerHeight, rect.bottom)) / 2,
      );
      if (topElement && (topElement === element || element.contains(topElement))) {
        presentedRunErrorIdRef.current = currentRunErrorId;
        cleanup();
        onRunErrorPresented(currentRunErrorId);
        return;
      }
      // Only watch for an occluder to move while an unseen card is in view.
      if (!mutations) {
        mutations = new MutationObserver(scheduleCheck);
        mutations.observe(document.body, { attributes: true, childList: true, subtree: true });
        document.addEventListener("transitionend", scheduleCheck);
      }
    }
    const element = runErrorRef.current;
    const observer =
      element && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            const entry = entries.filter((entry) => entry.target === element).at(-1);
            if (!entry) return;
            intersecting = entry.isIntersecting;
            if (intersecting) recordIfPresented();
            else stopRechecking();
          })
        : null;
    document.addEventListener("visibilitychange", recordIfPresented);
    if (observer && element) observer.observe(element);
    else {
      intersecting = true;
      recordIfPresented();
    }
    return cleanup;
  }, [onRunErrorPresented, runError, runErrorId]);
  const normalizedRunError = runError
    ? normalizeRunError(runError, translateRunError, i18n.locale || "en")
    : null;
  // The one action that fixes the failure; a transient one already says to try again.
  const recovery = sendError ? undefined : normalizedRunError?.recovery;
  const hoursOut = recovery === "plan" && billing ? computerHoursOut(billing) : null;
  const hoursOutSummary =
    hoursOut === "trial"
      ? t`Your trial's computer hours are used up.`
      : hoursOut === "cancelled_trial"
        ? t`Cancelled trials have no computer hours.`
        : hoursOut === "plan"
          ? t`This month's computer hours are used up.`
          : null;
  const recoveryAction =
    recovery === "model"
      ? { label: t`Choose a model`, onClick: onOpenModels }
      : recovery === "connection"
        ? {
            label: normalizedRunError?.kind === "auth" ? t`Replace key` : t`Connect a model`,
            onClick: onOpenConnections,
          }
        : hoursOut && billing?.canManage
          ? {
              label:
                hoursOut === "trial"
                  ? t`Start plan now`
                  : hoursOut === "cancelled_trial"
                    ? t`Renew plan`
                    : t`Upgrade`,
              onClick: onOpenBilling,
            }
          : null;

  const warning = Boolean(sendError) && imageConfirmation;
  return sendError || runError ? (
    <div
      ref={runErrorRef}
      role="alert"
      data-testid="composer-error"
      className={`mb-3 flex items-center gap-2 rounded-[14px] border px-4 py-2 text-body-sm animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none ${warning ? "border-warning/40 bg-warning/10 text-warning" : "border-destructive/40 bg-destructive/10 text-destructive"}`}
    >
      <div className="min-w-0 flex-1">
        {isModelRequiredSendError(sendError) ? (
          <button
            type="button"
            data-testid="composer-error-open-models"
            onClick={onOpenModels}
            className="text-left underline underline-offset-2 hover:text-foreground"
          >
            {sendError}
          </button>
        ) : (
          (sendError ?? hoursOutSummary ?? normalizedRunError?.summary ?? null)
        )}
        {warning && onSendAsFile ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-describedby={fileNoteId}
              onClick={onSendAsFile}
            >
              <FileIcon data-icon="inline-start" aria-hidden="true" />
              {t`Send as file`}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onOpenModels}>
              {t`Change model`}
            </Button>
            <p id={fileNoteId} className="basis-full text-label text-muted-foreground">
              {t`The bot can use the file but won't see the picture.`}
            </p>
          </div>
        ) : null}
        {recoveryAction ? (
          <>
            {" "}
            <button
              type="button"
              data-testid="composer-error-action"
              onClick={recoveryAction.onClick}
              className="font-medium underline underline-offset-2 hover:text-foreground"
            >
              {recoveryAction.label}
            </button>
          </>
        ) : null}
        {!sendError && runError ? (
          <details key={runError} className="mt-1">
            <summary className="w-fit cursor-pointer">{t`Details`}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-label">
              {normalizedRunError?.details}
            </pre>
          </details>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={t`Dismiss error`}
        data-testid="composer-error-dismiss"
        onClick={() => {
          onDismissError();
          window.requestAnimationFrame(() => textareaRef.current?.focus());
        }}
        className={`shrink-0 hover:text-foreground ${warning ? "text-warning" : "text-destructive"}`}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  ) : null;
}
