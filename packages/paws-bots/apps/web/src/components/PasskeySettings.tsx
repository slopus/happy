import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { authClient } from "../lib/auth";
import {
  passkeyErrorText,
  passkeysChanged,
  usePasskeysSupported,
  usePasskeysVersion,
} from "../lib/passkeys";
import { formatRelativeTime } from "../lib/relative-time";
import { ConfirmDialog } from "./ConfirmDialog";
import { SettingsRow } from "./SettingsRows";

type PasskeyRow = {
  id: string;
  name?: string | null;
  createdAt: Date | string;
};

/** The account's passkeys, shown only where this browser can use them. */
export function PasskeySettings() {
  const supported = usePasskeysSupported();
  // Reloads after this page adds or removes a passkey anywhere, the sidebar offer included.
  const version = usePasskeysVersion();
  const [attempt, setAttempt] = useState(0);
  return supported ? (
    <PasskeyList key={`${version}:${attempt}`} onRetry={() => setAttempt((value) => value + 1)} />
  ) : null;
}

function PasskeyList({ onRetry }: { onRetry: () => void }) {
  const { t } = useLingui();
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<PasskeyRow | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void authClient.passkey.listUserPasskeys().then(
      (result) => {
        if (!active) return;
        setLoadFailed(!result.data);
        if (result.data) setPasskeys(result.data);
      },
      () => {
        if (active) setLoadFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function run(action: () => Promise<{ error?: unknown }>): Promise<boolean> {
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (result.error) {
        setError(passkeyErrorText(result.error, t`Could not continue`));
        return false;
      }
      // Remounts this list with fresh data and closes the offer if it is open.
      passkeysChanged();
      return true;
    } catch {
      setError(t`Could not reach the server`);
      return false;
    } finally {
      setPending(false);
    }
  }

  async function rename() {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name) return;
    if (await run(() => authClient.passkey.updatePasskey({ id: renaming.id, name }))) {
      setRenaming(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    const { id } = deleting;
    if (await run(() => authClient.passkey.deletePasskey({ id }))) setDeleting(null);
  }

  return (
    <div className="divide-y divide-border" data-testid="passkey-settings">
      <SettingsRow
        label={<Trans>Passkeys</Trans>}
        control={
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => void run(() => authClient.passkey.addPasskey())}
          >
            <Trans>Add passkey</Trans>
          </Button>
        }
      >
        {loadFailed ? (
          <div role="alert" className="mt-2 flex items-center gap-2 text-body text-destructive">
            <Trans>Could not load</Trans>
            <Button variant="outline" size="xs" onClick={onRetry}>
              <Trans>Retry</Trans>
            </Button>
          </div>
        ) : null}
        {error && !deleting ? (
          <p role="alert" className="mt-2 text-body-sm text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsRow>
      {passkeys.length > 0 ? (
        <ul className="divide-y divide-border">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="flex min-h-15 items-center gap-2 px-4 py-3">
              {renaming?.id === passkey.id ? (
                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void rename();
                  }}
                >
                  <Input
                    aria-label={t`Rename`}
                    value={renaming.name}
                    maxLength={100}
                    autoFocus
                    onChange={(event) => setRenaming({ id: passkey.id, name: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.keyCode === 229) {
                        if (event.key === "Escape") event.stopPropagation();
                        return;
                      }
                      if (event.key === "Escape") setRenaming(null);
                    }}
                    className="h-8 flex-1"
                  />
                  <Button type="submit" size="sm" disabled={pending || !renaming.name.trim()}>
                    <Trans>Save</Trans>
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(null)}>
                    <Trans>Cancel</Trans>
                  </Button>
                </form>
              ) : (
                <>
                  <p className="flex min-w-0 flex-1 items-baseline gap-2 text-body text-foreground">
                    <span className="truncate">{passkeyLabel(passkey, t`Passkey`)}</span>
                    <span className="shrink-0 text-body-sm text-muted-foreground">
                      {formatRelativeTime(new Date(passkey.createdAt).toISOString())}
                    </span>
                  </p>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Rename`}
                    disabled={pending}
                    onClick={() => setRenaming({ id: passkey.id, name: passkey.name ?? "" })}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Delete`}
                    disabled={pending}
                    className="text-destructive hover:text-destructive"
                    onClick={() => setDeleting(passkey)}
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {deleting ? (
        <ConfirmDialog
          onCancel={() => {
            setDeleting(null);
            setError(null);
          }}
          title={t`Delete "${passkeyLabel(deleting, t`Passkey`)}"?`}
          description={<Trans>This can't be undone.</Trans>}
          error={error}
          busy={pending}
          onConfirm={() => void remove()}
          confirmLabel={pending ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
        />
      ) : null}
    </div>
  );
}

function passkeyLabel(passkey: PasskeyRow, fallback: string): string {
  return passkey.name?.trim() || fallback;
}
