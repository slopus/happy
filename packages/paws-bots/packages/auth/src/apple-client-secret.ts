import type { KeyObject } from "node:crypto";
import { createPrivateKey, createSign } from "node:crypto";

export const APPLE_CLIENT_SECRET_AUDIENCE = "https://appleid.apple.com";
/** Apple rejects a client secret dated more than six months ahead. */
export const APPLE_CLIENT_SECRET_MAX_AGE_SECONDS = 15_777_000;
/** Default lifetime, under Apple's cap so clock skew cannot exceed it. */
export const APPLE_CLIENT_SECRET_LIFETIME_SECONDS = 150 * 24 * 60 * 60;
/** Resign while the current secret is still valid, so a long-lived process never waits on a restart. */
export const APPLE_CLIENT_SECRET_REFRESH_MARGIN_SECONDS = 14 * 24 * 60 * 60;

export interface AppleClientSecretInput {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
}

export interface SignedAppleClientSecret {
  token: string;
  expiresAt: Date;
}

/** Accepts a PEM block or the same block with escaped newlines, as an env value often stores it. */
export function normalizeApplePrivateKey(value: string): string {
  const pem = value.trim().replace(/\\n/g, "\n");
  if (!pem.includes("BEGIN PRIVATE KEY") || !pem.includes("END PRIVATE KEY")) {
    throw new Error("APPLE_PRIVATE_KEY must be a PKCS#8 PEM private key");
  }
  return pem.endsWith("\n") ? pem : `${pem}\n`;
}

export function appleSigningKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(normalizeApplePrivateKey(pem));
  } catch (cause) {
    throw new Error("APPLE_PRIVATE_KEY must be a PKCS#8 PEM private key", { cause });
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("APPLE_PRIVATE_KEY must be a P-256 private key");
  }
  return key;
}

/**
 * Signs the client secret Apple expects: an ES256 JWT whose subject is the Services ID.
 * The lifetime never reaches Apple's six-month ceiling.
 */
export function signAppleClientSecret(
  input: AppleClientSecretInput,
  now = new Date(),
  lifetimeSeconds = APPLE_CLIENT_SECRET_LIFETIME_SECONDS,
): SignedAppleClientSecret {
  const lifetime = Math.min(lifetimeSeconds, APPLE_CLIENT_SECRET_MAX_AGE_SECONDS - 60);
  if (!Number.isSafeInteger(lifetime) || lifetime <= 0) {
    throw new Error("Apple client secret lifetime is invalid");
  }
  const key = appleSigningKey(input.privateKey);
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + lifetime;
  const header = base64url(JSON.stringify({ alg: "ES256", kid: input.keyId }));
  const payload = base64url(
    JSON.stringify({
      iss: input.teamId,
      iat,
      exp,
      aud: APPLE_CLIENT_SECRET_AUDIENCE,
      sub: input.clientId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key, dsaEncoding: "ieee-p1363" });
  return { token: `${signingInput}.${base64url(signature)}`, expiresAt: new Date(exp * 1000) };
}

/** Synchronous signing keeps even the first provider read valid; no refresh timer is needed. */
export function createAppleClientSecretCache(
  input: AppleClientSecretInput,
  options?: {
    now?: () => Date;
    lifetimeSeconds?: number;
    refreshMarginSeconds?: number;
  },
) {
  const now = options?.now ?? (() => new Date());
  const margin =
    (options?.refreshMarginSeconds ?? APPLE_CLIENT_SECRET_REFRESH_MARGIN_SECONDS) * 1000;
  let cached: SignedAppleClientSecret | undefined;
  return {
    current() {
      const at = now();
      if (!cached || cached.expiresAt.getTime() - margin <= at.getTime()) {
        cached = signAppleClientSecret(input, at, options?.lifetimeSeconds);
      }
      return cached.token;
    },
  };
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}
