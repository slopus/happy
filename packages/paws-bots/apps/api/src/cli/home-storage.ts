import { parseArgs } from "node:util";
import {
  contentKeyProviderFromEnv,
  createAgentHomeStore,
  ObjectAgentHomeStore,
  unwrapEnvFromKeyManager,
} from "@rakazo/adapters";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { createDb } from "@rakazo/db";

loadRootEnv();
await unwrapEnvFromKeyManager();

const USAGE = `Usage: home-storage migrate [--dry-run]
  migrate   Upload homes that exist only under DATA_DIR/homes to object storage and verify
            each upload. Homes already stored are skipped, so it can be rerun. Local copies
            are kept; see docs/self-host-storage.md#bot-homes-in-object-storage to remove them.`;

function parseCommand() {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { "dry-run": { type: "boolean" } },
    });
    return positionals.length === 1 && positionals[0] === "migrate"
      ? { dryRun: values["dry-run"] === true }
      : undefined;
  } catch {
    return undefined;
  }
}

const parsed = parseCommand();
if (!parsed) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const { prisma, pool } = createDb(process.env.DATABASE_URL, {
  applicationName: "rakazo-home-storage",
  keyProvider: contentKeyProviderFromEnv(),
});
const write = (line: string) => process.stdout.write(`${line}\n`);
let stopping = false;
const stop = () => {
  stopping = true;
  process.exitCode = 1;
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  const home = createAgentHomeStore(process.env.DATA_DIR ?? "./data", prisma);
  if (!(home instanceof ObjectAgentHomeStore))
    throw new Error("Set OBJECT_STORAGE_BUCKET and its credentials first");
  const counts = { uploaded: 0, "would-upload": 0, stored: 0, "no-computer": 0, failed: 0 };
  for (const homeKey of await home.localHomes()) {
    if (stopping) break;
    try {
      const status = await home.migrateLocal(homeKey, { dryRun: parsed.dryRun });
      counts[status] += 1;
      if (status !== "stored") write(`home ${homeKey}: ${status}`);
    } catch (error) {
      counts.failed += 1;
      write(
        `home ${homeKey}: failed (${error instanceof Error ? error.message : "unknown error"})`,
      );
      process.exitCode = 1;
    }
  }
  write(
    `homes: ${counts.uploaded} uploaded and verified, ${counts["would-upload"]} to upload, ${counts.stored} already stored, ${counts["no-computer"]} without a computer (left alone), ${counts.failed} failed`,
  );
  if (stopping) write("stopped early; run it again to continue");
} catch (error) {
  process.stderr.write(
    `home-storage migrate failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
