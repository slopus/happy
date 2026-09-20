import { chmodSync, lstatSync, mkdirSync, mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuration } from '@/configuration';

export const CODEX_SESSION_FINISHED_MARKER = '.paws-session-finished';
export const codexSessionHomesRoot = () => join(configuration.happyHomeDir, 'codex-session-homes');

/** Keep ordinary session logins off OS temporary storage from the outset. */
export function createCodexSessionHome(): string {
  const root = codexSessionHomesRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory()) throw new Error('Invalid Codex session recovery directory');
  chmodSync(root, 0o700);
  return mkdtempSync(join(root, 'happy-codex-home-'));
}

/** Published only after the finalizer has stopped changing the login/checkpoint. */
export async function preserveFinishedCodexSession(home: string): Promise<void> {
  await writeFile(join(home, CODEX_SESSION_FINISHED_MARKER), '', { mode: 0o600, flag: 'wx' }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
}
