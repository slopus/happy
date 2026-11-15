import { isIP } from "node:net";

export interface PasskeyRelyingParty {
  rpID: string;
  /** Exact WebAuthn client origins: the web app plus any associated Android app signers. */
  origins: string[];
}

/**
 * The deployment's WebAuthn relying party, derived from its web origin so a
 * self-hosted domain works without extra configuration. Returns null where a
 * browser cannot create passkeys at all: IP addresses and plain-HTTP hosts
 * other than localhost.
 */
export function passkeyRelyingParty(
  webOrigin: string,
  androidCertFingerprints: readonly string[] = [],
): PasskeyRelyingParty | null {
  let url: URL;
  try {
    url = new URL(webOrigin);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (loopback) {
    // WebAuthn rejects IP relying parties, so loopback deployments use the localhost twin.
    const local = new URL(url.origin);
    local.hostname = "localhost";
    return { rpID: "localhost", origins: [local.origin] };
  }
  if (isIP(host) || url.protocol !== "https:") return null;
  return {
    rpID: host,
    origins: [url.origin, ...androidCertFingerprints.flatMap(androidApkKeyHashOrigin)],
  };
}

/**
 * Android Credential Manager reports `android:apk-key-hash:<SHA-256 of the signer>`, in
 * base64url on most devices and unpadded standard base64 on some.
 */
export function androidApkKeyHashOrigin(fingerprint: string): string[] {
  const hex = fingerprint.replace(/:/g, "").trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) return [];
  const hash = Buffer.from(hex, "hex");
  const encodings = new Set([
    hash.toString("base64url"),
    hash.toString("base64").replace(/=+$/, ""),
  ]);
  return [...encodings].map((encoded) => `android:apk-key-hash:${encoded}`);
}
