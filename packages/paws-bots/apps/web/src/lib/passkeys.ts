import { t } from "@lingui/core/macro";
import { hostMatchesPasskeyRpId } from "@rakazo/core";
import { WebAuthnAbortService } from "@simplewebauthn/browser";
import { useEffect, useState, useSyncExternalStore } from "react";
import { fetchAuthCapabilities } from "./auth-capabilities";
import type { RakazoDesktop } from "./desktop";
import { desktopBridge } from "./desktop";
import { authErrorText } from "./user-error";

type PasskeyBrowser = {
  host: string;
  credential?: {
    isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
  };
  desktop?: Pick<RakazoDesktop, "platform" | "passkeys">;
};

function currentBrowser(): PasskeyBrowser {
  return {
    host: window.location.hostname,
    credential: typeof PublicKeyCredential === "undefined" ? undefined : PublicKeyCredential,
    desktop: desktopBridge(),
  };
}

/** The macOS app reaches passkeys through the system sheet, which serves only its associated domains. */
function systemPasskeysDesktop(desktop: PasskeyBrowser["desktop"]): boolean {
  return desktop?.platform === "darwin";
}

async function desktopAssociated(desktop: PasskeyBrowser["desktop"], rpId: string) {
  if (!systemPasskeysDesktop(desktop)) return true;
  try {
    return (await desktop?.passkeys?.rpIds())?.includes(rpId.toLowerCase()) === true;
  } catch {
    return false;
  }
}

/**
 * Whether this page can use passkeys: the server offers a relying party this host
 * belongs to, and the browser has a ready platform authenticator. The macOS app also
 * needs to be associated with that relying party, or the system sheet refuses it.
 */
export async function passkeysSupported(
  rpId: string | null | undefined,
  browser: PasskeyBrowser = currentBrowser(),
): Promise<boolean> {
  if (!browser.credential?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
  if (!rpId || !hostMatchesPasskeyRpId(browser.host, rpId)) return false;
  if (!(await desktopAssociated(browser.desktop, rpId))) return false;
  try {
    return await browser.credential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** False until the deployment and browser are known to support passkeys. */
export function usePasskeysSupported(): boolean {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let active = true;
    void fetchAuthCapabilities()
      .then((capabilities) => passkeysSupported(capabilities.passkeyRpId))
      .then((value) => {
        if (active) setSupported(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return supported;
}

let passkeysVersion = 0;
const passkeyListeners = new Set<() => void>();

/** Tells every passkey view on the page that the account's passkeys changed. */
export function passkeysChanged() {
  passkeysVersion += 1;
  for (const listener of passkeyListeners) listener();
}

/** Changes whenever this page adds or removes a passkey, so views can reload their list. */
export function usePasskeysVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      passkeyListeners.add(listener);
      return () => passkeyListeners.delete(listener);
    },
    () => passkeysVersion,
  );
}

/** Cancels a pending WebAuthn request, such as browser autofill, when its view goes away. */
export function cancelPasskeyRequest() {
  WebAuthnAbortService.cancelCeremony();
}

/**
 * Electron's system passkey sheet is modal and has no autofill mode, so on macOS a
 * conditional request would open it as soon as the form appears. The button opens it instead.
 */
export async function conditionalPasskeyAvailable(
  desktop: PasskeyBrowser["desktop"] = desktopBridge(),
): Promise<boolean> {
  if (typeof PublicKeyCredential === "undefined" || systemPasskeysDesktop(desktop)) return false;
  try {
    return (await PublicKeyCredential.isConditionalMediationAvailable?.()) === true;
  } catch {
    return false;
  }
}

// The OS dialog was dismissed, timed out, or replaced by another ceremony.
const CANCELLED_CODES = new Set([
  "AUTH_CANCELLED",
  "ERROR_CEREMONY_ABORTED",
  "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
]);

/** Text for a failed passkey result, or null when the user closed the dialog. */
export function passkeyErrorText(error: unknown, fallback: string): string | null {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (typeof code === "string" && CANCELLED_CODES.has(code)) return null;
  // Adding a passkey needs a recent sign-in.
  if (code === "SESSION_NOT_FRESH") return t`Sign in again`;
  // Other browser WebAuthn errors carry implementation detail.
  if (typeof code === "string" && code.startsWith("ERROR_")) return fallback;
  return authErrorText(error, fallback);
}
