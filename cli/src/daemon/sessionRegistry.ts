import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as z from 'zod';
import { CATALOG_AGENT_IDS } from '@/backends/types';

const DaemonSessionMarkerSchema = z.object({
  pid: z.number().int().positive(),
  happySessionId: z.string(),
  happyHomeDir: z.string(),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
  flavor: z.enum(CATALOG_AGENT_IDS).optional(),
  startedBy: z.enum(['daemon', 'terminal']).optional(),
  cwd: z.string().optional(),
  // Process identity safety (PID reuse mitigation). Hash of the observed process command line.
  processCommandHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // Optional debug-only sample of the observed command (best-effort; may be truncated by ps-list).
  processCommand: z.string().optional(),
  metadata: z.any().optional(),
});

export type DaemonSessionMarker = z.infer<typeof DaemonSessionMarkerSchema>;

export function hashProcessCommand(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

function daemonSessionsDir(): string {
  return join(configuration.happyHomeDir, 'tmp', 'daemon-sessions');
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  try {
    await writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
    try {
      await rename(tmpPath, filePath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // On Windows, rename may fail if destination exists.
      if (err?.code === 'EEXIST' || err?.code === 'EPERM') {
        try {
          await unlink(filePath);
        } catch {
          // ignore unlink failure (e.g. ENOENT)
        }
        await rename(tmpPath, filePath);
        return;
      }
      throw e;
    }
  } catch (e) {
    // Best-effort cleanup to avoid leaving behind orphaned temp files on failure.
    try {
      await unlink(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw e;
  }
}

export async function writeSessionMarker(marker: Omit<DaemonSessionMarker, 'createdAt' | 'updatedAt' | 'happyHomeDir'> & { createdAt?: number; updatedAt?: number }): Promise<void> {
  await ensureDir(daemonSessionsDir());
  const now = Date.now();
  const filePath = join(daemonSessionsDir(), `pid-${marker.pid}.json`);

  let createdAtFromDisk: number | undefined;
  try {
    const raw = await readFile(filePath, 'utf-8');
    const existing = DaemonSessionMarkerSchema.safeParse(JSON.parse(raw));
    if (existing.success) {
      createdAtFromDisk = existing.data.createdAt;
    }
  } catch (e) {
    // ignore ENOENT (new marker); log other errors for diagnostics
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.debug(`[sessionRegistry] Could not read existing session marker pid-${marker.pid}.json to preserve createdAt`, e);
    }
  }

  const payload: DaemonSessionMarker = DaemonSessionMarkerSchema.parse({
    ...marker,
    happyHomeDir: configuration.happyHomeDir,
    createdAt: marker.createdAt ?? createdAtFromDisk ?? now,
    updatedAt: now,
  });
  await writeJsonAtomic(filePath, payload);
}

export async function removeSessionMarker(pid: number): Promise<void> {
  const filePath = join(daemonSessionsDir(), `pid-${pid}.json`);
  try {
    await unlink(filePath);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      logger.debug(`[sessionRegistry] Failed to remove session marker pid-${pid}.json`, e);
    }
  }
}

export async function listSessionMarkers(): Promise<DaemonSessionMarker[]> {
  await ensureDir(daemonSessionsDir());
  const entries = await readdir(daemonSessionsDir());
  const markers: DaemonSessionMarker[] = [];
  for (const name of entries) {
    if (!name.startsWith('pid-') || !name.endsWith('.json')) continue;
    const full = join(daemonSessionsDir(), name);
    try {
      const raw = await readFile(full, 'utf-8');
      const parsed = DaemonSessionMarkerSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        logger.debug(`[sessionRegistry] Failed to parse session marker ${name}`, parsed.error);
        continue;
      }
      // Extra safety: only accept markers for our home dir.
      if (parsed.data.happyHomeDir !== configuration.happyHomeDir) continue;
      markers.push(parsed.data);
    } catch (e) {
      logger.debug(`[sessionRegistry] Failed to read or parse session marker ${name}`, e);
      // ignore unreadable marker
    }
  }
  return markers;
}
