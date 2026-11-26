import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    configureProductionWebCaddy,
    PRODUCTION_WEB_OSS_HOST,
    PRODUCTION_WEB_OSS_ORIGIN,
    PRODUCTION_CADDY_GRACE_PERIOD,
    LEGACY_WEB_REDIRECT_CADDY_BLOCK_START,
    PUBLIC_SHARE_CADDY_BLOCK_START,
    WEB_OSS_CADDY_BLOCK_START,
} from './configure-production-web-caddy.mjs';

const fixture = `:8001 {
    respond "other site"
}

:8080 {
    root * /var/www/happy-web
    encode gzip
    try_files {path} /index.html
    file_server
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
    assert.match(configured, /@backend path \/v1\/\* \/v2\/\* \/v3\/\* \/v4\/\* \/files\/\* \/health/);
    assert.doesNotMatch(configured, /@backend path[^\n]*\/share\/\*/);
    assert.match(configured, /@public_session_share path \/share\/\*/);
    assert.match(configured, /Cache-Control "no-store"/);
    assert.match(configured, /Content-Security-Policy "default-src 'self'/);
    assert.match(configured, new RegExp(`style-src [^;]*${PRODUCTION_WEB_OSS_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(configured, new RegExp(`font-src [^;]*${PRODUCTION_WEB_OSS_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(configured, /X-Robots-Tag "noindex, nofollow, noarchive"/);
    assert.match(configured, /X-Content-Type-Options "nosniff"/);
    assert.match(configured, /Referrer-Policy "no-referrer"/);
});

test('serves every Web file from OSS without a filesystem fallback', () => {
    const configured = configureProductionWebCaddy(fixture);

    assert.match(configured, new RegExp(WEB_OSS_CADDY_BLOCK_START));
    assert.match(configured, /@paws_web_asset path \/_expo\/\* \/assets\/\* \/desktop-skins\/\* \/\.well-known\/\* \/canvaskit\.wasm \/favicon\.ico \/favicon-active\.ico \/metadata\.json/);
    assert.match(configured, new RegExp(`redir @paws_web_asset ${PRODUCTION_WEB_OSS_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\{uri\\} 302`));
    assert.match(configured, /rewrite \* \/web\/current\/index\.html/);
    assert.match(configured, new RegExp(`reverse_proxy ${PRODUCTION_WEB_OSS_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(configured, /header_up Host happy-app-ota-jacky\.oss-cn-hangzhou\.aliyuncs\.com/);
    assert.match(configured, /header_down -Content-Disposition/);
    assert.match(configured, /header_down Content-Type "text\/html; charset=utf-8"/);
    assert.doesNotMatch(configured, /\/var\/www\/happy-web/);
    assert.doesNotMatch(configured, /^\s*root\s+/m);
    assert.doesNotMatch(configured, /^\s*file_server\s*$/m);
});

test('redirects the legacy HTTP Web entry to the canonical OSS-backed origin', () => {
    const configured = configureProductionWebCaddy(fixture);

    assert.match(configured, new RegExp(LEGACY_WEB_REDIRECT_CADDY_BLOCK_START));
    assert.match(configured, /:8080 \{\n\s+# paws-web-legacy-redirect:start\n\s+redir https:\/\/47\.115\.228\.20:8443\{uri\} 308\n\s+# paws-web-legacy-redirect:end\n\}/);
    assert.doesNotMatch(configured, /\/var\/www\/happy-web/);
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
    assert.equal(twice.match(new RegExp(WEB_OSS_CADDY_BLOCK_START, 'g'))?.length, 1);
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

test('fails closed when an unexpected site still references the legacy Web directory', () => {
    assert.throws(
        () => configureProductionWebCaddy(`${fixture}\n:9090 {\n    root * /var/www/happy-web\n}\n`),
        /still references the legacy Web directory/,
    );
});

test('Caddy proxies explicit immutable canvas files on the same origin and rejects other paths', {
    skip: spawnSync('caddy', ['version'], { stdio: 'ignore' }).status !== 0,
}, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'paws-canvas-caddy-'));
    const seen = [];
    const oss = http.createServer((request, response) => {
        seen.push({ url: request.url, method: request.method, auth: request.headers.authorization, cookie: request.headers.cookie });
        response.writeHead(200, {
            'Content-Type': 'application/javascript',
            'Content-Disposition': 'attachment',
            'Set-Cookie': 'oss_example=1',
        });
        response.end('canvas code');
    });
    const addressFor = async (server) => {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        return `127.0.0.1:${server.address().port}`;
    };
    let caddy;
    try {
        const ossAddress = await addressFor(oss);
        const portReservation = http.createServer();
        const address = 'http://' + await addressFor(portReservation);
        await new Promise(resolve => portReservation.close(resolve));
        const source = `{
    admin off
}
${address} {
    @backend path /health
    handle @backend {
        respond "backend"
    }
    handle {
        root * /var/www/happy-web
        file_server
    }
}`;
        const configPath = join(directory, 'Caddyfile');
        const config = configureProductionWebCaddy(source, address)
            .replaceAll(PRODUCTION_WEB_OSS_ORIGIN, `http://${ossAddress}`)
            .replaceAll(PRODUCTION_WEB_OSS_HOST, ossAddress);
        await writeFile(configPath, config);
        caddy = spawn('caddy', ['run', '--config', configPath, '--adapter', 'caddyfile'], { stdio: ['ignore', 'ignore', 'pipe'] });
        const caddyProcess = caddy;
        await new Promise((resolve, reject) => {
            let logs = '';
            const timeout = setTimeout(() => reject(Error(logs || 'Caddy did not start')), 4_000);
            const onLog = (chunk) => {
                logs += chunk;
                if (!logs.includes('serving initial configuration')) return;
                clearTimeout(timeout);
                caddyProcess.stderr.off('data', onLog);
                resolve();
            };
            caddyProcess.on('error', error => { clearTimeout(timeout); reject(error); });
            caddyProcess.on('exit', code => { clearTimeout(timeout); reject(Error(logs || `Caddy exited with code ${code}`)); });
            caddyProcess.stderr.on('data', onLog);
        });

        const revision = 'a'.repeat(40);
        const prefix = `/dsh-image-canvas/${revision}`;
        const js = await fetch(address + prefix + '/canvas.js?no_upstream_query=1', {
            redirect: 'manual', headers: { Cookie: 'local_auth=1', Authorization: 'Bearer test' },
        });
        assert.equal(js.status, 200);
        assert.equal(js.headers.get('content-type'), 'application/javascript');
        assert.equal(js.headers.get('content-disposition'), null);
        assert.equal(js.headers.get('set-cookie'), null);
        assert.equal(js.headers.get('x-frame-options'), 'SAMEORIGIN');
        assert.equal(js.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(await js.text(), 'canvas code');
        const font = await fetch(address + prefix + '/assets/fonts/IBMPlexSans-Medium.woff2', { method: 'HEAD' });
        assert.equal(font.status, 200);
        for (const path of [
            '/dsh-image-canvas/index.html',
            `${prefix}/.secret.txt`,
            `${prefix}/assets/private/canvas.js`,
            `${prefix}/web/releases/${revision}/index.html`,
        ]) {
            const blocked = await fetch(address + path);
            assert.equal(blocked.status, 404, path);
            await blocked.text();
        }
        const blocked = await fetch(address + prefix + '/canvas.js', { method: 'POST' });
        assert.equal(blocked.status, 404);
        await blocked.text();
        assert.deepEqual(seen, [
            { url: `/web/releases/${revision}/dsh-image-canvas/canvas.js`, method: 'GET', auth: undefined, cookie: undefined },
            { url: `/web/releases/${revision}/dsh-image-canvas/assets/fonts/IBMPlexSans-Medium.woff2`, method: 'HEAD', auth: undefined, cookie: undefined },
        ]);
    } finally {
        if (caddy?.exitCode === null) {
            caddy.kill('SIGTERM');
            await once(caddy, 'exit');
        }
        if (oss.listening) {
            oss.closeAllConnections();
            await new Promise(resolve => oss.close(resolve));
        }
        await rm(directory, { recursive: true, force: true });
    }
});
