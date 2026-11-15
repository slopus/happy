import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { withAbort } from "@rakazo/core";
import type { ContentLocation, PrismaClient } from "@rakazo/db";
import {
  CIPHERTEXT_PREFIX,
  ContentDecryptionError,
  ciphertextKeyId,
  contentEncryptionOf,
  decryptText,
  encryptText,
  VaultKeyOwnerGoneError,
} from "@rakazo/db";
import { INFISICAL_REF_PREFIX } from "./infisical-secret-store.js";

type VaultRow = { id: string; userId: string; spaceId: string | null };

// Vault keys sit beside the space keys under scopes no Space id can take: the account vault
// belongs to no Space, and a Space's content key exists long before `migrate` moves its vault.
const keyScope = (row: VaultRow) => (row.spaceId ? `vault:${row.spaceId}` : `user:${row.userId}`);
const location = (row: VaultRow): ContentLocation => ({
  table: "vault_credentials",
  column: "ciphertext",
  rowId: row.id,
  owner: row.userId,
});

function ringOf(prisma: PrismaClient) {
  const ring = contentEncryptionOf(prisma)?.ring;
  if (!ring) throw new Error("Vault item encryption is unavailable");
  return ring;
}

/** Read the newest stored version without unwrapping unrelated historical keys. */
async function newestVaultKey(prisma: PrismaClient, scope: string) {
  const key = await prisma.spaceKey.findFirst({
    where: { spaceId: scope },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  return key ? ringOf(prisma).byId(key.id) : undefined;
}

/**
 * A command's call to the key ring, given up at its interruption, since the key manager behind it
 * may hold a call open for longer; the call's own outcome stays handled, so a late answer is quiet.
 */
function interruptible<T>(call: Promise<T>, signal?: AbortSignal): Promise<T> {
  return signal ? withAbort(call, signal) : call;
}

/**
 * A vault item's stored value: under its vault's data key once `content-encryption migrate` has
 * created one, as content is. Until then the secret store keeps writing the format the previous
 * release reads, since it keeps running for a while after a deploy. An external secret store
 * always keeps the value itself.
 */
export async function sealVaultValue(
  prisma: PrismaClient,
  store: SecretStore,
  row: VaultRow,
  plaintext: string,
  context: AdapterContext,
): Promise<string> {
  const ring = contentEncryptionOf(prisma)?.ring;
  if (ring?.encryptWrites && store.describe().id === "app-encrypted") {
    const key = await interruptible(newestVaultKey(prisma, keyScope(row)), context.signal);
    if (key) return encryptText(key, location(row), plaintext);
  }
  return (await store.put(plaintext, context, { recordId: row.id })).ciphertext;
}

/** Reads both formats: values under a vault key, and those the secret store wrote before. */
export async function openVaultValue(
  prisma: PrismaClient,
  store: Pick<SecretStore, "load">,
  row: VaultRow & { ciphertext: string },
  signal?: AbortSignal,
): Promise<string> {
  if (!row.ciphertext.startsWith(CIPHERTEXT_PREFIX))
    return store.load(row.ciphertext, signal ? { recordId: row.id, signal } : row.id);
  return openSealedVaultValue(prisma, row, signal);
}

/**
 * A value under its vault's key; it names that key, and only a key of the row's vault opens it.
 * A request's `signal` ends the key lookup at its deadline, since the key manager may hold it
 * open for longer; the read writes nothing, so a lookup left behind is harmless.
 */
export async function openSealedVaultValue(
  prisma: PrismaClient,
  row: VaultRow & { ciphertext: string },
  signal?: AbortSignal,
): Promise<string> {
  const keyId = ciphertextKeyId(row.ciphertext);
  if (!keyId) throw new ContentDecryptionError("Vault item names no key");
  const ring = ringOf(prisma);
  const lookup = ring.byId(keyId).catch(async (error: unknown) => {
    // Check existence without unwrapping unrelated versions: missing keys are damaged data,
    // while an existing key that cannot unwrap retains the key manager's error.
    if (!(await prisma.spaceKey.findUnique({ where: { id: keyId }, select: { id: true } })))
      throw new ContentDecryptionError("Vault item names a key that no longer exists");
    throw error;
  });
  const key = await interruptible(lookup, signal);
  if (key.spaceId !== keyScope(row))
    throw new ContentDecryptionError("Vault item names another vault's key");
  return decryptText(key, location(row), row.ciphertext);
}

/**
 * Why an item could not be moved: the step that failed and the error's kind. Only a decryption
 * error's message is kept, since its text is fixed; other errors, from a secret store, a key
 * manager or the database, can quote the value or key material they were given.
 */
function failureReason(step: string, error: unknown) {
  if (error instanceof ContentDecryptionError) return `${step}: ${error.name}: ${error.message}`;
  const name = error instanceof Error && /^\w{1,64}$/.test(error.name) ? error.name : "Error";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[\w.-]{1,40}$/.test(code)
    ? `${step}: ${name} (${code})`
    : `${step}: ${name}`;
}

/**
 * `encrypt` moves values the secret store wrote into the envelope format, creating each vault's
 * key, after which new saves in that vault use it too; `reencrypt` moves only items under an
 * older version of their vault's key to its newest, creating no key; `decrypt` writes them
 * back, before rolling back to a release that cannot read it. Each row is a compare-and-set on its
 * value and date, so a concurrent save wins, as does a deletion; a row that cannot be read or
 * verified stays as it was and is reported with the reason, as is an item already under a vault
 * key that does not open. Values in an external store stay there. Safe to interrupt and rerun. Each vault's newest
 * key comes from the database, not this process's cache, since another process may have rotated it.
 */
export async function migrateVaultValues(
  prisma: PrismaClient,
  store: SecretStore,
  context: AdapterContext,
  options: {
    mode: "encrypt" | "reencrypt" | "decrypt";
    dryRun?: boolean;
    report?: (
      row: { id: string },
      status: "planned" | "migrated" | "concurrent" | "failed",
      reason?: string,
    ) => void;
  },
) {
  const counts = {
    migrated: 0,
    verified: 0,
    planned: 0,
    concurrent: 0,
    failed: 0,
    notMigrated: 0,
  };
  // Read only the newest record, then unwrap only that key. A cached current version can be
  // stale after another process rotates; loading every historical version also needlessly
  // depends on master keys that the current value does not use.
  const newestOf = (scope: string) => interruptible(newestVaultKey(prisma, scope), context.signal);
  let cursor = "";
  while (true) {
    context.signal.throwIfAborted();
    const batch = await prisma.vaultCredential.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: "asc" },
      take: 200,
      select: { id: true, userId: true, spaceId: true, ciphertext: true, updatedAt: true },
    });
    if (!batch.length) break;
    cursor = batch.at(-1)!.id;
    for (const row of batch) {
      // Each item may wait on the key manager, so an interruption stops before the next one.
      context.signal.throwIfAborted();
      const keyId = ciphertextKeyId(row.ciphertext);
      // A value in the previous format, not a sealed one naming no key: that one is damaged and
      // read, so it is reported.
      const previous = !row.ciphertext.startsWith(CIPHERTEXT_PREFIX);
      if (
        row.ciphertext.startsWith(INFISICAL_REF_PREFIX) ||
        (previous && options.mode === "decrypt")
      ) {
        counts.verified++;
        continue;
      }
      // Re-encryption moves only items already under a vault key. One in the previous format
      // stays as it is, readable by the previous release, until `migrate`, which alone creates a
      // vault's first key.
      if (previous && options.mode === "reencrypt") {
        counts.notMigrated++;
        continue;
      }
      let step = "read";
      let status: "migrated" | "concurrent" | "failed";
      try {
        const scope = keyScope(row);
        const newest = options.mode === "reencrypt" ? await newestOf(scope) : undefined;
        if (keyId && (options.mode === "encrypt" || keyId === newest?.id)) {
          // Already under its vault's key (its newest, to re-encrypt): read, never rewritten, so
          // an unreadable item is reported.
          await openSealedVaultValue(prisma, row, context.signal);
          counts.verified++;
          continue;
        }
        const plaintext = await openVaultValue(prisma, store, row, context.signal);
        // A preview reads each value but creates no key and writes nothing.
        if (options.dryRun) {
          counts.planned++;
          options.report?.(row, "planned");
          continue;
        }
        step = "write";
        let next: string;
        if (options.mode === "decrypt")
          next = (await store.put(plaintext, context, { recordId: row.id })).ciphertext;
        else if (options.mode === "encrypt") {
          const key =
            (await newestOf(scope)) ??
            (await interruptible(ringOf(prisma).current(scope, context.signal), context.signal));
          next = encryptText(key, location(row), plaintext);
        }
        // Its vault's keys were deleted with its member or Space after the item was read.
        else if (!newest) throw new VaultKeyOwnerGoneError();
        else next = encryptText(newest, location(row), plaintext);
        step = "check";
        if (
          (await openVaultValue(prisma, store, { ...row, ciphertext: next }, context.signal)) !==
          plaintext
        )
          throw new ContentDecryptionError("Rewritten vault value did not round-trip");
        step = "save";
        const { count } = await prisma.vaultCredential.updateMany({
          where: { id: row.id, ciphertext: row.ciphertext, updatedAt: row.updatedAt },
          data: { ciphertext: next, updatedAt: row.updatedAt },
        });
        status = count === 1 ? "migrated" : "concurrent";
      } catch (error) {
        context.signal.throwIfAborted();
        // Its member or Space was deleted meanwhile, and the item with it: its vault's keys are
        // shredded too, so a read of the item fails, which is no fault of the item. Whether the
        // item is still there decides; when that cannot be read, the failure stands.
        const gone =
          error instanceof VaultKeyOwnerGoneError ||
          (await prisma.vaultCredential.count({ where: { id: row.id } }).then(
            (count) => count === 0,
            () => false,
          ));
        context.signal.throwIfAborted();
        if (gone) status = "concurrent";
        else {
          counts.failed++;
          options.report?.(row, "failed", failureReason(step, error));
          continue;
        }
      }
      counts[status]++;
      options.report?.(row, status);
    }
    if (batch.length < 200) break;
  }
  return counts;
}

