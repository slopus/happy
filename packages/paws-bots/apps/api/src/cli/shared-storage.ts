import { parseArgs } from "node:util";
import {
  contentKeyProviderFromEnv,
  createArtifactStore,
  LocalArtifactStore,
  migrateLocalArtifacts,
  migrateLocalPushTokens,
  PrismaPushTokenStore,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb } from "@rakazo/db";

loadRootEnv();
await unwrapEnvFromKeyManager();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean" } },
});
if (positionals.length !== 1 || !["artifacts", "push-tokens"].includes(positionals[0]!))
  throw new Error(
    "Usage: shared-storage <artifacts|push-tokens> [--dry-run] (see docs/self-host-storage.md#shared-storage-migration)",
  );
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const { prisma, pool, contentKeys } = createDb(process.env.DATABASE_URL, {
  applicationName: "rakazo-storage-migration",
  keyProvider: contentKeyProviderFromEnv(),
});
const dataDir = process.env.DATA_DIR ?? "./data";
try {
  const counts =
    positionals[0] === "artifacts"
      ? await migrateLocalArtifacts(
          prisma,
          new LocalArtifactStore(dataDir, contentKeys),
          createArtifactStore(dataDir, prisma),
          { dryRun: values["dry-run"] },
        )
      : await migrateLocalPushTokens(
          dataDir,
          new PrismaPushTokenStore(prisma, resolveEncryptionKey(process.env)),
          values["dry-run"],
        );
  // Counts only: never print registrations, object paths, or account identifiers.
  process.stdout.write(`${JSON.stringify(counts)}\n`);
} finally {
  await prisma.$disconnect();
  await pool.end();
}
