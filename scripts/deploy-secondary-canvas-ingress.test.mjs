import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { configureSecondaryCanvasCaddy } from './configure-production-web-caddy.mjs';

const script = fileURLToPath(new URL('./deploy-secondary-canvas-ingress.sh', import.meta.url));
const fixture = '121.43.32.242:8443 {\n    @backend path /health\n    handle @backend {\n        respond "backend"\n    }\n    # paws-web-oss:start\n    handle {\n        rewrite * /web/current/index.html\n        reverse_proxy https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com\n    }\n    # paws-web-oss:end\n}\n';
async function runDeploy({ source = fixture, extraEnv = {}, args = [] } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'paws-secondary-deploy-'));
    try {
        const output = join(directory, 'output');
        const log = join(directory, 'log');
        const current = join(directory, 'current');
        await writeFile(current, source);
        await writeFile(join(directory, 'ssh'), '#!/bin/sh\nprintf "ssh %s\\n" "$*" >> "$TEST_LOG"\ncase "$*" in *"cat /etc/caddy/Caddyfile"*) cat "$TEST_CURRENT";; *) cat >/dev/null;; esac\n');
        await writeFile(join(directory, 'scp'), '#!/bin/sh\nprintf "scp %s\\n" "$*" >> "$TEST_LOG"\n');
        await chmod(join(directory, 'ssh'), 0o755);
        await chmod(join(directory, 'scp'), 0o755);
        const result = spawnSync('bash', [script, ...args], { encoding: 'utf8', env: {
            ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_LOG: log, TEST_CURRENT: current,
            GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
            PAWS_SECONDARY_WEB_ORIGIN: 'https://121.43.32.242:8443', PAWS_SECONDARY_DEPLOY_HOST: 'root@121.43.32.242',
            PAWS_SECONDARY_DEPLOY_PORT: '22', GITHUB_OUTPUT: output, ...extraEnv,
        } });
        return { ...result, output: await readFile(output, 'utf8').catch(() => ''), log: await readFile(log, 'utf8').catch(() => '') };
    } finally { await rm(directory, { recursive: true, force: true }); }
}

test('secondary canvas deployment fails before SSH for a branch or unapproved destination', async () => {
    for (const extraEnv of [{ GITHUB_REF: 'refs/heads/feature' }, { PAWS_SECONDARY_DEPLOY_HOST: 'root@evil.example' },
        { PAWS_SECONDARY_WEB_ORIGIN: 'https://121.43.32.242:8444' }]) {
        const result = await runDeploy({ extraEnv });
        assert.notEqual(result.status, 0);
        assert.equal(result.log, '');
    }
});

test('secondary canvas deployment records only its unique backup and skips unchanged configuration', async () => {
    const changed = await runDeploy();
    assert.equal(changed.status, 0, changed.stderr);
    assert.match(changed.output, /^backup_path=\/etc\/caddy\/Caddyfile.paws-secondary-canvas.previous-a{40}-123-2$/m);
    assert.match(changed.log, /scp /);
    const unchanged = await runDeploy({ source: configureSecondaryCanvasCaddy(fixture) });
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(unchanged.output, 'backup_path=\n');
    assert.doesNotMatch(unchanged.log, /scp /);
});

test('secondary rollback rejects unrelated backups and targets only the approved host', async () => {
    const rejected = await runDeploy({ args: ['--rollback', '/etc/caddy/Caddyfile.paws-web-oss.previous-foreign'] });
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.log, '');
    const accepted = await runDeploy({ args: ['--rollback', `/etc/caddy/Caddyfile.paws-secondary-canvas.previous-${'a'.repeat(40)}-123-2`] });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.log, /ssh -p 22 root@121\.43\.32\.242 bash -s --/);
});
