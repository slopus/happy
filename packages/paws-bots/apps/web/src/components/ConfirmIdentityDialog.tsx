import { Trans, useLingui } from "@lingui/react/macro";
import type { AccountSecurity } from "@rakazo/contracts";
import { identityConfirmationProviders, runWithIdentityConfirmation } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@rakazo/ui-web";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  confirmIdentity,
  fetchAccountSecurity,
  requestIdentityCode,
} from "../lib/account-security";
import { authClient } from "../lib/auth";
import { runSsoFlow } from "../lib/sso-flow";
import { authErrorText } from "../lib/user-error";

/**
 * Asks the signed-in person to confirm it's them: their password, or for accounts without one,
 * a fresh SSO sign-in or an emailed code. SSO returns to this page, so the action runs again
 * when the person repeats it.
 */
export function ConfirmIdentityDialog({
  open,
  onDone,
}: {
  open: boolean;
  onDone: (confirmed: boolean) => void;
}) {
  const { t } = useLingui();
  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each opening is its own attempt; a request still running from a dismissed one is ignored.
  const attempt = useRef(0);
  useEffect(() => {
    attempt.current += 1;
    setPending(false);
    if (!open) return;
    let active = true;
    setPassword("");
    setCode("");
    setSent(false);
    setError(null);
    void fetchAccountSecurity()
      .then((value) => {
        if (!active) return;
        setSecurity(value);
        if (
          !value.hasPassword &&
          !value.emailDeletion &&
          !identityConfirmationProviders(value).length
        )
          setError(t`Could not continue`);
      })
      .catch(() => {
        if (active) setError(t`Could not continue`);
      });
    return () => {
      active = false;
    };
  }, [open]);
  /** Runs a request; `then` runs on success only if the same attempt is still open. */
  async function action(run: () => Promise<unknown>, then?: () => void) {
    const started = attempt.current;
    setPending(true);
    setError(null);
    try {
      await run();
      if (attempt.current === started) then?.();
    } catch (cause) {
      if (attempt.current === started)
        setError(cause instanceof Error ? cause.message : t`Could not continue`);
    } finally {
      if (attempt.current === started) setPending(false);
    }
  }
  const proof = security?.hasPassword ? password : sent ? code.trim() : "";
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDone(false)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Confirm it's you</Trans>
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!proof || pending) return;
            void action(
              () => confirmIdentity(security?.hasPassword ? { password } : { code: proof }),
              () => onDone(true),
            );
          }}
        >
          {security?.hasPassword ? (
            <div>
              <Label htmlFor="confirm-identity-password">
                <Trans>Password</Trans>
              </Label>
              <Input
                id="confirm-identity-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          ) : security ? (
            <>
              {identityConfirmationProviders(security).map((provider) => (
                <Button
                  key={provider.id}
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={pending}
                  onClick={() =>
                    void action(async () => {
                      const result = await runSsoFlow(
                        (disableRedirect, callbackURL) =>
                          authClient.signIn.social({
                            disableRedirect,
                            provider: provider.id,
                            additionalData: { reauthenticate: true },
                            callbackURL: callbackURL(window.location.href),
                            errorCallbackURL: callbackURL(window.location.href),
                          }),
                        [window.location.href],
                      );
                      if (result.error)
                        throw new Error(authErrorText(result.error, t`Could not continue`));
                    })
                  }
                >
                  <Trans>Sign in again</Trans>
                </Button>
              ))}
              {security.emailDeletion && sent ? (
                <div>
                  <Label htmlFor="confirm-identity-code">
                    <Trans>Code</Trans>
                  </Label>
                  <Input
                    id="confirm-identity-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </div>
              ) : null}
              {/* Stays available after sending, as a code expires and locks after three tries. */}
              {security.emailDeletion ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={pending}
                  onClick={() =>
                    void action(requestIdentityCode, () => {
                      setCode("");
                      setSent(true);
                    })
                  }
                >
                  <Trans>Email me a code</Trans>
                </Button>
              ) : null}
            </>
          ) : null}
          {error ? (
            <p role="alert" className="text-body text-destructive">
              {error}
            </p>
          ) : null}
          {security?.hasPassword || sent ? (
            <Button type="submit" className="w-full" disabled={pending || !proof}>
              <Trans>Continue</Trans>
            </Button>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * `withIdentityConfirmation(action)` runs an action that reveals sensitive data. When the server
 * answers IDENTITY_CONFIRMATION_REQUIRED, it opens the dialog and retries once confirmed.
 * Render `identityDialog` once in the component that calls it.
 */
export function useIdentityConfirmation() {
  const [open, setOpen] = useState(false);
  const settle = useRef<((confirmed: boolean) => void) | null>(null);
  const withIdentityConfirmation = useCallback(
    <T,>(action: () => Promise<T>) =>
      runWithIdentityConfirmation(
        action,
        () =>
          new Promise<boolean>((resolve) => {
            settle.current?.(false);
            settle.current = resolve;
            setOpen(true);
          }),
      ),
    [],
  );
  const onDone = useCallback((confirmed: boolean) => {
    settle.current?.(confirmed);
    settle.current = null;
    setOpen(false);
  }, []);
  useEffect(() => () => settle.current?.(false), []);
  return {
    withIdentityConfirmation,
    identityDialog: <ConfirmIdentityDialog open={open} onDone={onDone} />,
  };
}
