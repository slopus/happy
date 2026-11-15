import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { isCiphertext } from "@rakazo/db";
import { INFISICAL_REF_PREFIX } from "./infisical-secret-store.js";
import { deleteSecretBestEffort } from "./secret-store-factory.js";

export interface SecretMigrationRow {
  id: string;
  label: string;
  ref: string;
  recordId: string;
  ephemeral?: boolean;
  /** A vault item's date, kept when its value moves, since a card approval checks it. */
  updatedAt?: Date;
  /**
   * Reads a vault value kept under its vault's data key, which no secret store can; the read is
   * given up at `signal`, the command's interruption.
   */
  open?: (signal: AbortSignal) => Promise<string>;
}
export interface SecretMigrationRepository {
  rows(): AsyncIterable<SecretMigrationRow>;
  /** Compare both id and original ref; a concurrent replacement always wins. */
  replace(row: SecretMigrationRow, ref: string): Promise<boolean>;
  referenced(ref: string): Promise<boolean>;
}
export interface SecretMigrationOptions {
  direction: "forward" | "reverse";
  dryRun?: boolean;
  report?: (
    row: Pick<SecretMigrationRow, "id" | "label">,
    status: "verified" | "planned" | "migrated" | "concurrent" | "failed",
  ) => void;
}

/**
 * Rewrites credentials still in the pre-v2 format (SHA-256 key, no AAD) as v2
 * ciphertext bound to the same record id that reads use. Compare-and-set per
 * row; a concurrent replacement wins and is reported as such. Rerun-safe.
 */
export async function upgradeLegacySecrets(
  repository: SecretMigrationRepository,
  encrypted: SecretStore,
  context: AdapterContext,
  options: Pick<SecretMigrationOptions, "dryRun" | "report"> = {},
) {
  const counts = { migrated: 0, verified: 0, planned: 0, concurrent: 0, failed: 0 };
  for await (const row of repository.rows()) {
    if (context.signal.aborted) break;
    if (
      row.ref.startsWith("v2:") ||
      row.ref.startsWith(INFISICAL_REF_PREFIX) ||
      isCiphertext(row.ref)
    ) {
      counts.verified++;
      continue;
    }
    try {
      const plaintext = await encrypted.load(row.ref, {
        recordId: row.recordId,
        signal: context.signal,
      });
      if (options.dryRun) {
        counts.planned++;
        options.report?.(row, "planned");
        continue;
      }
      const record = await encrypted.put(plaintext, context, { recordId: row.recordId });
      const check = await encrypted.load(record.ref, {
        recordId: row.recordId,
        signal: context.signal,
      });
      if (check !== plaintext) throw new Error("Upgraded credential did not round-trip");
      const status = (await repository.replace(row, record.ref)) ? "migrated" : "concurrent";
      counts[status]++;
      options.report?.(row, status);
    } catch {
      counts.failed++;
      options.report?.(row, "failed");
    }
  }
  return counts;
}

/** The persisted ref is the resume marker. No progress precedes a successful CAS. */
export async function migrateSecrets(
  repository: SecretMigrationRepository,
  encrypted: SecretStore,
  infisical: SecretStore,
  context: AdapterContext,
  options: SecretMigrationOptions,
) {
  const counts = { migrated: 0, verified: 0, planned: 0, concurrent: 0, failed: 0 };
  for await (const row of repository.rows()) {
    let written: string | undefined;
    let persisted = false;
    let destination: SecretStore | undefined;
    try {
      context.signal.throwIfAborted();
      const remote = row.ref.startsWith(INFISICAL_REF_PREFIX);
      const source = remote ? infisical : encrypted;
      const plaintext = row.open
        ? await row.open(context.signal)
        : await source.load(row.ref, { recordId: row.recordId, signal: context.signal });
      const targetRemote = options.direction === "forward" && !row.ephemeral;
      if (remote === targetRemote) {
        counts.verified++;
        options.report?.(row, "verified");
        continue;
      }
      if (options.dryRun) {
        counts.planned++;
        options.report?.(row, "planned");
        continue;
      }
      const target = targetRemote ? infisical : encrypted;
      destination = target;
      const record = await target.put(plaintext, context, { recordId: row.recordId });
      written = record.ref;
      persisted = await repository.replace(row, record.ref);
      if (!persisted) {
        await deleteSecretBestEffort(target, record.ref, row.recordId);
        written = undefined;
        counts.concurrent++;
        options.report?.(row, "concurrent");
        continue;
      }
      counts.migrated++;
      options.report?.(row, "migrated");
      if (!(await repository.referenced(row.ref)))
        await deleteSecretBestEffort(source, row.ref, row.recordId);
    } catch {
      if (written && !persisted) {
        // A transport failure can leave the DB commit outcome unknown. Never
        // delete a value unless persistence confirms that it is unreferenced.
        try {
          if (!(await repository.referenced(written)))
            await deleteSecretBestEffort(destination!, written, row.recordId);
        } catch {
          /* Keep the write until its persistence outcome can be verified. */
        }
      }
      // A row deleted or replaced before it was read, as a vault item is when its member is
      // deleted, which shreds the key that opens it, is no failure of the move. When that cannot
      // be checked, the failure stands.
      const stillStored =
        written !== undefined || (await repository.referenced(row.ref).catch(() => true));
      const status = stillStored ? "failed" : "concurrent";
      counts[status]++;
      options.report?.(row, status);
      if (context.signal.aborted) break;
    }
  }
  return counts;
}
