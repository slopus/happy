import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

const workflowUrl = new URL('../.github/workflows/web-production-deploy.yml', import.meta.url);

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

test('production workflow has rollback outputs and no active server deploy path', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));
    const job = workflow.jobs.deploy;
    const switchStep = job.steps.find((step) => step.name === 'Atomically switch OSS Web entry');
    const caddyStep = job.steps.find((step) => step.name === 'Route the Web SPA to OSS');
    const cleanupStep = job.steps.find((step) => step.name === 'Remove guarded legacy Web files');
    const rollbackStep = job.steps.find((step) => step.name === 'Roll back failed Web activation');

    assert.equal(job.env.PAWS_DEPLOY_PATH, undefined);
    assert.equal(job.env.PAWS_LEGACY_WEB_PATH, '/var/www/happy-web');
    assert.equal(switchStep.id, 'switch');
    assert.equal(caddyStep.id, 'caddy');
    assert.equal(cleanupStep.id, 'cleanup');
    assert.match(cleanupStep.run, /test "\$legacy_path" = '\/var\/www\/happy-web'/);
    assert.match(cleanupStep.run, /Caddyfile/);
    assert.match(rollbackStep.if, /failure\(\)/);
    assert.match(rollbackStep.if, /live_verify\.outcome != 'success'/);
    assert.match(rollbackStep.run, /deploy-web\.sh --rollback/);
    assert.match(rollbackStep.run, /set \+e/);
    assert.match(rollbackStep.run, /oss_rollback_status/);
    assert.match(rollbackStep.run, /caddy_rollback_status/);
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
