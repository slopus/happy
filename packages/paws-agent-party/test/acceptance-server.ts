/** Explicit fixture entry. Never imported by the normal service or browser bundle. */
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountAccess } from '../src/server/account-access.js';
import { createAccountServer } from '../src/server/account-server.js';
import { createPocServer } from '../src/server/http.js';
import { TestOnlySdk } from './fake-sdk.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const staticDir = await mkdtemp(join(tmpdir(), 'paws-party-fixture-web-'));
await cp(join(packageDir, 'dist/web'), staticDir, { recursive: true });
const index = join(staticDir, 'index.html');
await writeFile(index, (await readFile(index, 'utf8')).replace('<body>', '<body><div style="position:fixed;inset:0 0 auto;z-index:100;padding:4px;text-align:center;background:var(--warning);color:var(--background)">测试替身，非真实 Agent</div><style>body{padding-top:28px}#root>div,#root>.group-workbench{height:calc(100dvh - 28px)}</style>'));
const dataDir = resolve(process.env.PAWS_AGENT_PARTY_DATA_DIR ?? join(packageDir, '.data-test'));
class WorkbenchFixtureSdk extends TestOnlySdk {
  override async browseDirectory(_machineId: string, path = '/tmp') { return { success: true as const, path: path || '/tmp', parent: null, home: '/tmp', directories: [] }; }
  override async machines() {
    return (await super.machines()).map(machine => ({ ...machine, metadata: { host: 'fixture-mac-mini.local' } }));
  }
}
const legacyServer = () => createPocServer({ dataDir, staticDir, sdk: new WorkbenchFixtureSdk({ delayMs: 350, streamChunks: true }), port: 0 });
const accountMode = process.env.PAWS_PARTY_ACCOUNT_FIXTURE === '1';
class FixtureAccountAccess extends AccountAccess {
  override async credentials() { return { token: 'fixture-only', secret: new Uint8Array(32), contentKeyPair: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) } }; }
}
const access = new FixtureAccountAccess('http://fixture.invalid', 'fixture-master', async () => Response.json({ id: 'fixture-owner' }));
const server = accountMode ? await createAccountServer({ dataDir, staticDir, serverUrl: 'http://fixture.invalid', publicServerUrl: 'https://47.115.228.20:8443', masterKey: 'fixture-master', access, sdkFactory: () => new WorkbenchFixtureSdk({ delayMs: 350, streamChunks: true }) }) : await legacyServer();
await writeFile(join(dataDir, 'fixture-url'), server.url);
if (accountMode) {
  const ticket = access.issue({ id: 'fixture-owner', name: '验收账号' }, 'fixture-only');
  await writeFile(join(dataDir, 'fixture-ticket'), ticket, { mode: 0o600 });
}
console.log(`测试替身，非真实 Agent · ${server.url}`);
console.log(`Access token file: ${join(dataDir, 'access-token')}`);
const close = async () => { await server.close(); await rm(staticDir, { recursive: true, force: true }); process.exit(0); };
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
