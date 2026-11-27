import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    assert.match(guard.run, /rev-parse (?:refs\/remotes\/)?origin\/main/);
    assert.match(guard.run, /GITHUB_SHA/);
    const syntax = spawnSync('bash', ['-n'], { input: guard.run, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
});

test('queued obsolete deployment exits successfully using real Git ancestry before setup', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));
    const guard = workflow.jobs.deploy.steps.find((step) => step.name === 'Guard exact merged main revision before external mutation');
    const directory = await mkdtemp(join(tmpdir(), 'paws-web-source-test-'));
    const repo = join(directory, 'repo');
    await mkdir(join(repo, 'scripts'), { recursive: true });
    // The helper is part of the commit under test, just as it is in Actions.
    const helper = await readFile(new URL('./web-release-source.sh', import.meta.url), 'utf8');
    await writeFile(join(repo, 'scripts/web-release-source.sh'), helper);
    const git = (...args) => {
        const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    try {
        git('init', '-b', 'main');
        git('config', 'user.name', 'Deployment Test');
        git('config', 'user.email', 'deploy-test@example.invalid');
        git('add', '.');
        git('commit', '-m', 'first');
        const first = git('rev-parse', 'HEAD');
        git('clone', '--bare', '.', join(directory, 'origin.git'));
        git('remote', 'add', 'origin', join(directory, 'origin.git'));
        git('commit', '--allow-empty', '-m', 'newer main');
        const next = git('rev-parse', 'HEAD');
        git('push', 'origin', 'main');
        git('checkout', '--detach', first);
        const output = join(directory, 'output');
        const run = () => spawnSync('bash', ['-euo', 'pipefail', '-c', guard.run], {
            cwd: repo, encoding: 'utf8', env: {
                ...process.env, PAWS_WEB_SKIP_SUPERSEDED: '', ...guard.env,
                GITHUB_REF: 'refs/heads/main', GITHUB_SHA: first, GITHUB_OUTPUT: output,
            },
        });
        const superseded = run();
        assert.equal(superseded.status, 0, superseded.stderr);
        assert.match(await readFile(output, 'utf8'), /^superseded=true$/m);
        assert.match(await readFile(output, 'utf8'), new RegExp(`^superseded_by=${next}$`, 'm'));
        assert.doesNotMatch(await readFile(output, 'utf8'), /eligible=true/);

        await writeFile(output, '');
        await writeFile(join(repo, 'dirty.txt'), 'untracked');
        assert.notEqual(run().status, 0, 'dirty worktree must not be treated as superseded');
        assert.equal(await readFile(output, 'utf8'), '');
        await rm(join(repo, 'dirty.txt'));
        git('remote', 'set-url', 'origin', join(directory, 'missing.git'));
        assert.notEqual(run().status, 0, 'fetch failure must remain a failure');
        assert.equal(await readFile(output, 'utf8'), '');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('supersession skips deployment work, restores earlier mutations, and never claims deployed', async () => {
    const { jobs: { deploy: { steps } } } = parse(await readFile(workflowUrl, 'utf8'));
    const enabled = (name, state, ok = true) => {
        const step = steps.find((step) => step.name === name);
        assert.ok(step, name);
        if (!step.if) return ok;
        const expression = step.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
        const hasStatus = /(?:success|failure|always|cancelled)\(/.test(expression);
        return (hasStatus || ok) && Function('steps', 'success', 'failure', `return (${expression});`)(state, () => ok, () => !ok);
    };
    const state = {
        source: { outputs: { superseded: 'true' } },
        switch: { outputs: {} },
        live_verify: { outcome: 'skipped' },
        mcp_rollout: { outputs: { enabled: 'true' } },
    };
    for (const name of ['Guard deployment configuration', 'Install dependencies', 'Configure MCP App sandbox route',
        'Build and stamp Web from this main revision', 'Upload complete immutable Web release',
        'Atomically switch OSS Web entry', 'Route the Web SPA to OSS',
        'Verify live OSS-backed release and routes', 'Remove guarded legacy Web files', 'Write deployment summary']) {
        assert.equal(enabled(name, state), false, name);
    }
    assert.equal(enabled('Write superseded deployment summary', state), true);
    state.source.outputs = { eligible: 'true' };
    state.switch.outputs = { superseded: 'true' };
    assert.equal(enabled('Roll back failed Web activation', state), true);
    for (const name of ['Route the Web SPA to OSS', 'Verify live OSS-backed release and routes', 'Remove guarded legacy Web files', 'Write deployment summary']) {
        assert.equal(enabled(name, state), false, name);
    }
    assert.equal(enabled('Write superseded deployment summary', state, false), false, 'rollback errors must not be hidden');
    state.switch.outputs = { activated: 'true' };
    assert.equal(enabled('Route the Web SPA to OSS', state), true);
    assert.equal(enabled('Roll back failed Web activation', state, false), true);
    state.live_verify.outcome = 'success';
    assert.equal(enabled('Write deployment summary', state), true);
    assert.equal(enabled('Write superseded deployment summary', state), false);
});

test('verifies the canvas license before writing externally and includes the renderer in the release build', async () => {
    const { jobs: { deploy: { steps } } } = parse(await readFile(workflowUrl, 'utf8'));
    const position = name => steps.findIndex(step => step.name === name);
    const guard = position('Resolve Project Canvas production rollout');
    const build = position('Build and stamp Web from this main revision');
    const switchEntry = position('Atomically switch OSS Web entry');
    const keyRef = '${{ secrets.PAWS_PROJECT_CANVAS_TLDRAW_LICENSE }}';
    assert.ok(guard > position('Install dependencies'));
    assert.ok(guard < position('Configure MCP App sandbox route'));
    assert.ok(guard < position('Configure dedicated Bots HTTPS ingress'));
    assert.ok(guard < build && build < switchEntry);
    assert.equal(steps[guard].env.PAWS_PROJECT_CANVAS_TLDRAW_LICENSE, keyRef);
    assert.equal(steps[build].env.PAWS_PROJECT_CANVAS_TLDRAW_LICENSE, keyRef);
    assert.equal(steps[switchEntry].env.PAWS_PROJECT_CANVAS_TLDRAW_LICENSE, keyRef);
    assert.match(steps[guard].run, /--print-evaluation-expiry/);
    assert.match(steps[build].env.PAWS_PROJECT_CANVAS_BUILD_DISABLED, /canvas_rollout.outputs.enabled/);
    assert.match(steps[build].run, /build:project-canvas[\s\S]*expo export[\s\S]*--project-canvas/);
});

test('missing or rejected canvas licenses leave an eligible Web deploy enabled', async () => {
    const { jobs: { deploy: { steps } } } = parse(await readFile(workflowUrl, 'utf8'));
    const rollout = steps.find(step => step.id === 'canvas_rollout');
    const temporary = await mkdtemp(join(tmpdir(), 'paws-canvas-rollout-'));
    try {
        const scripts = join(temporary, 'packages/paws-dsh-canvas/scripts');
        await mkdir(scripts, { recursive: true });
        await writeFile(join(scripts, 'verify-production-license.mjs'), 'process.exit(1);');
        for (const license of ['', 'expired-test-license']) {
            const output = join(temporary, 'result');
            await writeFile(output, '');
            const result = spawnSync('bash', ['-c', rollout.run], { cwd: temporary, encoding: 'utf8', env: {
                ...process.env,
                PAWS_WEB_ORIGIN: 'https://47.115.228.20:8443',
                PAWS_PROJECT_CANVAS_TLDRAW_LICENSE: license,
                GITHUB_OUTPUT: output,
            } });
            assert.equal(result.status, 0, result.stderr);
            assert.equal(await readFile(output, 'utf8'), 'enabled=false\n');
            assert.match(result.stdout, /Project Canvas omitted/);
            assert.doesNotMatch(result.stdout + result.stderr, /expired-test-license/);
        }
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
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

test('production workflow injects browser-origin runtime configuration once before release stamping', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));
    const build = workflow.jobs.deploy.steps.find((step) => step.name === 'Build and stamp Web from this main revision');
    const injector = 'node scripts/inject-web-runtime-server-config.mjs packages/happy-app/dist/index.html';
    const stamp = 'node scripts/stamp-web-release.mjs';

    assert.equal(build.run.split(injector).length - 1, 2);
    const conditional = build.run.slice(build.run.indexOf('if [ "$PAWS_PROJECT_CANVAS_BUILD_DISABLED"'), build.run.indexOf(stamp));
    assert.match(conditional, /then[\s\S]*--project-canvas[\s\S]*else[\s\S]*inject-web-runtime-server-config\.mjs[\s\S]*fi/);
    assert.match(build.run, /EXPO_PUBLIC_HAPPY_SERVER_URL="\$PAWS_WEB_ORIGIN"/);
    assert.equal(workflow.jobs.deploy.env.PAWS_WEB_ORIGIN, 'https://47.115.228.20:8443');
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
    assert.equal(switchStep.env.PAWS_WEB_SKIP_SUPERSEDED, '1');
    assert.equal(caddyStep.id, 'caddy');
    assert.equal(cleanupStep.id, 'cleanup');
    assert.match(cleanupStep.run, /test "\$legacy_path" = '\/var\/www\/happy-web'/);
    assert.match(cleanupStep.run, /Caddyfile/);
    assert.match(caddyStep.run, /caddy adapt --config "\$candidate" --adapter caddyfile/);
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

test('all Caddy reload guards wait through a drained-job reloading transition', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));
    const names = [
        'Configure MCP App sandbox route',
        'Route the Web SPA to OSS',
        'Roll back failed Web activation',
    ];
    const guards = names.flatMap((name) => {
        const step = workflow.jobs.deploy.steps.find((candidate) => candidate.name === name);
        assert.ok(step, name);
        return [...step.run.matchAll(/wait_for_reload\(\) \{\n[\s\S]*?\n\}/g)].map((match) => match[0]);
    });
    assert.ok(guards.length > 0, 'workflow must define at least one reload guard');

    const directory = await mkdtemp(join(tmpdir(), 'paws-caddy-reload-test-'));
    try {
        for (const [index, guard] of guards.entries()) {
            const counter = join(directory, `attempt-${index}`);
            await writeFile(counter, '0');
            const result = spawnSync('bash', ['-c', `
systemctl() {
    case "$*" in
        list-jobs*)
            attempt="$(<"$WAIT_COUNTER")"
            printf '%s' "$((attempt + 1))" > "$WAIT_COUNTER"
            ;;
        *--property=ActiveState*)
            attempt="$(<"$WAIT_COUNTER")"
            if [ "$attempt" -eq 1 ]; then printf 'reloading\\n'; else printf 'active\\n'; fi
            ;;
        *--property=ReloadResult*)
            attempt="$(<"$WAIT_COUNTER")"
            if [ "$attempt" -ge 2 ]; then printf 'success\\n'; fi
            ;;
        *) return 2 ;;
    esac
}
sleep() { :; }
${guard}
wait_for_reload
`], { encoding: 'utf8', env: { ...process.env, WAIT_COUNTER: counter } });
            assert.equal(result.status, 0, `guard ${index + 1}: ${result.stderr}`);
            assert.equal(await readFile(counter, 'utf8'), '2', `guard ${index + 1} must retry the transition`);
        }
        assert.equal(guards.length, 4, 'every activation and rollback reload must use the guarded wait');
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('Web and Tunnel configuration share one activation candidate and rollback backup', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));
    const step = workflow.jobs.deploy.steps.find((step) => step.name === 'Route the Web SPA to OSS');
    assert.match(step.run, /configure-production-web-caddy\.mjs "\$current_caddy" "\$web_caddy"/);
    assert.match(step.run, /configure-production-tunnel-caddy\.mjs "\$web_caddy" "\$next_caddy"/);
    assert.ok(step.run.indexOf('configure-production-web-caddy') < step.run.indexOf('configure-production-tunnel-caddy'));
    assert.equal(step.run.match(/remote_backup=/g)?.length, 1);
    assert.equal(step.run.match(/scp -P/g)?.length, 1);
    assert.ok(step.run.indexOf('caddy validate --config "$candidate"') < step.run.indexOf('install -m 644'));
    assert.ok(step.run.indexOf('check_tunnel_listeners <<<"$adapted_config"') < step.run.indexOf('install -m 644'));
    assert.match(step.run, /cmp -s -- "\$candidate" "\$config"/);
    assert.match(step.run, /wait_for_reload/);
    assert.match(step.run, /--header 'Host: paws\.rodeo' http:\/\/127\.0\.0\.1:8081\/health/);
    assert.match(step.run, /--header 'Host: invalid\.example' http:\/\/127\.0\.0\.1:8081\/health/);
    assert.match(step.run, /= '421'/);
    assert.match(step.run, /ss -lnt/);
    const syntax = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
});

test('candidate listener guard rejects wildcard, nonloopback, absent, and extra Tunnel listeners', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));
    const step = workflow.jobs.deploy.steps.find((step) => step.name === 'Route the Web SPA to OSS');
    const guard = step.run.match(/check_tunnel_listeners\(\) \{\n[\s\S]*?\n\}/)?.[0];
    assert.ok(guard, 'remote script must provide the candidate listener guard');
    for (const [listeners, success] of [
        [['127.0.0.1:8081'], true],
        [['0.0.0.0:8081'], false], [['[::]:8081'], false], [[':8081'], false],
        [['47.115.228.20:8081'], false], [['127.0.0.2:8081'], false],
        [['127.0.0.1:8081', ':8081'], false], [['127.0.0.1:8081', ':9090'], false],
        [[':8080-8082'], false], [[], false],
    ]) {
        const adapted = { apps: { http: { servers: {
            public: { listen: [':8443'] }, tunnel: { listen: listeners },
        } } } };
        const result = spawnSync('bash', ['-c', `${guard}\ncheck_tunnel_listeners`], {
            input: JSON.stringify(adapted), encoding: 'utf8',
        });
        assert.equal(result.status === 0, success, `${JSON.stringify(listeners)}: ${result.stderr}`);
    }
});

