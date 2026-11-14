import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';

for (const [name, eventName, publishJob] of [
    ['ota-preview.yml', 'pull_request', 'publish-preview'],
    ['ota-production.yml', 'push', 'publish-production'],
]) {
    test(`${name} uses the shared mobile-impact gate before publishing`, async () => {
        const workflow = parse(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'));
        const gate = workflow.jobs['classify-ota-compatibility'];
        assert.equal(gate.outputs['ota-compatible'], '${{ steps.changes.outputs.ota_compatible }}');
        const step = gate.steps.find(step => step.id === 'changes');
        assert.equal(step.run, 'node scripts/classify-ota-impact.cjs');
        assert.match(step.env.BASE_SHA, name.includes('preview') ? /pull_request.base.sha/ : /event.before/);
        assert.match(step.env.HEAD_SHA, name.includes('preview') ? /pull_request.head.sha/ : /github.sha/);
        assert.match(workflow.jobs[publishJob].if, /ota-compatible == 'true'/);
        assert.ok(workflow.on[eventName].paths.includes('scripts/classify-ota-impact.cjs'));
        assert.equal(gate.steps[0].with['fetch-depth'], 0);

        const directory = await mkdtemp(join(tmpdir(), 'paws-ota-workflow-'));
        const git = (...args) => {
            const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr);
            return result.stdout.trim();
        };
        try {
            git('init', '-b', 'main'); git('config', 'user.name', 'Workflow Test'); git('config', 'user.email', 'ci@example.invalid');
            await mkdir(join(directory, 'scripts'), { recursive: true });
            await copyFile(new URL('./classify-ota-impact.cjs', import.meta.url), join(directory, 'scripts/classify-ota-impact.cjs'));
            const folder = 'packages/happy-app/sources/components';
            await mkdir(join(directory, folder), { recursive: true });
            await writeFile(join(directory, folder, 'Panel.web.tsx'), 'before');
            git('add', '.'); git('commit', '-m', 'base');
            const base = git('rev-parse', 'HEAD');
            await writeFile(join(directory, folder, 'Panel.web.tsx'), 'after');
            git('add', '.'); git('commit', '-m', 'web');
            const output = join(directory, 'outputs');
            const result = spawnSync('bash', ['-e', '-c', step.run], { cwd: directory, encoding: 'utf8', env: {
                ...process.env, BASE_SHA: base, HEAD_SHA: git('rev-parse', 'HEAD'), GITHUB_EVENT_NAME: eventName,
                GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(directory, 'summary'),
            } });
            assert.equal(result.status, 0, result.stderr);
            assert.match(await readFile(output, 'utf8'), /ota_compatible=false\ndelivery_reason=web-only/);
            assert.match(await readFile(join(directory, 'summary'), 'utf8'), /跳过手机 OTA/);
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
}
