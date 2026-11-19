import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importClaudeConversation } from './nativeHistory';
import { getProjectPath } from '@/claude/utils/path';
import { readClaudeConversation } from './history';
let root: string | undefined;
afterEach(async () => { delete process.env.CLAUDE_CONFIG_DIR; if (root) await rm(root, { recursive: true, force: true }); });
describe('Claude native importer', () => {
 it('writes a private, independently resumable conversation with original content', async () => {
  root = await mkdtemp(join(tmpdir(), 'paws-claude-import-')); process.env.CLAUDE_CONFIG_DIR = root;
  const history = [{ kind: 'user' as const, text: 'The project is Acorn' }, { kind: 'assistant' as const, text: 'Acorn is ready' }];
  const id = await importClaudeConversation(history, '/work');
  const rows = (await readFile(join(getProjectPath('/work'), `${id}.jsonl`), 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  expect(readClaudeConversation(rows)).toEqual(history);
  expect(rows.every(row => row.sessionId === id)).toBe(true);
 });
});
