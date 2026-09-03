import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const workflowUrl = new URL('../.github/workflows/web-production-deploy.yml', import.meta.url);
const evidenceSpecUrl = new URL('../packages/happy-app/e2e/mcp-app-host-evidence.spec.ts', import.meta.url);
const evidenceHelperUrl = new URL('../packages/happy-app/e2e/helpers/mcpAppHarness.ts', import.meta.url);
const gitignoreUrl = new URL('../.gitignore', import.meta.url);

test('production workflow switches verified OSS content before Caddy and guarded cleanup', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));
    const job = workflow.jobs.deploy;
    const names = job.steps.map((step) => step.name);
    const position = (name) => names.indexOf(name);

    assert.ok(position('Build and stamp Web from this main revision') >= 0);
    assert.ok(position('Upload complete immutable Web release') > position('Build and stamp Web from this main revision'));
    assert.ok(position('Verify immutable OSS release before activation') > position('Upload complete immutable Web release'));
    assert.ok(position('Atomically switch OSS Web entry') > position('Verify immutable OSS release before activation'));
    assert.ok(position('Route the Web SPA to OSS') > position('Atomically switch OSS Web entry'));
    assert.ok(position('Verify live OSS-backed release and routes') > position('Route the Web SPA to OSS'));
    assert.ok(position('Remove guarded legacy Web files') > position('Verify live OSS-backed release and routes'));
    assert.ok(position('Roll back failed Web activation') > position('Remove guarded legacy Web files'));
});

test('guards the exact origin/main revision before every external production mutation', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));
    const names = workflow.jobs.deploy.steps.map((step) => step.name);
    const guardIndex = names.indexOf('Guard exact merged main revision before external mutation');
    assert.ok(guardIndex > names.indexOf('Checkout merged main revision'));
    for (const mutation of ['Configure MCP App sandbox route', 'Upload complete immutable Web release', 'Atomically switch OSS Web entry']) {
        assert.ok(names.indexOf(mutation) > guardIndex);
    }
    const guard = workflow.jobs.deploy.steps[guardIndex];
    assert.match(guard.run, /GITHUB_REF.*refs\/heads\/main/);
    assert.match(guard.run, /git fetch --no-tags origin main/);
    assert.match(guard.run, /rev-parse origin\/main/);
    assert.match(guard.run, /GITHUB_SHA/);
    const syntax = spawnSync('bash', ['-n'], { input: guard.run, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
});

test('MCP App sandbox rollout is disabled by default and verified before Web export or activation', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));
    const job = workflow.jobs.deploy;
    const names = job.steps.map((step) => step.name);
    const position = (name) => names.indexOf(name);

    assert.equal(job.env.PAWS_MCP_APP_SANDBOX_ORIGIN, '${{ vars.PAWS_MCP_APP_SANDBOX_ORIGIN }}');
    assert.ok(position('Resolve MCP App sandbox rollout') >= 0);
    assert.ok(position('Configure MCP App sandbox route') > position('Resolve MCP App sandbox rollout'));
    assert.ok(position('Verify MCP App sandbox endpoint') > position('Configure MCP App sandbox route'));
    assert.ok(position('Build and stamp Web from this main revision') > position('Verify MCP App sandbox endpoint'));
    assert.ok(position('Atomically switch OSS Web entry') > position('Build and stamp Web from this main revision'));

    const resolve = job.steps.find((step) => step.name === 'Resolve MCP App sandbox rollout');
    const configure = job.steps.find((step) => step.name === 'Configure MCP App sandbox route');
    const verify = job.steps.find((step) => step.name === 'Verify MCP App sandbox endpoint');
    const build = job.steps.find((step) => step.name === 'Build and stamp Web from this main revision');
    assert.match(resolve.run, /enabled=false/);
    assert.match(resolve.run, /sandbox origin must differ/i);
    assert.match(configure.if, /steps\.mcp_rollout\.outputs\.enabled == 'true'/);
    assert.match(verify.if, /steps\.mcp_rollout\.outputs\.enabled == 'true'/);
    assert.match(configure.run, /configure-production-mcp-app-sandbox-caddy\.mjs/);
    assert.match(verify.run, /verify-production-mcp-app-sandbox\.mjs/);
    assert.match(build.run, /unset EXPO_PUBLIC_MCP_APP_SANDBOX_ORIGIN/);
    assert.match(build.run, /export EXPO_PUBLIC_MCP_APP_SANDBOX_ORIGIN/);
    for (const step of [resolve, configure, build]) {
        const syntax = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
        assert.equal(syntax.status, 0, syntax.stderr);
    }
});