/**
 * Vault items `migrate` has yet to move: every value not under a vault key, apart from values in
 * an external store, which `migrate` leaves there. Read-only.
 */
export async function vaultItemsNotUnderKeys(
  prisma: PrismaClient,
): Promise<{ rows: number; waiting: number }> {
  const [counts] = await prisma.$queryRaw<Array<{ rows: bigint; waiting: bigint }>>`
    SELECT count(*) AS rows, count(*) FILTER (WHERE ciphertext NOT LIKE ${`${CIPHERTEXT_PREFIX}%`}
      AND ciphertext NOT LIKE ${`${INFISICAL_REF_PREFIX}%`}) AS waiting FROM vault_credentials`;
  return { rows: Number(counts!.rows), waiting: Number(counts!.waiting) };
}

/**
 * Vault items under a version of their vault's key other than the newest stored one, such as
 * saves a process sealed with the version it had cached when another process rotated the key.
 * `reencrypt` moves them. Items naming no key of their vault, as a damaged value or one whose key
 * was deleted does, cannot be moved and are counted apart, so they are not mistaken for items a
 * further `reencrypt` would move. Read-only: it compares the key id each value names, opens
 * nothing and unwraps no key.
 */
export async function vaultItemsUnderOlderKeys(
  prisma: PrismaClient,
): Promise<{ older: number; damaged: number }> {
  const count = { older: 0, damaged: 0 };
  let cursor = "";
  while (true) {
    const batch = await prisma.vaultCredential.findMany({
      where: { id: { gt: cursor }, ciphertext: { startsWith: CIPHERTEXT_PREFIX } },
      orderBy: { id: "asc" },
      take: 1000,
      select: { id: true, userId: true, spaceId: true, ciphertext: true },
    });
    if (!batch.length) break;
    // Both result sets are bounded by this batch, regardless of vault count or key history.
    const ids = [...new Set(batch.flatMap((row) => ciphertextKeyId(row.ciphertext) ?? []))];
    const scopes = [...new Set(batch.map(keyScope))];
    const [records, versions] = await Promise.all([
      prisma.spaceKey.findMany({
        where: { id: { in: ids } },
        select: { id: true, spaceId: true, version: true },
      }),
      prisma.spaceKey.groupBy({
        by: ["spaceId"],
        where: { spaceId: { in: scopes } },
        _max: { version: true },
      }),
    ]);
    const keys = new Map(records.map((key) => [key.id, key]));
    const newest = new Map(versions.map((key) => [key.spaceId, key._max.version]));
    for (const row of batch) {
      const keyId = ciphertextKeyId(row.ciphertext);
      const key = keyId ? keys.get(keyId) : undefined;
      const scope = keyScope(row);
      if (!key || key.spaceId !== scope) count.damaged++;
      else if (key.version < (newest.get(scope) ?? key.version)) count.older++;
    }
    if (batch.length < 1000) break;
    cursor = batch.at(-1)!.id;
  }
  return count;
}

