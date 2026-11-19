/** Authless native storage probe. Run with HAPPY_CODEX_PATH pointing at the actual Codex binary. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '../src/configuration';
import { exportNativeConversation, importClaudeConversation, importCodexConversation } from '../src/continuation/nativeHistory';
import { getProjectPath } from '../src/claude/utils/path';
import { readClaudeConversation, type ConversationItem } from '../src/continuation/history';
import { CodexAppServerClient } from '../src/codex/codexAppServerClient';
let forkedId: string | undefined;
const root = await mkdtemp(join(tmpdir(), 'paws-cross-agent-probe-'));
const saved = { home: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR, happy: configuration.happyHomeDir };
process.env.CODEX_HOME = join(root, 'codex'); process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
(configuration as { happyHomeDir: string }).happyHomeDir = join(root, 'paws');
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1cAAAAASUVORK5CYII=';
const history: ConversationItem[] = [
 { kind: 'user', text: 'Remember: this project is Acorn.', images: [image] },
 { kind: 'tool', name: 'Bash', input: '{"command":"pwd"}', command: 'pwd', output: root, error: false },
 { kind: 'assistant', text: 'Acorn is ready.' },
];
async function logs(dir: string): Promise<string[]> {
 const out: string[] = [];
 for (const entry of await readdir(dir, { withFileTypes: true })) {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) out.push(...await logs(path)); else if (path.endsWith('.jsonl')) out.push(path);
 }
 return out;
}
try {
 await mkdir(process.env.CODEX_HOME!, { recursive: true });
 const claudeId = await importClaudeConversation(history, root);
 const first = await exportNativeConversation({ id: 'synthetic-source', agent: 'claude', nativeId: claudeId, directory: root });
 const codexId = await importCodexConversation(first, root, process.env);
 const client = new CodexAppServerClient(undefined, { type: 'spawn' }, process.env);
 try {
  await client.connect(); await client.resumeThread({ threadId: codexId, cwd: root });
  const { thread } = await client.readThread({ threadId: codexId, includeTurns: true });
  assert((thread.turns?.length ?? 0) > 0, 'Imported conversation must be visible as native historical turns');
  assert(JSON.stringify(thread.turns).includes('Acorn'), 'Native historical turns must include imported dialogue');
  const forked = await client.forkThread({ threadId: codexId, cwd: root, deferGoalContinuation: true });
  forkedId = forked.threadId;
 }
 finally { await client.disconnect(); }
 const files = await logs(process.env.CODEX_HOME!);
 const native = (await Promise.all(files.map(path => readFile(path, 'utf8')))).join('\n');
 assert(native.includes('Acorn')); assert(native.includes('exec_command')); assert(native.includes(image), 'Native history must retain the exact image payload');
 const second = await exportNativeConversation({ id: 'synthetic-codex', agent: 'codex', nativeId: codexId, directory: root, requiresImportedHistory: true });
 assert.deepEqual(second, first);
 const forkedHistory = await exportNativeConversation({ id: 'synthetic-fork', agent: 'codex', nativeId: forkedId!, directory: root, requiresImportedHistory: true });
 assert.deepEqual(forkedHistory, first);
 const returnedId = await importClaudeConversation(second, root);
 const rows = (await readFile(join(getProjectPath(root), `${returnedId}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
 assert.deepEqual(readClaudeConversation(rows), first);
 console.log('PASS: Claude → native Codex import → disconnect/resume → export → Claude; text, shell result and PNG preserved, including a direct native /fork. No model request or historical tool execution.');
} finally {
 for (const [key, value] of [['CODEX_HOME', saved.home], ['CLAUDE_CONFIG_DIR', saved.claude]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
 (configuration as { happyHomeDir: string }).happyHomeDir = saved.happy;
 await rm(root, { recursive: true, force: true });
}
