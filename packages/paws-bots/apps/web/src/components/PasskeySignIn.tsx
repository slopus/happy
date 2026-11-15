import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { authClient } from "../lib/auth";
import {
  cancelPasskeyRequest,
  conditionalPasskeyAvailable,
  passkeyErrorText,
  usePasskeysSupported,
} from "../lib/passkeys";

type PasskeySignInOptions = {
  onSignedIn: () => void;
  onError: (message: string | null) => void;
  /** Offers saved passkeys in browser autofill on the email field (`autocomplete="username webauthn"`). */
  autoFill?: boolean;
};

export function usePasskeySignIn({ onSignedIn, onError, autoFill = false }: PasskeySignInOptions) {
  const { t } = useLingui();
  const supported = usePasskeysSupported();
  const [pending, setPending] = useState(false);
  const callbacks = useRef({ onSignedIn, onError, t });
  callbacks.current = { onSignedIn, onError, t };
  const mounted = useRef(true);

  async function signIn(conditional: boolean) {
    const result = await authClient.signIn
      .passkey({ autoFill: conditional })
      .catch((error: unknown) => ({ data: null, error }));
    if (!mounted.current) return;
    const { onSignedIn, onError, t } = callbacks.current;
    if (result.error) {
      const message = passkeyErrorText(result.error, t`Could not continue`);
      if (message) onError(message);
      return;
    }
    onSignedIn();
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the form (or switching to the code step) must not leave autofill waiting.
      cancelPasskeyRequest();
    };
  }, []);

  useEffect(() => {
    if (!supported || !autoFill) return;
    // Starting another ceremony aborts this one; an unmounted page ignores its result.
    void conditionalPasskeyAvailable().then((available) => {
      if (available && mounted.current) void signIn(true);
    });
  }, [supported, autoFill]);

  return {
    supported,
    pending,
    start() {
      setPending(true);
      callbacks.current.onError(null);
      void signIn(false).finally(() => {
        if (mounted.current) setPending(false);
      });
    },
  };
}

/** Passkey sign-in for the email form: browser autofill, plus a button unless `autoFillOnly`. */
export function PasskeySignIn({
  className,
  disabled,
  autoFillOnly,
  onSignedIn,
  onError,
}: {
  className?: string;
  disabled?: boolean;
  autoFillOnly?: boolean;
  onSignedIn: () => void;
  onError: (message: string | null) => void;
}) {
  const passkey = usePasskeySignIn({ onSignedIn, onError, autoFill: true });
  if (!passkey.supported || autoFillOnly) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      disabled={disabled || passkey.pending}
      className={className}
      onClick={passkey.start}
    >
      <Trans>Sign in with passkey</Trans>
    </Button>
  );
}