test('production deployment verifies data-plane CORS without bucket-control permissions', async () => {
    const workflowText = await readFile(workflowUrl, 'utf8');
    const workflow = parse(workflowText);
    const verifyStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Verify immutable OSS release before activation');

    assert.doesNotMatch(workflowText, /ossutil api (?:get|put)-bucket-cors/);
    assert.match(verifyStep.run, /verify-web-release\.mjs/);
    assert.match(verifyStep.run, /--immutable/);
});

test('production activation is serialized and cannot be cancelled mid-switch', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));

    assert.equal(workflow.concurrency.group, 'paws-web-production');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
});

test('authenticated MCP App evidence disables traces and protects external storage state', async () => {
    const [spec, helper, gitignore] = await Promise.all([
        readFile(evidenceSpecUrl, 'utf8'), readFile(evidenceHelperUrl, 'utf8'), readFile(gitignoreUrl, 'utf8'),
    ]);
    assert.match(spec, /test\.use\(\{ storageState: environment\.storageState, trace: 'off' \}\)/);
    assert.doesNotMatch(spec, /testInfo\.attach|storageState.*evidence/i);
    assert.match(helper, /HAPPY_E2E_STORAGE_STATE/);
    assert.match(helper, /webUrl\.search \|\| webUrl\.hash/);
    assert.match(helper, /state\.mode & 0o077/);
    assert.match(gitignore, /packages\/happy-app\/\.mcp-app-e2e-auth\//);
});

test('production workflow has rollback outputs and no active server deploy path', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));
    const job = workflow.jobs.deploy;
    const switchStep = job.steps.find((step) => step.name === 'Atomically switch OSS Web entry');
    const caddyStep = job.steps.find((step) => step.name === 'Route the Web SPA to OSS');
    const cleanupStep = job.steps.find((step) => step.name === 'Remove guarded legacy Web files');
    const rollbackStep = job.steps.find((step) => step.name === 'Roll back failed Web activation');

    assert.equal(job.env.PAWS_DEPLOY_PATH, undefined);
    assert.equal(job.env.PAWS_LEGACY_WEB_ORIGIN, 'http://47.115.228.20:8080');
    assert.equal(job.env.PAWS_LEGACY_WEB_PATH, '/var/www/happy-web');
    assert.equal(switchStep.id, 'switch');
    assert.equal(caddyStep.id, 'caddy');
    assert.equal(cleanupStep.id, 'cleanup');
    assert.match(cleanupStep.run, /test "\$legacy_path" = '\/var\/www\/happy-web'/);
    assert.match(cleanupStep.run, /Caddyfile/);
    assert.match(caddyStep.run, /caddy adapt --config "\$config" --adapter caddyfile/);
    assert.match(cleanupStep.run, /caddy adapt --config \/etc\/caddy\/Caddyfile --adapter caddyfile/);
    assert.doesNotMatch(cleanupStep.run, /grep[^\n]*\/etc\/caddy\/Caddyfile/);
    const liveVerifyStep = job.steps.find((step) => step.name === 'Verify live OSS-backed release and routes');
    assert.match(liveVerifyStep.run, /verify-web-release\.mjs/);
    assert.match(rollbackStep.if, /failure\(\)/);
    assert.match(rollbackStep.if, /live_verify\.outcome != 'success'/);
    assert.match(rollbackStep.run, /deploy-web\.sh --rollback/);
    assert.match(rollbackStep.run, /set \+e/);
    assert.match(rollbackStep.run, /oss_rollback_status/);
    assert.match(rollbackStep.run, /caddy_rollback_status/);
    assert.match(rollbackStep.run, /Caddyfile\.paws-mcp-app\.previous-/);
    assert.match(rollbackStep.run, /mcp_caddy_rollback_status/);
    assert.match(rollbackStep.run, /exit 1/);
    const syntax = spawnSync('bash', ['-n'], { input: rollbackStep.run, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
});

test('Caddy activation and rollback enqueue reloads without waiting on old connections', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));
    const caddyStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Route the Web SPA to OSS');
    const rollbackStep = workflow.jobs.deploy.steps.find((step) => step.name === 'Roll back failed Web activation');

    assert.match(caddyStep.run, /systemctl --no-block reload caddy/);
    assert.match(rollbackStep.run, /systemctl --no-block reload caddy/);
    assert.match(rollbackStep.run, /systemctl list-jobs/);
    assert.match(rollbackStep.run, /ReloadResult/);
    assert.match(rollbackStep.run, /verify-web-rollback\.mjs "\$PAWS_WEB_ORIGIN"/);
    assert.doesNotMatch(rollbackStep.run, /curl /);
    assert.doesNotMatch(caddyStep.run, /systemctl reload caddy/);
    assert.doesNotMatch(rollbackStep.run, /systemctl reload caddy/);
});
