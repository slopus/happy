import { hostNavigate } from "../paws/runtime";
import { Trans, useLingui } from "@lingui/react/macro";
import type { AccountSecurity, SignInProvider } from "@rakazo/contracts";
import { identityConfirmationProviders } from "@rakazo/contracts";
import { Button, Input, Label } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { fetchAccountSecurity, requestAccountDeletionCode } from "../lib/account-security";
import { authClient } from "../lib/auth";
import { clearComposerDrafts } from "../lib/composer-draft";
import { forgetSignedIn } from "../lib/returning-user";
import { runSsoFlow } from "../lib/sso-flow";
import { authErrorText } from "../lib/user-error";
import { SettingsRow } from "./SettingsRows";

export function AccountAccess({
  onSecurity,
}: {
  onSecurity?: (security: AccountSecurity) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <SettingsRow
      label={<Trans>Delete account</Trans>}
      control={
        <Button
          variant="secondary"
          size="sm"
          data-testid="delete-account"
          className="text-destructive hover:text-destructive"
          onClick={() => setOpen((value) => !value)}
        >
          <Trans>Delete</Trans>
        </Button>
      }
    >
      <DeleteAccountForm open={open} onSecurity={onSecurity} />
    </SettingsRow>
  );
}

/** True when an SSO sign-in started to delete the account came back with an error. */
export function hasDeleteRedirectError(): boolean {
  return redirectError("delete") !== null;
}

/**
 * Confirms it's the account owner, then deletes the account. Security is looked up while closed
 * too, so settings can report it, and a redirect's error shows either way.
 */
export function DeleteAccountForm({
  open,
  onSecurity,
}: {
  open: boolean;
  onSecurity?: (security: AccountSecurity) => void;
}) {
  const { t } = useLingui();
  const [security, setSecurity] = useState<AccountSecurity | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const code = redirectError("delete");
    return code ? authErrorText({ code }, t`Could not continue`) : null;
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void fetchAccountSecurity()
      .then((value) => {
        if (active) {
          setSecurity(value);
          onSecurity?.(value);
        }
      })
      .catch(() => {
        if (active) setError(t`Could not continue`);
      });
    return () => {
      active = false;
    };
  }, [attempt, onSecurity]);
  async function action(run: () => Promise<unknown>, sso = false) {
    if (!sso) setPending(true);
    setError(null);
    try {
      await run();
    } catch (error) {
      setError(error instanceof Error ? error.message : t`Could not continue`);
    } finally {
      if (!sso) setPending(false);
    }
  }
  return (
    <>
      {open ? (
        <div className="mt-3 space-y-3">
          <p className="text-body">
            <Trans>This permanently deletes your account and data.</Trans>
          </p>
          {!security ? (
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          ) : security.hasPassword ? (
            <div className="space-y-2">
              <Label htmlFor="delete-password">
                <Trans>Current password</Trans>
              </Label>
              <Input
                id="delete-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          ) : (
            <>
              {identityConfirmationProviders(security).map((provider) => (
                <Button
                  key={provider.id}
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void action(async () => {
                      const returnTo = ssoReturnURL(false);
                      const result = await runSsoFlow(
                        (disableRedirect, callbackURL) =>
                          authClient.signIn.social({
                            disableRedirect,
                            provider: provider.id,
                            additionalData: { reauthenticate: true },
                            callbackURL: callbackURL(returnTo),
                            errorCallbackURL: callbackURL(returnTo),
                          }),
                        [returnTo],
                      );
                      if (result.error)
                        throw new Error(authErrorText(result.error, t`Could not continue`));
                    }, true)
                  }
                >
                  <Trans>Sign in again</Trans>
                </Button>
              ))}
              {security.emailDeletion ? (
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void action(async () => {
                      await requestAccountDeletionCode();
                      setSent(true);
                    })
                  }
                >
                  <Trans>Send deletion code</Trans>
                </Button>
              ) : null}
              {sent ? (
                <div className="space-y-2">
                  <Label htmlFor="deletion-code">
                    <Trans>Deletion code</Trans>
                  </Label>
                  <Input
                    id="deletion-code"
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                </div>
              ) : null}
            </>
          )}
          <Button
            variant="destructive"
            disabled={
              pending ||
              !security ||
              (security.hasPassword && !password) ||
              (!security.hasPassword && !security.freshOidcAuth && !code.trim())
            }
            onClick={() =>
              void action(async () => {
                const current = await fetchAccountSecurity();
                setSecurity(current);
                onSecurity?.(current);
                if (!current.hasPassword && !current.freshOidcAuth && !code.trim()) return;
                if (current.hasPassword && !password) return;
                const result = await authClient.deleteUser(
                  current.hasPassword ? { password } : code.trim() ? { token: code.trim() } : {},
                );
                if (result.error)
                  throw new Error(authErrorText(result.error, t`Could not continue`));
                clearComposerDrafts();
                forgetSignedIn();
                hostNavigate("/sign-in");
              })
            }
          >
            <Trans>Delete account</Trans>
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Links the organization's SSO identity to an account that signed up another way. */
export function LinkSsoRow({
  provider: suppliedProvider,
  onSecurity,
}: {
  provider?: SignInProvider;
  onSecurity?: (security: AccountSecurity) => void;
}) {
  const { t } = useLingui();
  const provider = suppliedProvider ?? { id: "oidc", name: t`SSO` };
  const providerName = provider.id === "oidc" && provider.name === "SSO" ? t`SSO` : provider.name;
  const [error, setError] = useState<string | null>(() => {
    const code = redirectError("link", provider.id);
    return code ? authErrorText({ code }, t`Could not continue`) : null;
  });
  async function link() {
    setError(null);
    const returnTo = ssoReturnURL(false);
    const failed = ssoReturnURL(true, provider.id);
    try {
      const result = await runSsoFlow(
        (disableRedirect, callbackURL) =>
          authClient.linkSocial({
            disableRedirect,
            provider: provider.id,
            callbackURL: callbackURL(returnTo),
            errorCallbackURL: callbackURL(failed),
          }),
        [returnTo, failed],
      );
      if (result.error) setError(authErrorText(result.error, t`Could not continue`));
      else if (onSecurity) onSecurity(await fetchAccountSecurity());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t`Could not continue`);
    }
  }
  return (
    <SettingsRow
      label={providerName}
      control={
        <Button variant="secondary" size="sm" onClick={() => void link()}>
          <Trans>Link {providerName}</Trans>
        </Button>
      }
    >
      {error ? (
        <p role="alert" className="mt-2 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsRow>
  );
}

const LINK_RETURN = "sso-link";

/** This page without an earlier redirect's result; a failed link's return is marked as one. */
function ssoReturnURL(failedLink: boolean, providerId = "oidc"): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("error");
  url.searchParams.delete(LINK_RETURN);
  if (failedLink) url.searchParams.set(LINK_RETURN, providerId);
  return url.href;
}

/** The error an SSO redirect came back with, for the flow that started it. */
function redirectError(flow: "link" | "delete", providerId = "oidc"): string | null {
  const params = new URLSearchParams(window.location.search);
  const marker = params.get(LINK_RETURN);
  if (flow === "link" && marker !== providerId && !(marker === "1" && providerId === "oidc"))
    return null;
  return params.has(LINK_RETURN) === (flow === "link") ? params.get("error") : null;
}
