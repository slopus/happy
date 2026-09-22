/** Offline, explicit-owner migration. Never imports credentials into the data directory. */
import { cp, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AccountAccess } from '../dist/server.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
for (const name of ['--data-dir', '--account-id', '--token-file']) if (!args.get(name)) throw Error(`Required: ${name}. Stop the AgentParty service before migration.`);
const dataDir = resolve(args.get('--data-dir'));
const serverUrl = process.env.PAWS_AGENT_PARTY_RELAY_URL ?? 'http://47.115.228.20:3005';
const access = new AccountAccess(serverUrl, 'unused-for-migration');
const account = await access.verify((await readFile(resolve(args.get('--token-file')), 'utf8')).trim());
if (account.id !== args.get('--account-id')) throw Error('The verified account does not match the explicitly selected owner.');
const target = join(dataDir, 'accounts', access.tenantKey(account.id));
const staging = `${target}.migration-${randomUUID()}`;
const locks = [];
const files = ['party', 'assets', 'runs.json', 'group-chat-rooms.json', 'group-chat-profiles.json'];
async function inventory(directory, entries = files) {
  const result = {};
  async function visit(relative) {
    const path = join(directory, relative);
    const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw Error(`Refusing symbolic link: ${relative}`);
    if (stat.isDirectory()) { for (const child of (await readdir(path)).sort()) await visit(join(relative, child)); }
    else if (stat.isFile()) result[relative] = createHash('sha256').update(await readFile(path)).digest('hex');
    else throw Error(`Unsupported file: ${relative}`);
  }
  for (const relative of entries) await visit(relative);
  return result;
}
try {
  // Lock both the old single-space service and the new account broker.
  await mkdir(join(dataDir, 'public-shell'), { recursive: true });
  for (const path of [join(dataDir, 'service.lock'), join(dataDir, 'public-shell', 'service.lock')]) {
    const handle = await open(path, 'wx', 0o600); locks.push({ path, handle });
    await handle.writeFile(`offline-migration:${process.pid}`);
  }
  if (await lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) throw Error('Target account space already exists; refusing to overwrite or combine histories.');
  const before = await inventory(dataDir);
  if (!Object.keys(before).length) throw Error('No legacy business data found.');
  await mkdir(staging, { recursive: true, mode: 0o700 });
  for (const entry of files) if (await lstat(join(dataDir, entry)).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) await cp(join(dataDir, entry), join(staging, entry), { recursive: true, errorOnExist: true, force: false });
  if (JSON.stringify(before) !== JSON.stringify(await inventory(staging)) || JSON.stringify(before) !== JSON.stringify(await inventory(dataDir))) throw Error('Source changed or copy checksum verification failed.');
  await writeFile(join(staging, 'legacy-migration.json'), JSON.stringify({ accountId: account.id, serverUrl, source: dataDir, migratedAt: new Date().toISOString(), files: before }, null, 2), { mode: 0o600 });
  await rename(staging, target);
  console.log(JSON.stringify({ migrated: true, accountId: account.id, verifiedFiles: Object.keys(before).length, sourcePreserved: true }));
} finally {
  await rm(staging, { recursive: true, force: true });
  for (const { path, handle } of locks.reverse()) { await handle.close(); await rm(path); }
}