test('Tunnel smoke rejects activation without exactly one no-store response header', async () => {
    const workflow = parse(await readFile(workflowUrl, 'utf8'));
    const step = workflow.jobs.deploy.steps.find((step) => step.name === 'Route the Web SPA to OSS');
    const smoke = step.run.match(/smoke_tunnel_origin\(\) \{\n[\s\S]*?\n\}/)?.[0];
    assert.ok(smoke);
    for (const [headers, success] of [
        ['HTTP/1.1 200 OK\r\nCache-Control: no-store\r\n\r\n', true],
        ['HTTP/1.1 200 OK\r\ncache-control: no-store\r\n\r\n', true],
        ['HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n', false],
        ['HTTP/1.1 200 OK\r\nCache-Control: public, max-age=60\r\n\r\n', false],
        ['HTTP/1.1 200 OK\r\nCache-Control: no-store\r\nCache-Control: public\r\n\r\n', false],
    ]) {
        const result = spawnSync('bash', ['-c', `
curl() {
    case "$*" in
        *'Host: invalid.example'*) printf '421' ;;
        *) printf '%s' "$SMOKE_HEADERS" ;;
    esac
}
ss() { printf 'LISTEN 0 128 127.0.0.1:8081 0.0.0.0:*\\n'; }
${smoke}
smoke_tunnel_origin
`], { encoding: 'utf8', env: { ...process.env, SMOKE_HEADERS: headers } });
        assert.equal(result.status === 0, success, `${JSON.stringify(headers)}: ${result.stderr}`);
    }
});


