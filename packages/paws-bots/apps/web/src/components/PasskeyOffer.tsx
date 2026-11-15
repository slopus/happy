import { localStore } from "../paws/runtime";
import { Trans, useLingui } from "@lingui/react/macro";
import { passkeyOfferDismissedKey, shouldOfferPasskey } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { authClient } from "../lib/auth";
import {
  passkeyErrorText,
  passkeysChanged,
  usePasskeysSupported,
  usePasskeysVersion,
} from "../lib/passkeys";

function readDismissed(key: string): boolean {
  try {
    return localStore.getItem(key) !== null;
  } catch {
    return false;
  }
}

function writeDismissed(key: string) {
  try {
    localStore.setItem(key, "1");
  } catch {
    // Storage can be unavailable; the offer still closes for this page.
  }
}

/** A one-time, dismissible offer to add a passkey right after signup. */
export function PasskeyOffer() {
  const { t } = useLingui();
  const session = authClient.useSession().data;
  const supported = usePasskeysSupported();
  // A passkey added in settings must close the offer too.
  const passkeysVersion = usePasskeysVersion();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = session?.user.id;
  // Timestamps, so a session refetch with equal dates does not re-check.
  const userCreatedAt = session ? new Date(session.user.createdAt).getTime() : Number.NaN;
  const sessionCreatedAt = session ? new Date(session.session.createdAt).getTime() : Number.NaN;
  const key = userId ? passkeyOfferDismissedKey(userId) : null;

  useEffect(() => {
    setOpen(false);
    if (!supported || !key) return;
    const offer = (passkeyCount: number) =>
      shouldOfferPasskey({
        userCreatedAt: new Date(userCreatedAt),
        sessionCreatedAt: new Date(sessionCreatedAt),
        passkeyCount,
        dismissed: readDismissed(key),
      });
    // Only a fresh account's first session asks the server for its passkeys.
    if (!offer(0)) return;
    let active = true;
    void authClient.passkey
      .listUserPasskeys()
      .then((result) => {
        if (active && result.data) setOpen(offer(result.data.length));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [supported, key, userCreatedAt, sessionCreatedAt, passkeysVersion]);

  if (!open || !key) return null;

  function close() {
    if (key) writeDismissed(key);
    setOpen(false);
  }

  async function add() {
    setPending(true);
    setError(null);
    try {
      const result = await authClient.passkey.addPasskey();
      if (result.error) {
        setError(passkeyErrorText(result.error, t`Could not continue`));
        return;
      }
      close();
      passkeysChanged();
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      data-testid="passkey-offer"
      className="mx-3 mb-2 rounded-xl border border-border bg-card px-3 py-3 text-card-foreground"
    >
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-body">
          <Trans>Add a passkey for faster sign-in?</Trans>
        </p>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Dismiss`}
          disabled={pending}
          onClick={close}
        >
          <X />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-body-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button size="sm" className="mt-2" disabled={pending} onClick={() => void add()}>
        <Trans>Add passkey</Trans>
      </Button>
    </section>
  );
}
