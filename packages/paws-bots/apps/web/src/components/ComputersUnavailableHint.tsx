import { Trans, useLingui } from "@lingui/react/macro";
import { Button, buttonVariants, Spinner } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import type { SandboxAvailabilityPhase } from "../lib/computer-sandbox";
import {
  computersAreUnavailable,
  refreshSandboxFromServer,
  sandboxCheckFailureMessage,
} from "../lib/computer-sandbox";
import { SuccessPop } from "./ai/primitives";

export { computersAreUnavailable } from "../lib/computer-sandbox";

type ComputersUnavailableHintProps = {
  className?: string;
  sandboxProvider?: string | null;
  /** When set, shows a control that opens Settings → Computer. */
  onOpenComputerSettings?: () => void;
  /** Called when a check finds computers available again. */
  onRecovered?: (sandboxProvider: string) => void;
  /** Called when the confirmation should leave the screen. */
  onRecoveryDismissed?: () => void;
  /** When false, hides Check again (e.g. inline preview without actions). */
  showRetry?: boolean;
};

export function ComputersUnavailableHint({
  className,
  sandboxProvider: initialProvider,
  onOpenComputerSettings,
  onRecovered,
  onRecoveryDismissed,
  showRetry = true,
}: ComputersUnavailableHintProps) {
  const { t } = useLingui();
  const [provider, setProvider] = useState(initialProvider);
  const [phase, setPhase] = useState<SandboxAvailabilityPhase>("idle");
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const onRecoveredRef = useRef(onRecovered);
  onRecoveredRef.current = onRecovered;
  const onRecoveryDismissedRef = useRef(onRecoveryDismissed);
  onRecoveryDismissedRef.current = onRecoveryDismissed;

  useEffect(() => {
    setProvider(initialProvider);
  }, [initialProvider]);

  useEffect(() => {
    if (phase !== "recovered") return;
    const timer = window.setTimeout(() => {
      onRecoveryDismissedRef.current?.();
      setPhase("idle");
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const unavailable = computersAreUnavailable(provider);

  async function handleCheckAgain() {
    if (phase === "loading") return;
    setPhase("loading");
    setFailureMessage(null);
    try {
      const me = await refreshSandboxFromServer();
      setProvider(me.sandboxProvider);
      if (computersAreUnavailable(me.sandboxProvider)) {
        setPhase("unavailable");
        return;
      }
      onRecoveredRef.current?.(me.sandboxProvider);
      setPhase("recovered");
    } catch (error) {
      setPhase("failure");
      setFailureMessage(sandboxCheckFailureMessage(error));
      // Do not treat stale cached provider as authoritative after a failed check.
      setProvider(null);
    }
  }

  const showUnavailableCopy =
    phase === "failure" || (unavailable && (phase === "idle" || phase === "unavailable"));
  if (!showUnavailableCopy && phase !== "loading" && phase !== "recovered") return null;

  return (
    <div
      data-testid="computers-unavailable-hint"
      className={className}
      role={phase === "failure" ? "alert" : undefined}
    >
      {phase === "loading" ? (
        <Spinner className="text-muted-foreground" aria-label={t`Checking computer setup…`} />
      ) : null}

      {phase === "recovered" ? (
        <SuccessPop label={t`Computers are available. Reload or open a bot to continue.`} />
      ) : null}

      {showUnavailableCopy ? (
        <p className="text-body-sm leading-relaxed text-muted-foreground">
          {failureMessage ? (
            <Trans>
              Could not verify computer setup ({failureMessage}). Fix the connection, then check
              again.
            </Trans>
          ) : (
            <Trans>Computers are off on this server.</Trans>
          )}
        </p>
      ) : null}

      {showRetry && (unavailable || phase === "failure") ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={phase === "loading"}
            onClick={() => void handleCheckAgain()}
          >
            {phase === "loading" ? <Trans>Checking…</Trans> : <Trans>Check again</Trans>}
          </Button>
          {onOpenComputerSettings ? (
            <Button type="button" variant="outline" size="sm" onClick={onOpenComputerSettings}>
              <Trans>Open computer settings</Trans>
            </Button>
          ) : null}
          <a
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            href="https://github.com/elie222/rakazo/blob/main/docs/self-host-sandbox-providers.md"
            target="_blank"
            rel="noreferrer"
          >
            <Trans>Setup help</Trans>
          </a>
        </div>
      ) : null}
    </div>
  );
}