test('canvas rollout verifies both approved hosts and exposes only covered origins', async () => {
    const { jobs: { deploy: { steps } } } = parse(await readFile(workflowUrl, 'utf8'));
    const rollout = steps.find(step => step.id === 'canvas_rollout');
    const temporary = await mkdtemp(join(tmpdir(), 'paws-canvas-origins-'));
    try {
        const scripts = join(temporary, 'packages/paws-dsh-canvas/scripts');
        await mkdir(scripts, { recursive: true });
        await writeFile(join(scripts, 'verify-production-license.mjs'), `
            if (process.argv[2] === 'https://121.43.32.242:8443' && process.env.REJECT_SECONDARY === '1') process.exit(1);
            console.log('1800057600000');
        `);
        for (const reject of ['0', '1']) {
            const output = join(temporary, 'result');
            await writeFile(output, '');
            const result = spawnSync('bash', ['-c', rollout.run], { cwd: temporary, encoding: 'utf8', env: {
                ...process.env, PAWS_WEB_ORIGIN: 'https://47.115.228.20:8443',
                PAWS_SECONDARY_WEB_ORIGIN: 'https://121.43.32.242:8443',
                PAWS_PROJECT_CANVAS_TLDRAW_LICENSE: 'test-secret-do-not-log', REJECT_SECONDARY: reject, GITHUB_OUTPUT: output,
            } });
            assert.equal(result.status, 0, result.stderr);
            const values = Object.fromEntries((await readFile(output, 'utf8')).trim().split('\n').map(line => line.split('=')));
            assert.equal(values.enabled, 'true');
            assert.equal(values.origins, reject === '1' ? 'https://47.115.228.20:8443'
                : 'https://47.115.228.20:8443,https://121.43.32.242:8443');
            assert.doesNotMatch(result.stdout + result.stderr, /test-secret-do-not-log/);
        }
    } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('secondary canvas activation uses the pinned existing SSH identity and preserves primary success on secondary failure', async () => {
    const { jobs: { deploy: { steps, env } } } = parse(await readFile(workflowUrl, 'utf8'));
    assert.equal(env.PAWS_SECONDARY_WEB_ORIGIN, 'https://121.43.32.242:8443');
    const ssh = steps.find(step => step.name === 'Configure verified SSH access');
    assert.match(ssh.run, /Host 47\.115\.228\.20 121\.43\.32\.242/);
    assert.match(ssh.run, /121\.43\.32\.242 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIANTgpKlzMNcTgKZLtWubafpSwCB\/V5imUq0\+Zj2dbep/);
    assert.match(ssh.run, /ssh-keygen -y -f .*id_paws_web_deploy.*>.*\.pub/);
    const publicKey = steps.find(step => step.name === 'Retain deployment public key for authorized host provisioning');
    assert.equal(publicKey?.uses, 'actions/upload-artifact@v4');
    assert.equal(publicKey?.with?.path, '${{ runner.temp }}/paws-web-deploy-public-key/id_paws_web_deploy.pub');
    const primary = steps.findIndex(step => step.id === 'live_verify');
    const secondary = steps.findIndex(step => step.id === 'secondary_caddy');
    const verify = steps.findIndex(step => step.id === 'secondary_verify');
    assert.ok(secondary > primary);
    assert.ok(verify > secondary);
    assert.match(steps[secondary].if, /live_verify.outcome == 'success'/);
    assert.match(steps[verify].run, /PAWS_LEGACY_WEB_ORIGIN=''[\s\S]*verify-web-release\.mjs.*PAWS_SECONDARY_WEB_ORIGIN/);
    assert.match(steps.find(step => step.name === 'Roll back failed secondary canvas activation')?.run ?? '', /deploy-secondary-canvas-ingress\.sh --rollback/);
    const primaryRollback = steps.find(step => step.name === 'Roll back failed Web activation');
    assert.match(primaryRollback.if, /steps.live_verify.outcome != 'success'/);
});
