import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    configureProductionWebCaddy,
    PRODUCTION_CADDY_GRACE_PERIOD,
    PUBLIC_SHARE_CADDY_BLOCK_START,
} from './configure-production-web-caddy.mjs';

const fixture = `:8001 {
    respond "other site"
}

47.115.228.20:8443 {
    tls cert key
    @backend path /v1/* /v3/* /v4/* /files/* /share/*
    handle @backend {
        reverse_proxy localhost:3005
    }
    handle {
        root * /var/www/happy-web
        try_files {path} /index.html
        file_server
    }
}
`;
const configuratorCliPath = fileURLToPath(new URL('./configure-production-web-caddy.mjs', import.meta.url));

async function runConfiguratorCli(source) {
    const directory = await mkdtemp(join(tmpdir(), 'paws-caddy-config-'));
    const inputPath = join(directory, 'current.Caddyfile');
    const outputPath = join(directory, 'next.Caddyfile');

    try {
        await writeFile(inputPath, source, 'utf8');
        const result = spawnSync(
            process.execPath,
            [configuratorCliPath, inputPath, outputPath],
            { encoding: 'utf8' },
        );
        return {
            status: result.status,
            stderr: result.stderr,
            stdout: result.stdout,
            output: await readFile(outputPath, 'utf8'),
        };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('routes public shares to the SPA and installs exact public-document headers', () => {
    const configured = configureProductionWebCaddy(fixture);
    assert.match(configured, new RegExp(`^\\{\\n\\tgrace_period ${PRODUCTION_CADDY_GRACE_PERIOD}\\n\\}`, 'm'));
    assert.match(configured, /@backend path \/v1\/\* \/v3\/\* \/v4\/\* \/files\/\*/);
    assert.doesNotMatch(configured, /@backend path[^\n]*\/share\/\*/);
    assert.match(configured, /@public_session_share path \/share\/\*/);
    assert.match(configured, /Cache-Control "no-store"/);
    assert.match(configured, /Content-Security-Policy "default-src 'self'/);
    assert.match(configured, /X-Robots-Tag "noindex, nofollow, noarchive"/);
    assert.match(configured, /X-Content-Type-Options "nosniff"/);
    assert.match(configured, /Referrer-Policy "no-referrer"/);
});

test('bounds an existing eternal grace period so Caddy reloads cannot wait for WebSockets forever', () => {
    const configured = configureProductionWebCaddy(`{
    default_sni 47.115.228.20
    grace_period eternal
}

${fixture}`);

    assert.match(configured, new RegExp(`\\n    grace_period ${PRODUCTION_CADDY_GRACE_PERIOD}\\n`));
    assert.doesNotMatch(configured, /grace_period eternal/);
});

test('is idempotent and leaves unrelated sites untouched', () => {
    const once = configureProductionWebCaddy(fixture);
    const twice = configureProductionWebCaddy(once);
    assert.equal(twice, once);
    assert.equal(twice.match(new RegExp(PUBLIC_SHARE_CADDY_BLOCK_START, 'g'))?.length, 1);
    assert.match(twice, /:8001 \{\n    respond "other site"\n\}/);
});

test('CLI reports unchanged for an already-managed production config', async () => {
    const configured = configureProductionWebCaddy(fixture);
    const result = await runConfiguratorCli(configured);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'unchanged\n');
    assert.equal(result.output, configured);
});

test('CLI reports changed when the generated production config differs', async () => {
    const result = await runConfiguratorCli(fixture);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'changed\n');
    assert.notEqual(result.output, fixture);
});

test('fails closed when the production site matcher is missing', () => {
    assert.throws(() => configureProductionWebCaddy(':8080 {\n}\n'), /site block not found/);
});