/**
 * Adds a new version to every vault key, members' and Spaces' own alike, for
 * `rotate --reencrypt`; `reencrypt` then moves items to it. Older versions keep opening.
 * A key whose member or Space was deleted meanwhile has nothing left to protect and is skipped;
 * a key that fails to rotate is reported, and the rest still rotate.
 */
export async function rotateVaultKeys(
  prisma: PrismaClient,
  options: {
    signal?: AbortSignal;
    report?: (scope: string, status: "owner gone" | "failed", reason?: string) => void;
  } = {},
) {
  const ring = ringOf(prisma);
  const counts = { rotated: 0, ownerGone: 0, failed: 0 };
  let cursor = "";
  while (true) {
    options.signal?.throwIfAborted();
    const scopes = await prisma.spaceKey.groupBy({
      by: ["spaceId"],
      where: {
        spaceId: { gt: cursor },
        OR: [{ spaceId: { startsWith: "user:" } }, { spaceId: { startsWith: "vault:" } }],
      },
      orderBy: { spaceId: "asc" },
      take: 200,
    });
    if (!scopes.length) break;
    cursor = scopes.at(-1)!.spaceId;
    for (const { spaceId } of scopes) {
      options.signal?.throwIfAborted();
      try {
        await interruptible(ring.rotate(spaceId, options.signal), options.signal);
        counts.rotated++;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof VaultKeyOwnerGoneError) {
          counts.ownerGone++;
          options.report?.(spaceId, "owner gone");
        } else {
          counts.failed++;
          options.report?.(spaceId, "failed", failureReason("rotate", error));
        }
      }
    }
    if (scopes.length < 200) break;
  }
  return counts;
}
