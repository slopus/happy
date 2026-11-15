import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import {
  contentKeyProviderFromEnv,
  createSecretStore,
  EncryptedSecretStore,
  LocalArtifactStore,
  migrateVaultValues,
  rotateVaultKeys,
  unwrapEnvFromKeyManager,
  upgradeLegacySecrets,
  vaultItemsNotUnderKeys,
  vaultItemsUnderOlderKeys,
  withSecretPersistence,
} from "@rakazo/adapters";
import { resolveContentEncryption, resolveEncryptionKey } from "@rakazo/core";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import type { ContentMigrationMode } from "@rakazo/db";
import {
  contentEncryptionStatus,
  createDb,
  exportContent,
  migrateContent,
  rewrapSpaceKeys,
  rotateSpaceDataKeys,
  runAsSystem,
} from "@rakazo/db";
import { moveMcpArgsIntoSecrets } from "../mcp-args-migration.js";
import { createSecretMigrationRepository } from "../secret-migration.js";

loadRootEnv();
await unwrapEnvFromKeyManager();

const USAGE = `Usage: content-encryption <command> [--dry-run]
  status               Rows and artifacts still in plaintext, vault items under an older
                       key version, keys per master key
  migrate              Encrypt existing content, upgrade legacy credentials, move
                       vault values to the content keys and MCP server arguments
                       into their encrypted credentials
  rotate [--reencrypt] Re-wrap space keys under the active master key; with
                       --reencrypt also add new data keys and re-encrypt content
                       and vault values
  reencrypt            Re-encrypt content and vault values still under an older
                       data key
  decrypt              Write plaintext back, after CONTENT_ENCRYPTION=off or
                       before rolling back to an older release
  export [--space <id>] [--thread <id>] [--bot <id>] [--output <file>]
                       Write decrypted threads, messages and memory as JSON lines`;

const COMMANDS = ["status", "migrate", "rotate", "reencrypt", "decrypt", "export"];
const EXPORT_OPTIONS = ["space", "thread", "bot", "output"] as const;

function parseCommand() {
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        "dry-run": { type: "boolean" },
        reencrypt: { type: "boolean" },
        space: { type: "string" },
        thread: { type: "string" },
        bot: { type: "string" },
        output: { type: "string" },
      },
    });
    const [command, ...rest] = positionals;
    const exporting = command === "export";
    if (
      !command ||
      !COMMANDS.includes(command) ||
      rest.length ||
      (values.reencrypt && command !== "rotate") ||
      (values["dry-run"] && exporting) ||
      (!exporting && EXPORT_OPTIONS.some((name) => values[name] !== undefined)) ||
      EXPORT_OPTIONS.some((name) => values[name] === "")
    )
      return undefined;
    return { command, values };
  } catch {
    return undefined;
  }
}

const parsed = parseCommand();
if (!parsed) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
const { command, values: flags } = parsed;
const dryRun = flags["dry-run"] === true;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

// Encrypting commands seal content whatever CONTENT_ENCRYPTION says; the rest
// only read, or write plaintext back.
const encrypting = ["migrate", "rotate", "reencrypt"].includes(command);
const { prisma, pool, contentKeys } = createDb(process.env.DATABASE_URL, {
  applicationName: "rakazo-content-encryption",
  keyProvider: contentKeyProviderFromEnv(),
  ...(encrypting ? { encryptContent: true } : {}),
});
const artifacts = new LocalArtifactStore(process.env.DATA_DIR ?? "./data", contentKeys);
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const write = (line: string) => process.stdout.write(`${line}\n`);

/** JSON lines to stdout, or to a new owner-only file; the export holds plaintext. */
async function exportJsonLines() {
  let records = 0;
  async function* lines() {
    for await (const record of exportContent(
      prisma,
      { spaceId: flags.space, threadId: flags.thread, botId: flags.bot },
      { signal: controller.signal },
    )) {
      records += 1;
      yield `${JSON.stringify(record)}\n`;
    }
  }
  // pipeline surfaces write errors (a full disk, a closed pipe) and closes the file on failure.
  if (flags.output) {
    await pipeline(lines(), createWriteStream(flags.output, { flags: "wx", mode: 0o600 }));
    write(`export: ${records} records written to ${flags.output}`);
  } else {
    await pipeline(lines(), process.stdout, { end: false });
    process.stderr.write(`export: ${records} records\n`);
  }
}

async function rewriteContent(mode: ContentMigrationMode) {
  if (!(await artifacts.hasDirectory()))
    write("artifacts: no artifact directory under DATA_DIR; files were not checked");
  else if (!dryRun) {
    const removed = await artifacts.removeAbandoned();
    if (removed) write(`artifacts: removed ${removed} temporary files left by an interrupted run`);
  }
  for (const table of await migrateContent(prisma, {
    mode,
    dryRun,
    signal: controller.signal,
  }))
    write(
      `${table.table}: ${table.updated} of ${table.scanned} ${dryRun ? "to rewrite" : "rewritten"}`,
    );
  let files = 0;
  let rewritten = 0;
  for await (const file of artifacts.files()) {
    controller.signal.throwIfAborted();
    files += 1;
    try {
      if (dryRun) continue;
      if ((await artifacts.rewriteFile(file.spaceId, file.id, mode)) === "rewritten")
        rewritten += 1;
    } catch {
      write(`artifact ${file.spaceId}/${file.id}: failed`);
      process.exitCode = 1;
    }
  }
  write(`artifacts: ${dryRun ? "not checked in a dry run" : `${rewritten} of ${files} rewritten`}`);
}

