import { lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { retainScopeHistory, type ScopeRequest } from './sessionWriteScope';

const recordSchema = z.object({
  version: z.literal(1), id: z.string().max(128), digest: z.string().length(64), incarnation: z.string().max(128),
  accountId: z.string().max(128), machineId: z.string().max(128), sessionId: z.string().max(128), generation: z.string().max(128),
  projectRoot: z.string().max(2048), root: z.string().max(2048), requestedPath: z.string().max(2048), description: z.string().max(240),
  kind: z.enum(['grant', 'revoke']), createdAt: z.number(), expiresAt: z.number(),
  state: z.enum(['pending', 'applying', 'applied', 'failed', 'cancelled', 'project-local', 'expired', 'cleanup-unresolved']),
  profileApplied: z.boolean().optional(), cleanup: z.enum(['unresolved', 'confirmed']).optional(),
  grantActive: z.boolean().optional(), error: z.string().regex(/^[A-Z_]{1,80}$/).optional(),
}).strict();

/** Public status evidence only. No approval key/permit or grant is restored from disk. */
export class ScopeJournal {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly accountId: string, private readonly machineId: string) {}
  async recover(): Promise<ScopeRequest[]> {
    const info = await lstat(this.path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return [];
    if (!info.isFile() || info.size > 1024 * 1024 || (info.mode & 0o077) !== 0) throw new Error('UNSAFE_SCOPE_JOURNAL');
    const entries = z.array(recordSchema).max(512).parse(JSON.parse(await readFile(this.path, 'utf8')));
    return retainScopeHistory(entries.filter(item => item.accountId === this.accountId && item.machineId === this.machineId).map(item => ({
      ...item, grantActive: false,
      state: item.state === 'pending' ? 'expired' : ['applying', 'applied', 'cleanup-unresolved'].includes(item.state)
        ? 'cleanup-unresolved' : item.state,
      ...(['applying', 'applied', 'cleanup-unresolved'].includes(item.state) ? { cleanup: 'unresolved' as const } : {}),
    })));
  }
  write(entries: readonly ScopeRequest[]): Promise<void> {
    const retained = retainScopeHistory(entries);
    if (retained.length > 512) throw new Error('SCOPE_JOURNAL_SAFETY_LIMIT_REACHED');
    const snapshot = JSON.stringify(z.array(recordSchema).max(512).parse(retained));
    if (Buffer.byteLength(snapshot, 'utf8') > 1024 * 1024) throw new Error('SCOPE_JOURNAL_SAFETY_LIMIT_REACHED');
    const operation = this.tail.catch(() => {}).then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(snapshot); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path);
        const directory = await open(dirname(this.path), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await rm(temporary, { force: true }); }
    });
    this.tail = operation; return operation;
  }
}
