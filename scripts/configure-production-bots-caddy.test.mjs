import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { BOTS_BLOCK, configureProductionBotsCaddy } from './configure-production-bots-caddy.mjs';
const source = '{\n    email ops@example.invalid\n}\nother.example {\n    respond "untouched {quoted}"\n}\n47.115.228.20:8443 {\n    respond "Paws"\n}\n';
function adapted(runtime = false) {
  return { apps: { http: { servers: {
    parent: { listen: [':8443'], tls_connection_policies: [{}] },
    ...(runtime ? { bots: { listen: [':8445'], routes: [{}] } } : {}),
  } }, tls: { certificates: { load_files: [{ certificate: '/etc/caddy/ip-letsencrypt-fullchain.pem', key: '/etc/caddy/ip-letsencrypt-key.pem' }] } } } };
}
test('preserves the complete existing config and adds only the dedicated site', () => {
  const result = configureProductionBotsCaddy(source, adapted());
  assert.equal(result, `${source}\n${BOTS_BLOCK}\n`);
  assert.match(result, /flush_interval -1/);
  assert.equal(configureProductionBotsCaddy(result, adapted(true)), result);
});
test('rejects unknown TLS, existing port ownership and modified or duplicate managed blocks', () => {
  const tls = adapted(); tls.apps.tls.certificates.load_files[0].key = '/other-key';
  assert.throws(() => configureProductionBotsCaddy(source, tls), /certificate/);
  const plain = adapted(); delete plain.apps.http.servers.parent.tls_connection_policies;
  assert.throws(() => configureProductionBotsCaddy(source, plain), /TLS parent/);
  assert.throws(() => configureProductionBotsCaddy(source, adapted(true)), /Unmanaged/);
  assert.throws(() => configureProductionBotsCaddy(source + 'other:8445 {\n}\n', adapted()), /Unmanaged/);
  assert.throws(() => configureProductionBotsCaddy(source + BOTS_BLOCK.replace('3491', '3492'), adapted(true)), /modified/);
  assert.throws(() => configureProductionBotsCaddy(source + BOTS_BLOCK + BOTS_BLOCK, adapted(true)), /duplicate/);
  const routes = adapted(true); routes.apps.http.servers.bots.routes.push({});
  assert.throws(() => configureProductionBotsCaddy(source + BOTS_BLOCK, routes), /additional/);
});
test('workflow prepares the ingress using existing SSH, guards main, and rolls it back', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/web-production-deploy.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.deploy.steps;
  const idx = name => steps.findIndex(s => s.name === name);
  assert.ok(idx('Configure dedicated Bots HTTPS ingress') > idx('Configure verified SSH access'));
  assert.ok(idx('Configure dedicated Bots HTTPS ingress') < idx('Build and stamp Web from this main revision'));
  const rollback = steps.find(s => s.name === 'Roll back failed Web activation').run;
  assert.match(rollback, /steps\.bots_caddy\.outputs\.backup_path/);
  assert.match(rollback, /deploy-bots-ingress\.sh --rollback/);
  const shell = await readFile(new URL('./deploy-bots-ingress.sh', import.meta.url), 'utf8');
  assert.equal(spawnSync('bash', ['-n'], { input: shell, encoding: 'utf8' }).status, 0);
  assert.match(shell, /GITHUB_REF.*refs\/heads\/main/);
  assert.match(shell, /sha256sum.*config/);
  assert.match(shell, /caddy validate --config.*candidate/);
  assert.doesNotMatch(shell, /while |sleep |setInterval/);
});
test('real Caddy adapter accepts the dedicated site and supports idempotent readback', { skip: spawnSync('caddy', ['version'], { stdio: 'ignore' }).status !== 0 }, () => {
  const current = '47.115.228.20:8443 {\n tls /etc/caddy/ip-letsencrypt-fullchain.pem /etc/caddy/ip-letsencrypt-key.pem\n respond "Paws"\n}\n';
  const adapt = text => {
    const result = spawnSync('caddy', ['adapt', '--config', '-', '--adapter', 'caddyfile'], { input: text, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const configured = configureProductionBotsCaddy(current, adapt(current));
  const liveShape = adapt(configured);
  assert.equal(configureProductionBotsCaddy(configured, liveShape), configured);
  const bots = Object.values(liveShape.apps.http.servers).find(s => s.listen.includes(':8445'));
  assert.equal(bots.routes.length, 1);
});

test('same-SHA retries use distinct backups and failed remote prechecks expose no rollback path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bots-ingress-retry-'));
  const bin = join(root, 'bin'); await mkdir(bin);
  const fixture = join(root, 'fixture'); const config = join(root, 'adapted');
  const trace = join(root, 'trace'); const output = join(root, 'output');
  await writeFile(fixture, source); await writeFile(config, JSON.stringify(adapted()));
  const tool = async (name, code) => writeFile(join(bin, name), `#!${process.execPath}\n${code}`, { mode: 0o700 });
  await tool('ssh', `const fs=require('node:fs'); const args=process.argv.slice(2);
if(args.at(-1)==='cat /etc/caddy/Caddyfile') process.stdout.write(fs.readFileSync(process.env.FIXTURE));
else if(args.at(-1).startsWith('caddy adapt ')) process.stdout.write(fs.readFileSync(process.env.ADAPTED));
else { fs.writeFileSync(process.env.TRACE,JSON.stringify(args)); process.stdin.resume(); process.stdin.on('end',()=>process.exit(Number(process.env.FAIL_APPLY))); }`);
  await tool('scp', 'process.exit(0)'); await tool('curl', 'process.exit(0)');
  await tool('sha256sum', `const fs=require('node:fs'),crypto=require('node:crypto'); console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex')+'  '+process.argv[2]);`);
  const script = fileURLToPath(new URL('./deploy-bots-ingress.sh', import.meta.url));
  const run = attempt => spawnSync('bash', [script], { encoding: 'utf8', cwd: fileURLToPath(new URL('../', import.meta.url)), env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE: fixture, ADAPTED: config, TRACE: trace,
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: String(attempt),
    PAWS_DEPLOY_HOST: 'root@47.115.228.20', PAWS_DEPLOY_PORT: '22', GITHUB_OUTPUT: output, FAIL_APPLY: attempt < 3 ? '1' : '0',
  } });
  try {
    await writeFile(output, '');
    assert.notEqual(run(1).status, 0);
    const first = JSON.parse(await readFile(trace, 'utf8')).at(-2);
    assert.equal(await readFile(output, 'utf8'), '');
    assert.notEqual(run(2).status, 0);
    const second = JSON.parse(await readFile(trace, 'utf8')).at(-2);
    assert.notEqual(first, second);
    assert.equal(await readFile(output, 'utf8'), '');
    const success = run(3); assert.equal(success.status, 0, success.stderr);
    assert.match(await readFile(output, 'utf8'), /backup_path=\/etc\/caddy\/Caddyfile\.paws-bots\.previous-[a-f0-9]+-1234-3/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