async function upgradeCredentials() {
  const counts = await upgradeLegacySecrets(
    createSecretMigrationRepository(prisma),
    new EncryptedSecretStore(resolveEncryptionKey(process.env)),
    {
      operationId: "content-encryption",
      traceId: "content-encryption",
      userId: "migration",
      spaceId: "migration",
      signal: controller.signal,
    },
    { dryRun, report: (row, status) => write(`credential ${row.label} ${row.id}: ${status}`) },
  );
  write(
    `credentials: ${counts.migrated} upgraded, ${counts.planned} planned, ${counts.verified} current, ${counts.concurrent} changed concurrently, ${counts.failed} failed`,
  );
  if (counts.failed) process.exitCode = 1;
}

async function rewriteVaultValues(mode: "encrypt" | "reencrypt" | "decrypt") {
  const counts = await migrateVaultValues(
    prisma,
    new EncryptedSecretStore(resolveEncryptionKey(process.env)),
    {
      operationId: "content-encryption",
      traceId: "content-encryption",
      userId: "migration",
      spaceId: "migration",
      signal: controller.signal,
    },
    {
      mode,
      dryRun,
      report: (row, status, reason) =>
        write(`vault item ${row.id}: ${status}${reason ? ` (${reason})` : ""}`),
    },
  );
  write(
    `vault items: ${counts.migrated} rewritten, ${counts.planned} planned, ${counts.verified} current, ${counts.concurrent} changed concurrently, ${counts.failed} failed${
      counts.notMigrated ? `, ${counts.notMigrated} not under a vault key (run migrate)` : ""
    }`,
  );
  if (counts.failed) process.exitCode = 1;
}

async function moveMcpArgs() {
  const secrets = createSecretStore(resolveEncryptionKey(process.env));
  await secrets.start();
  try {
    const counts = await moveMcpArgsIntoSecrets(withSecretPersistence(prisma, secrets), secrets, {
      dryRun,
      signal: controller.signal,
    });
    write(
      `mcp server arguments: ${counts.moved} encrypted, ${counts.planned} planned, ${counts.concurrent} changed concurrently, ${counts.failed} failed`,
    );
    if (counts.failed) process.exitCode = 1;
  } finally {
    await secrets.close();
  }
}

// Reads or rewrites every tenant's content, so it runs across Spaces.
try {
  await runAsSystem("content encryption maintenance", async () => {
    if (command === "status") {
      const status = await contentEncryptionStatus(prisma);
      for (const table of status.tables)
        write(`${table.table}: ${table.plaintext} of ${table.rows} in plaintext`);
      const waiting = await vaultItemsNotUnderKeys(prisma);
      write(
        `vault_credentials: ${waiting.waiting} of ${waiting.rows} not yet under the content keys`,
      );
      const vaultItems = await vaultItemsUnderOlderKeys(prisma);
      write(
        `vault items under an older vault key version: ${vaultItems.older} (reencrypt moves them)`,
      );
      if (vaultItems.damaged)
        write(
          `vault items naming no key of their vault: ${vaultItems.damaged} (damaged; no command moves them)`,
        );
      for (const [masterKeyId, count] of Object.entries(status.masterKeys))
        write(`space keys under master key ${masterKeyId}: ${count}`);
      write(`active master key: ${contentKeys.provider.activeKeyId()}`);
      const files = await artifacts.fileCounts();
      write(
        files.present
          ? `artifacts: ${files.plaintext} of ${files.plaintext + files.sealed} in plaintext${
              files.abandoned
                ? `, ${files.abandoned} temporary files from an interrupted run (migrate removes them)`
                : ""
            }`
          : "artifacts: no artifact directory under DATA_DIR; run where the data volume is mounted",
      );
    } else if (command === "migrate") {
      if (!resolveContentEncryption(process.env))
        write("CONTENT_ENCRYPTION is off: new content is still stored in plaintext");
      await rewriteContent("encrypt");
      await upgradeCredentials();
      await rewriteVaultValues("encrypt");
      await moveMcpArgs();
    } else if (command === "rotate") {
      const keys = await rewrapSpaceKeys(prisma, contentKeys, {
        dryRun,
        signal: controller.signal,
      });
      write(`space keys: ${keys.rewrapped} re-wrapped, ${keys.current} already current`);
      if (flags.reencrypt && !dryRun) {
        write(
          `data keys: ${await rotateSpaceDataKeys(prisma, contentKeys, { signal: controller.signal })} spaces rotated`,
        );
        const vaultKeys = await rotateVaultKeys(prisma, {
          signal: controller.signal,
          report: (scope, status, reason) =>
            write(`vault key ${scope}: ${status}${reason ? ` (${reason})` : ""}`),
        });
        write(
          `vault keys: ${vaultKeys.rotated} rotated, ${vaultKeys.ownerGone} owner gone, ${vaultKeys.failed} failed`,
        );
        // Items under the keys that did rotate still move; the command fails once it is done.
        if (vaultKeys.failed) process.exitCode = 1;
        await rewriteContent("reencrypt");
        await rewriteVaultValues("reencrypt");
      }
    } else if (command === "reencrypt") {
      await rewriteContent("reencrypt");
      await rewriteVaultValues("reencrypt");
    } else if (command === "export") {
      await exportJsonLines();
    } else {
      if (resolveContentEncryption(process.env))
        write(
          "CONTENT_ENCRYPTION is on: new content and vault saves are still encrypted; set it to off before rolling back",
        );
      await rewriteContent("decrypt");
      await rewriteVaultValues("decrypt");
    }
  });
} catch (error) {
  process.stderr.write(
    `content-encryption ${command} failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
