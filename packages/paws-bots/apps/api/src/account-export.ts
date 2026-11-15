import type { AdapterContext, AgentHomeStore, ArtifactStore } from "@rakazo/adapter-kit";
import { resolveBotWorkspacePath } from "@rakazo/adapters";
import type { Auth } from "@rakazo/auth";
import type {
  AccountExportExecutables,
  AccountExportManifest,
  AccountExportRecord,
} from "@rakazo/contracts";
import {
  ACCOUNT_EXPORT_FORMAT,
  ACCOUNT_EXPORT_MANIFEST_PATH,
  ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES,
  ACCOUNT_EXPORT_VERSION,
  accountExportPaths,
} from "@rakazo/contracts";
import type { AccountExportSource, PrismaClient } from "@rakazo/db";
import {
  accountDeactivated,
  parseComputerMode,
  readAccountExport,
  runAsTenant,
  runGeneratorAsTenant,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { Zip, ZipDeflate } from "fflate";
import type { Hono } from "hono";

export type AccountExportStores = {
  artifacts: Pick<ArtifactStore, "get">;
  home: Pick<AgentHomeStore, "exportHome">;
};

type ArchiveFile = { path: string; data: AsyncIterable<Uint8Array> | Iterable<Uint8Array> };

const encoder = new TextEncoder();
/** Records are batched into chunks about this size, so deflate is not fed one line at a time. */
const RECORD_CHUNK_BYTES = 64 * 1024;
/** Files go to deflate in slices this size, so the archive limit is checked between them. */
const FILE_SLICE_BYTES = 1024 * 1024;
/** fflate writes no Zip64 records, so an archive must stay under 4 GiB; this leaves headroom. */
export const ACCOUNT_EXPORT_MAX_ARCHIVE_BYTES = 2 ** 32 - 64 * 1024 * 1024;

/**
 * Streams a zip of `files` in order. Pull-based: the next file or chunk is read only when the
 * consumer wants more bytes, so at most one chunk of input is held in memory. Cancelling the
 * stream or aborting `signal` (a client disconnect) stops the file generator and is not an error.
 */
export function zipStream(
  files: AsyncIterable<ArchiveFile>,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const maxBytes = options.maxBytes ?? ACCOUNT_EXPORT_MAX_ARCHIVE_BYTES;
  const zip = new Zip();
  const output: Uint8Array[] = [];
  let finished = false;
  let failure: Error | null = null;
  let written = 0;
  zip.ondata = (error, chunk, final) => {
    if (error) failure = error;
    else {
      written += chunk.length;
      if (written > maxBytes) failure = new Error("Account export exceeds the zip size limit");
      if (chunk.length) output.push(chunk);
      if (final) finished = true;
    }
  };
  async function* steps(): AsyncGenerator<void> {
    for await (const file of files) {
      const entry = new ZipDeflate(file.path, { level: 6 });
      zip.add(entry);
      for await (const chunk of file.data) {
        for (let offset = 0; offset < chunk.length; offset += FILE_SLICE_BYTES) {
          entry.push(chunk.subarray(offset, offset + FILE_SLICE_BYTES));
          yield;
        }
      }
      entry.push(new Uint8Array(0), true);
      yield;
    }
    zip.end();
  }
  const producer = steps();
  let cancelled = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (!output.length && !finished) {
            const step = await producer.next();
            // A cancel during this read ends the producer early; the client is gone.
            if (cancelled) return;
            if (failure) throw failure;
            if (step.done && !finished) throw new Error("Zip ended without its last chunk");
          }
          if (failure) throw failure;
        } catch (error) {
          if (error === failure || (!cancelled && !options.signal?.aborted)) {
            getLogger().error("account.export.failed", error);
            throw error;
          }
          getLogger().warn("account.export.aborted", {
            error: error instanceof Error ? error.message : String(error),
          });
          if (cancelled) return;
          throw error;
        }
        for (const chunk of output.splice(0)) controller.enqueue(chunk);
        if (finished && !output.length) controller.close();
      },
      async cancel() {
        cancelled = true;
        await producer.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

async function* jsonLines(records: AsyncIterable<AccountExportRecord>): AsyncGenerator<Uint8Array> {
  let batch = "";
  for await (const record of records) {
    batch += `${JSON.stringify(record)}\n`;
    if (batch.length >= RECORD_CHUNK_BYTES) {
      yield encoder.encode(batch);
      batch = "";
    }
  }
  if (batch) yield encoder.encode(batch);
}

/** manifest.json, then per space its records, artifact bytes and bot workspace files. */
export async function* accountArchiveFiles(
  source: AccountExportSource,
  stores: AccountExportStores,
  options: { signal?: AbortSignal; now?: Date } = {},
): AsyncGenerator<ArchiveFile> {
  const manifest: AccountExportManifest = {
    format: ACCOUNT_EXPORT_FORMAT,
    version: ACCOUNT_EXPORT_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    user: source.user,
    spaces: source.spaces.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
  };
  yield { path: ACCOUNT_EXPORT_MANIFEST_PATH, data: [encoder.encode(JSON.stringify(manifest))] };
  for (const space of source.spaces) {
    options.signal?.throwIfAborted();
    const tenant = { spaceId: space.id, userId: source.userId };
    const context = (botId?: string): AdapterContext => ({
      operationId: "account-export",
      traceId: "account-export",
      ...tenant,
      ...(botId ? { botId } : {}),
      signal: options.signal ?? new AbortController().signal,
    });
    yield { path: accountExportPaths.records(space.id), data: jsonLines(space.records()) };
    for await (const artifact of space.artifacts()) {
      let bytes: Uint8Array;
      try {
        bytes = await runAsTenant(tenant, () =>
          stores.artifacts.get(artifact.storageKey, context()),
        );
      } catch (error) {
        options.signal?.throwIfAborted();
        // One unreadable file should not cost the user the rest of their export.
        getLogger().warn("account.export.artifact_unreadable", {
          "artifact.id": artifact.id,
          "space.id": space.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      yield { path: accountExportPaths.artifact(space.id, artifact.id), data: [bytes] };
    }
    const executables: AccountExportExecutables = [];
    for (const home of await space.homes()) {
      const directory = resolveBotWorkspacePath(
        parseComputerMode(home.computerScope),
        home.botId,
        "",
      );
      const files = stores.home.exportHome(home.homeKey, context(home.botId), {
        directory,
        skipHidden: true,
      });
      for await (const file of runGeneratorAsTenant(tenant, iterate(files))) {
        if (file.content.length > ACCOUNT_EXPORT_MAX_HOME_FILE_BYTES) {
          getLogger().warn("account.export.home_file_too_large", {
            "bot.id": home.botId,
            "space.id": space.id,
            size: file.content.length,
          });
          continue;
        }
        if (file.executable) executables.push({ botId: home.botId, path: file.path });
        yield {
          path: accountExportPaths.homeFile(space.id, home.botId, file.path),
          data: [file.content],
        };
      }
    }
    if (executables.length)
      yield {
        path: accountExportPaths.executables(space.id),
        data: [encoder.encode(JSON.stringify(executables))],
      };
  }
}

async function* iterate<T>(items: AsyncIterable<T>): AsyncGenerator<T> {
  yield* items;
}

export function accountExportFilename(now = new Date()): string {
  return `rakazo-export-${now.toISOString().slice(0, 10)}.zip`;
}

/**
 * `GET /api/account/export?token=`: a plain navigation, so the browser or Electron saves the
 * download itself. The one-time token from `export.accountToken` is the only credential.
 */
export function mountAccountExportRoute(
  app: Hono,
  deps: AccountExportStores & {
    prisma: PrismaClient;
    auth: Pick<Auth, "consumeAccountExportToken">;
  },
): void {
  app.get("/api/account/export", async (c) => {
    const userId = await deps.auth.consumeAccountExportToken(c.req.query("token") ?? "");
    // A link issued just before the account was deactivated no longer downloads it.
    if (!userId || (await accountDeactivated(deps.prisma, userId)))
      return c.text("Export link expired", 410, { "cache-control": "no-store" });
    const now = new Date();
    const source = await readAccountExport(deps.prisma, userId);
    const signal = c.req.raw.signal;
    const body = zipStream(accountArchiveFiles(source, deps, { signal, now }), { signal });
    return new Response(body, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${accountExportFilename(now)}"`,
        "cache-control": "no-store",
      },
    });
  });
}
