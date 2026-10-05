import { createReadStream } from 'node:fs';
import { readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// Zero-based, half-open line ranges. Sidecars preserve native rollout bytes and
// SQLite offsets, while allowing A -> B -> A to retain each account's usage.
export type ImportedUsageRange = [number, number];
const boundaryPath = (rollout: string) => `${rollout}.paws-imported-usage.json`;
export async function readImportedUsageRanges(rollout: string): Promise<ImportedUsageRange[]> {
  const raw = await readFile(boundaryPath(rollout), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (raw === undefined) return [];
  const value = JSON.parse(raw);
  if (value.version !== 1 || !Array.isArray(value.ranges) || value.ranges.some((range: unknown) =>
    !Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] < 0 || range[1] <= range[0])) {
    throw new Error('Invalid imported Codex usage boundary');
  }
  return value.ranges;
}
export async function countRolloutLines(rollout: string): Promise<number> {
  const lines = createInterface({ input: createReadStream(rollout), crlfDelay: Infinity });
  let count = 0;
  for await (const _ of lines) count++;
  return count;
}
export async function writeImportedUsageRanges(rollout: string, ranges: ImportedUsageRange[]): Promise<void> {
  const target = boundaryPath(rollout); const temp = `${target}.${randomUUID()}`;
  try {
    await writeFile(temp, JSON.stringify({ version: 1, ranges }), { mode: 0o600, flag: 'wx' });
    await rename(temp, target);
  } finally { await rm(temp, { force: true }); }
}

export async function listNativeRollouts(home: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(path);
    }
  };
  for (const directory of ['sessions', 'archived_sessions']) await walk(join(home, directory));
  return files;
}

/** Called while native goal continuation is deferred, before any new turn. */
export async function markNativeForkReplay(home: string, threadId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) throw new Error('Invalid Codex fork identity');
  const rollouts = (await listNativeRollouts(home)).filter(path => path.endsWith(`-${threadId}.jsonl`));
  if (!rollouts.length) throw new Error('Codex fork history unavailable');
  for (const rollout of rollouts) {
    const lines = await countRolloutLines(rollout);
    if (lines) await writeImportedUsageRanges(rollout, [[0, lines]]);
  }
}
