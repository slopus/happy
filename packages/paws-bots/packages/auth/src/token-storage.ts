import type { PrismaClient } from "@rakazo/db";
import type { SecretConfig } from "better-auth/crypto";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

/** Better Auth's own token key: the auth secret, or its versioned secrets. */
export type TokenKey = string | SecretConfig;

/**
 * Better Auth encrypts access and refresh tokens but stores the ID token as
 * issued, so it is sealed here with the same cipher and key. An ID token is a
 * JWT and always contains a dot; the ciphertext never does, which keeps
 * sealing idempotent when Better Auth writes back a value it read.
 */
export async function sealIdToken(
  key: TokenKey,
  value: string | null | undefined,
): Promise<string | null | undefined> {
  return value?.includes(".") ? symmetricEncrypt({ key, data: value }) : value;
}

/** Reads a sealed ID token, or one stored before sealing. Unreadable values are null. */
export async function openIdToken(
  key: TokenKey,
  value: string | null | undefined,
): Promise<string | null> {
  if (!value) return null;
  if (value.includes(".")) return value;
  return symmetricDecrypt({ key, data: value }).catch(() => null);
}

async function isEncrypted(key: TokenKey, value: string) {
  // The cipher is authenticated, so only a value sealed with this key opens.
  return symmetricDecrypt({ key, data: value }).then(
    () => true,
    () => false,
  );
}

const BATCH = 100;

/**
 * Encrypts OAuth tokens written before encryption was enabled, so a database
 * copy does not hold them in plaintext. Idempotent, and each update applies
 * only if the row still holds the value that was read. Returns rows changed.
 */
export async function encryptStoredOAuthTokens(
  prisma: Pick<PrismaClient, "account">,
  key: TokenKey,
): Promise<number> {
  let changed = 0;
  let cursor: string | undefined;
  while (true) {
    const batch = await prisma.account.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        OR: [
          { accessToken: { not: null } },
          { refreshToken: { not: null } },
          { idToken: { not: null } },
        ],
      },
      select: { id: true, accessToken: true, refreshToken: true, idToken: true },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    for (const row of batch) {
      const data: { accessToken?: string; refreshToken?: string; idToken?: string } = {};
      for (const field of ["accessToken", "refreshToken"] as const) {
        const value = row[field];
        if (value && !(await isEncrypted(key, value)))
          data[field] = await symmetricEncrypt({ key, data: value });
      }
      const idToken = await sealIdToken(key, row.idToken);
      if (idToken && idToken !== row.idToken) data.idToken = idToken;
      if (!Object.keys(data).length) continue;
      const result = await prisma.account.updateMany({
        where: {
          id: row.id,
          accessToken: row.accessToken,
          refreshToken: row.refreshToken,
          idToken: row.idToken,
        },
        data,
      });
      changed += result.count;
    }
    if (batch.length < BATCH) return changed;
    cursor = batch.at(-1)?.id;
  }
}
