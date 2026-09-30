import { constants } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

const adoptionSchema = z.object({
  launchId: z.string().min(1).max(256),
  profileId: z.string().min(1).max(256),
  credentialVersion: z.number().int().positive(),
  authFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  accountFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type CodexCredentialAdoption = z.infer<typeof adoptionSchema>;
const marker = '.paws-auth-adoption.json';

/** 记录 worker 已安装的凭证版本，不存储任何令牌。 */
export async function writeCodexCredentialAdoption(home: string, adoption: CodexCredentialAdoption): Promise<void> {
  const temporary = join(home, `.paws-auth-adoption-${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify(adoptionSchema.parse(adoption)), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(home, marker));
  } finally { await rm(temporary, { force: true }); }
}

export async function readCodexCredentialAdoption(home: string): Promise<CodexCredentialAdoption | undefined> {
  let file;
  try { file = await open(join(home, marker), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 2048) throw new Error('Invalid Codex credential adoption');
    const buffer = Buffer.alloc(2049);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 2048) throw new Error('Invalid Codex credential adoption');
    return adoptionSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } finally { await file.close(); }
}
