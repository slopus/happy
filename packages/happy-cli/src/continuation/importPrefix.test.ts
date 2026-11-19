import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { writeImportPrefix, readImportPrefix, copyImportPrefix, assertImportRewindBoundary } from './importPrefix';
const original = configuration.happyHomeDir;
let root: string;
afterEach(async () => { (configuration as { happyHomeDir: string }).happyHomeDir = original; if (root) await rm(root, { recursive: true, force: true }); });
describe('imported context follows Codex native identity', () => {
 it('keeps imported context on a native fork and fails closed when required context is missing', async () => {
  root = await mkdtemp(join(tmpdir(), 'paws-prefix-')); (configuration as { happyHomeDir: string }).happyHomeDir = root;
  const a = '00000000-0000-4000-8000-000000000001'; const b = '00000000-0000-4000-8000-000000000002';
  const prefix = { directory: '/work', history: [{ kind: 'user' as const, text: 'Acorn original Claude context' }], turnIds: ['imported-turn'] };
  await writeImportPrefix(a, prefix); await copyImportPrefix(a, b);
  expect(await readImportPrefix(b, true)).toEqual(prefix);
  await expect(assertImportRewindBoundary(b, 'imported-turn')).rejects.toThrow(/as a whole/);
  await expect(assertImportRewindBoundary(b, 'new-turn')).resolves.toBeUndefined();
  await copyImportPrefix(a, b, '/other');
  expect((await readImportPrefix(b, true))?.directory).toBe('/other');
  await expect(readImportPrefix('00000000-0000-4000-8000-000000000003', true)).rejects.toThrow(/unavailable/);
  expect(await readImportPrefix('legacy-thread')).toBe(undefined);
 });
});
