/** Explicit owner operation; never called by a public request or by the worker. */
import { readFile, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { ScheduledTaskConfigSchema, ScheduledTaskSchema } from '@slopus/happy-wire';
import { readCredentials, readSettings } from '../src/persistence';
import { configuration } from '../src/configuration';
import { encrypt, encodeBase64 } from '../src/api/encryption';
import { scheduleJournalDirectory, writeScheduleJournalFile } from '../src/daemon/scheduledTasks/journal';

const schema = z.object({ taskId: z.string().uuid(), localHandlerId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  title: z.string().min(1).max(200), directory: z.string(), executable: z.string(), args: z.array(z.string().max(4096)).max(32),
  timeoutMs: z.number().int().min(100).max(7200000),
  credentialStore: z.object({ modulePath: z.string(), platform: z.string().regex(/^[a-z0-9-]+$/), entry: z.string().regex(/^[a-z0-9-]+$/) }).strict(),
}).strict();

async function main() {
  const [action, path] = process.argv.slice(2);
  if (!['create', 'rotate', 'disable', 'unregister'].includes(action) || !path) throw new Error('Usage: configure-task-handler.mts create|rotate|disable|unregister owner-config.json');
  const config = schema.parse(JSON.parse(await readFile(path, 'utf8')));
  const credentials = await readCredentials(), settings = await readSettings();
  if (!credentials || !settings.machineId) throw new Error('Existing owner login and machine registration required');
  const endpoint = new URL(configuration.serverUrl);
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) throw new Error('HTTPS required');
  const api = async (suffix: string, body?: unknown, method = 'POST') => {
    const response = await fetch(`${configuration.serverUrl}/v1/scheduled-tasks${suffix}`, { method,
      headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Owner API rejected (${response.status}); no credential printed`);
    return response.json() as Promise<any>;
  };
  const accountIdentity = credentials.encryption.type === 'legacy' ? credentials.encryption.secret : credentials.encryption.publicKey;
  const directory = scheduleJournalDirectory(credentials.token, accountIdentity), registryPath = join(directory, 'handlers.json');
  let registry: { handlers: Record<string, any> } = { handlers: {} };
  try {
    const info = await lstat(registryPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Private owner registry required');
    registry = JSON.parse(await readFile(registryPath, 'utf8'));
    if (!registry.handlers || typeof registry.handlers !== 'object' || Array.isArray(registry.handlers)) throw new Error('Invalid registry');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const previous = registry.handlers[config.localHandlerId];
  if (previous && previous.taskId !== config.taskId) throw new Error('Handler ID already belongs to another task');
  if (action === 'disable' || action === 'unregister') {
    await api(`/${config.taskId}/webhook`, { enabled: false });
    if (action === 'unregister' && previous) { delete registry.handlers[config.localHandlerId]; writeScheduleJournalFile(directory, 'handlers.json', registry); }
    console.log(JSON.stringify({ taskId: config.taskId, enabled: false, localGrantRemoved: action === 'unregister' })); return;
  }
  if (!isAbsolute(config.directory) || !isAbsolute(config.executable) || !isAbsolute(config.credentialStore.modulePath)) throw new Error('Absolute owner-controlled paths required');
  await realpath(config.directory); await realpath(config.executable);
  const pool = (operation: 'check' | 'import', secret = '') => new Promise<void>((resolve, reject) => {
    const code = operation === 'check'
      ? 'import sys;sys.path.insert(0,sys.argv[1]);from account_pool import Pool;assert not any(e["entry"]==sys.argv[3] for e in Pool().list_entries(sys.argv[2])),"entry exists"'
      : 'import sys;sys.path.insert(0,sys.argv[1]);from account_pool import Pool;Pool().import_key(sys.argv[2],sys.stdin.read(),entry=sys.argv[3])';
    const child = spawn('/usr/bin/python3', ['-c', code, config.credentialStore.modulePath, config.credentialStore.platform, config.credentialStore.entry], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdin.end(secret); child.once('error', () => { clearTimeout(timeout); reject(new Error('Account Pool unavailable')); });
    child.once('exit', status => { clearTimeout(timeout); status === 0 ? resolve() : reject(new Error(operation === 'check' ? 'Choose a new explicit credential entry; existing entries are preserved' : 'Secure credential save failed')); });
  });
  await pool('check');
  if (action === 'create') {
    const tasks = ScheduledTaskSchema.array().parse((await api('', undefined, 'GET')).tasks);
    if (tasks.some(task => task.id === config.taskId)) throw new Error('Task already exists; use rotate or another explicit task ID');
    const variant = credentials.encryption.type, key = variant === 'legacy' ? credentials.encryption.secret : credentials.encryption.machineKey;
    const encryptedConfig = encodeBase64(encrypt(key, variant, ScheduledTaskConfigSchema.parse({ title: config.title,
      prompt: 'Owner-registered fixed program.', directory: config.directory, agent: 'codex', permissionMode: 'read-only', localHandlerId: config.localHandlerId })));
    await api(`/${config.taskId}`, { id: config.taskId, machineId: settings.machineId, executionKind: 'local-handler',
      rule: { type: 'interval', anchor: Date.now(), hours: 1, timezone: 'UTC' }, enabled: false,
      encryptedConfig, newChatEachRun: true, notificationPolicy: 'none', expectedVersion: -1 }, 'PUT');
    registry.handlers[config.localHandlerId] = { taskId: config.taskId, directory: config.directory, executable: config.executable, args: config.args, timeoutMs: config.timeoutMs };
    writeScheduleJournalFile(directory, 'handlers.json', registry);
  }
  const { token } = await api(`/${config.taskId}/webhook`, { enabled: true });
  try { if (typeof token !== 'string') throw new Error('Missing credential'); await pool('import', token); }
  catch (error) { await api(`/${config.taskId}/webhook`, { enabled: false }); throw error; }
  console.log(JSON.stringify({ taskId: config.taskId, enabled: true, credentialStored: config.credentialStore, registryPath }));
}
main().catch(error => { console.error(error instanceof z.ZodError ? 'Invalid owner configuration' : error.message); process.exitCode = 1; });
