import {
  ComposedSecretStore,
  contentKeyProviderFromEnv,
  EncryptedSecretStore,
  InfisicalSecretStore,
  migrateSecrets,
  PostgresRealtimeFanout,
  secretStoreOptionsFromEnv,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb, runAsSystem } from "@rakazo/db";
import { createSecretMigrationRepository } from "../secret-migration.js";

loadRootEnv();
await unwrapEnvFromKeyManager();

const args = process.argv.slice(2);
if (args.some((arg) => !["--dry-run", "--reverse"].includes(arg)))
  throw new Error("Usage: secrets:infisical [--dry-run] [--reverse]");
const options = secretStoreOptionsFromEnv({ ...process.env, SECRET_STORE: "infisical" });
if (!options || !process.env.DATABASE_URL)
  throw new Error("Secret storage and database configuration are required");
const { prisma, pool } = createDb(process.env.DATABASE_URL, {
  keyProvider: contentKeyProviderFromEnv(),
});
const encryptionKey = resolveEncryptionKey(process.env);
const realtime = new PostgresRealtimeFanout({
  connectionString: process.env.REALTIME_DATABASE_URL ?? process.env.DATABASE_URL,
  publisher: pool,
});
const encrypted = new ComposedSecretStore(
  new EncryptedSecretStore(encryptionKey),
  undefined,
  realtime,
);
const infisical = new ComposedSecretStore(
  new EncryptedSecretStore(encryptionKey),
  new InfisicalSecretStore(options),
  realtime,
);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const repository = createSecretMigrationRepository(prisma);
try {
  await encrypted.start();
  await infisical.start();
  // Migrates every tenant's secrets.
  const result = await runAsSystem("secret store migration", () =>
    migrateSecrets(
      repository,
      encrypted,
      infisical,
      {
        operationId: "secret-migration",
        traceId: "secret-migration",
        userId: "migration",
        spaceId: "migration",
        signal: controller.signal,
      },
      {
        direction: args.includes("--reverse") ? "reverse" : "forward",
        dryRun: args.includes("--dry-run"),
        report: (row, status) => process.stdout.write(`${row.label} ${row.id}: ${status}\n`),
      },
    ),
  );
  if (result.failed || controller.signal.aborted) process.exitCode = 1;
} catch {
  process.stderr.write("Secret migration failed\n");
  process.exitCode = 1;
} finally {
  await infisical.close();
  await encrypted.close();
  await realtime.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
