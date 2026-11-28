import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as configurator from './configure-production-web-caddy.mjs';

const fixture = `121.43.32.242:8443 {
    tls /etc/caddy/public.pem /etc/caddy/private.pem
    @backend path /v1/* /health
    handle @backend {
        reverse_proxy localhost:3005
    }
    # paws-web-oss:start
    @paws_web_asset path /_expo/* /assets/*
    redir @paws_web_asset https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com{uri} 302
    handle {
        rewrite * /web/current/index.html
        reverse_proxy https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com
    }
    # paws-web-oss:end
}
other.example {
    respond "untouched"
}
`;
const configure = source => configurator.configureSecondaryCanvasCaddy(source);
// The approved secondary predates the primary site's managed OSS markers.
const legacyFixture = fixture.replace(/    # paws-web-oss:(?:start|end)\n/g, '')
    .replace('    @paws_web_asset path /_expo/* /assets/*\n    redir @paws_web_asset https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com{uri} 302', `    @public_session_share path /share/*
    header @public_session_share {
        Cache-Control "no-store"
    }
    handle /assets/* {
        redir https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com{uri} 302
    }`)
    .replace('        reverse_proxy https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com\n', `        reverse_proxy https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com {
            header_up Host happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com
            header_down -Content-Disposition
            header_down Content-Type "text/html; charset=utf-8"
        }
`);

test('installs the secondary canvas proxy while preserving its backend and SPA routing', () => {
    const configured = configure(fixture);
    assert.match(configured ?? '', /@paws_canvas_prefix path \/dsh-image-canvas \/dsh-image-canvas\/\*/);
    assert.match(configured, /rewrite \* \/web\/releases\/\{re.paws_canvas.1\}\/dsh-image-canvas\/\{re.paws_canvas.2\}\?/);
    assert.match(configured, /header_up -Authorization/);
    assert.match(configured, /header_up -Cookie/);
    assert.match(configured, /encode zstd gzip/);
    assert.match(configured, /handle \{\n\s+header >Cache-Control "no-store"\n\s+rewrite \* \/web\/current\/index\.html/);
    assert.match(configured, /handle @backend \{\n\s+reverse_proxy localhost:3005/);
    assert.match(configured, /redir @paws_web_asset https:\/\/happy-app-ota-jacky\.oss-cn-hangzhou\.aliyuncs\.com\{uri\} 302/);
    assert.ok(configured.endsWith(fixture.slice(fixture.indexOf('other.example {'))));
    assert.equal(configure(configured), configured);
});

test('secondary proxy configuration rejects unapproved site addresses and ambiguous existing canvas handlers', () => {
    assert.throws(() => configurator.configureSecondaryCanvasCaddy(fixture, 'example.com:8443'), /approved secondary/);
    assert.throws(() => configure(fixture.replace('@backend', '@paws_canvas_prefix path /dsh-image-canvas/*\n    @backend')), /unmanaged canvas/);
    assert.throws(() => configure(fixture.replace('121.43.32.242:8443', 'other.invalid:8443')), /site block not found/);
});

test('secondary HTML policy fails closed without one approved managed OSS fallback', () => {
    const fallback = '    handle {\n        rewrite * /web/current/index.html\n        reverse_proxy https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com\n    }\n';
    for (const source of [
        fixture.replace(/    # paws-web-oss:start[\s\S]*?    # paws-web-oss:end\n/, ''),
        fixture.replace('/web/current/index.html', '/web/other/index.html'),
        fixture.replace('    # paws-web-oss:end', '    # paws-web-oss:end\n    # paws-web-oss:start\n' + fallback + '    # paws-web-oss:end'),
        fixture.replace('        rewrite * /web/current/index.html', '        rewrite * /web/other/index.html\n        rewrite * /web/current/index.html'),
        fixture.replace('    # paws-web-oss:end', fallback + '    # paws-web-oss:end'),
        fixture.replace('reverse_proxy https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com', 'reverse_proxy https://unowned.example'),
    ]) assert.throws(() => configure(source), /managed OSS (?:Web handler|SPA fallback)/i);
});

test('secondary HTML policy replaces a stale direct policy and remains idempotent', () => {
    const source = fixture.replace('        rewrite * /web/current/index.html',
        '        header Cache-Control "public,max-age=3600"\n        rewrite * /web/current/index.html');
    const configured = configure(source);
    assert.match(configured, /header >Cache-Control "no-store"/);
    assert.doesNotMatch(configured, /max-age=3600/);
    assert.equal(configure(configured), configured);
    assert.throws(() => configure(source.replace('        rewrite *',
        '        header >Cache-Control "no-cache"\n        rewrite *')), /Ambiguous Cache-Control/);
});

test('updates the historical markerless secondary SPA without changing its other handlers', () => {
    const configured = configure(legacyFixture);
    assert.match(configured, /handle \{\n\s+header >Cache-Control "no-store"\n\s+rewrite \* \/web\/current\/index\.html/);
    const withoutAdditions = configured
        .replace(/^\{\n\tgrace_period 10s\n\}\n\n/, '')
        .replace(/    # paws-secondary-canvas:start\n[\s\S]*?    # paws-secondary-canvas:end\n/, '')
        .replace('        header >Cache-Control "no-store"\n', '');
    assert.equal(withoutAdditions, legacyFixture);
    assert.doesNotMatch(configured, /paws-web-oss/);
    assert.equal(configure(configured), configured);
});

test('markerless secondary rejects ambiguous, untrusted and nested fallback lookalikes', () => {
    const fallback = '    handle {\n        rewrite * /web/current/index.html\n        reverse_proxy https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com\n    }\n';
    for (const source of [
        legacyFixture.replace('/web/current/index.html', '/web/other/index.html'),
        legacyFixture.replace('    handle {\n', fallback + '    handle {\n'),
        legacyFixture.replace('        reverse_proxy https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com {', '        reverse_proxy https://unowned.example {'),
        legacyFixture.replace('        rewrite * /web/current/index.html', '        rewrite * /web/other/index.html\n        rewrite * /web/current/index.html'),
        legacyFixture.replace('    handle {\n', '    route {\n'),
        legacyFixture.replace('    handle {\n', '    route {\n' + fallback + '    }\n    handle {\n')
            .replace('        rewrite * /web/current/index.html\n        reverse_proxy https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com {', '        rewrite * /web/other/index.html\n        reverse_proxy https://unowned.example {'),
        legacyFixture.replace('    handle {\n', '    handle {\n        route {\n')
            .replace('    }\n}\nother.example', '        }\n    }\n}\nother.example'),
    ]) assert.throws(() => configure(source), /managed OSS (?:Web handler|SPA fallback)/i);
    for (const marker of ['start', 'end']) {
        assert.throws(() => configure(legacyFixture.replace('    handle {\n', `    # paws-web-oss:${marker}\n    handle {\n`)), /incomplete/);
    }
});

for (const [variant, source] of [['managed', fixture], ['historical markerless', legacyFixture]]) {
test(`secondary Caddy (${variant}) returns exact JS CSS and fonts and cannot fall back to the SPA`, {
    skip: spawnSync('caddy', ['version'], { stdio: 'ignore' }).status !== 0,
}, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'paws-secondary-canvas-'));
    const seen = [];
    const files = new Map([
        ['index.html', ['text/html; charset=utf-8', '<html>canvas frame</html>']],
        ['canvas.js', ['application/javascript', 'window.renderCanvas?.();\n'.repeat(1000)]],
        ['canvas.css', ['text/css', '.canvas { display: block; }']],
        ['assets/fonts/IBMPlexSans-Medium.woff2', ['font/woff2', 'font bytes']],
    ]);
    const revision = 'a'.repeat(40);
    const oss = http.createServer((request, response) => {
        seen.push({ url: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie });
        if (request.url === '/web/current/index.html') {
            response.writeHead(request.headers['if-modified-since'] ? 304 : 200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'public,max-age=3600',
                'Last-Modified': 'Sat, 28 Nov 2026 04:13:32 GMT',
            });
            response.end('<html>app shell</html>');
            return;
        }
        if (request.url === '/assets/app.hash.js') {
            response.writeHead(200, { 'Content-Type': 'application/javascript',
                'Cache-Control': 'public,max-age=31536000,immutable' });
            response.end('hashed asset');
            return;
        }
        const file = files.get(request.url?.replace(`/web/releases/${revision}/dsh-image-canvas/`, ''));
        if (!file) { response.writeHead(404, { 'Content-Type': 'application/xml' }); response.end('<Error>NoSuchKey</Error>'); return; }
        response.writeHead(200, { 'Content-Type': file[0], 'Content-Length': Buffer.byteLength(file[1]),
            'Cache-Control': 'public,max-age=31536000,immutable', 'Content-Disposition': 'attachment', 'Set-Cookie': 'oss_cookie=1' });
        response.end(file[1]);
    });
    const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `127.0.0.1:${server.address().port}`; };
    let caddy;
    try {
        const ossAddress = await listen(oss);
        const reserve = http.createServer();
        const address = `http://${await listen(reserve)}`;
        await new Promise(resolve => reserve.close(resolve));
        const configured = configure('{\n admin off\n}\n' + source);
        assert.ok(configured, 'secondary canvas proxy must be installed');
        const config = configured.replace(/    tls [^\n]+\n/, '')
            .replace('121.43.32.242:8443', address).replace(/other.example \{[\s\S]*?\}\n/, '')
            .replace('reverse_proxy localhost:3005', 'respond "backend fixture"')
            .replaceAll(configurator.PRODUCTION_WEB_OSS_ORIGIN, `http://${ossAddress}`)
            .replaceAll(configurator.PRODUCTION_WEB_OSS_HOST, ossAddress);
        const configPath = join(directory, 'Caddyfile');
        await writeFile(configPath, config);
        caddy = spawn('caddy', ['run', '--config', configPath, '--adapter', 'caddyfile'], { stdio: ['ignore', 'ignore', 'pipe'] });
        await new Promise((resolve, reject) => {
            let logs = '';
            const timeout = setTimeout(() => reject(Error(logs || 'Caddy did not start')), 4000);
            caddy.on('error', error => { clearTimeout(timeout); reject(error); });
            caddy.on('exit', code => { clearTimeout(timeout); reject(Error(logs || `Caddy exited ${code}`)); });
            caddy.stderr.on('data', chunk => { logs += chunk; if (logs.includes('serving initial configuration')) { clearTimeout(timeout); resolve(); } });
        });
        for (const path of ['/', '/session/example', '/share/example']) {
            for (const method of ['GET', 'HEAD']) {
                for (const conditional of [false, true]) {
                    const response = await fetch(address + path, { method, headers: conditional
                        ? { 'If-Modified-Since': 'Sat, 28 Nov 2026 04:13:32 GMT' } : undefined });
                    assert.equal(response.status, conditional ? 304 : 200, `${method} ${path}`);
                    assert.equal(response.headers.get('cache-control'), 'no-store', `${method} ${path}`);
                    assert.equal(response.headers.get('last-modified'), 'Sat, 28 Nov 2026 04:13:32 GMT');
                    assert.equal(await response.text(), conditional || method === 'HEAD' ? '' : '<html>app shell</html>');
                }
            }
        }
        const backend = await fetch(address + '/health');
        assert.equal(await backend.text(), 'backend fixture');
        assert.equal(backend.headers.get('cache-control'), null);
        const assetRedirect = await fetch(address + '/assets/app.hash.js', { redirect: 'manual' });
        assert.equal(assetRedirect.status, 302);
        assert.equal(assetRedirect.headers.get('location'), `http://${ossAddress}/assets/app.hash.js`);
        const asset = await fetch(address + '/assets/app.hash.js');
        assert.equal(asset.headers.get('cache-control'), 'public,max-age=31536000,immutable');
        assert.equal(await asset.text(), 'hashed asset');
        for (const [file, [mime, bytes]] of files) {
            const response = await fetch(`${address}/dsh-image-canvas/${revision}/${file}?discard=1`, {
                redirect: 'manual', headers: { Authorization: 'Bearer test-only', Cookie: 'local_auth=1', 'Accept-Encoding': 'gzip' },
            });
            assert.equal(response.status, 200, file);
            assert.equal(response.headers.get('content-type'), mime, file);
            assert.equal(response.headers.get('cache-control'), 'public,max-age=31536000,immutable', file);
            if (file === 'canvas.js') assert.equal(response.headers.get('content-encoding'), 'gzip');
            assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
            assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
            assert.equal(response.headers.get('content-disposition'), null);
            assert.equal(response.headers.get('set-cookie'), null);
            assert.equal(await response.text(), bytes, file);
        }
        for (const file of ['canvas.js', 'canvas.css', 'assets/fonts/missing.woff2', '.private', 'index.html/extra']) {
            const suffix = file === 'canvas.js' || file === 'canvas.css' ? file.replace('.', '.missing.') : file;
            const response = await fetch(`${address}/dsh-image-canvas/${revision}/${suffix}`);
            assert.equal(response.status, 404, file);
            assert.doesNotMatch(await response.text(), /canvas frame|web\/current\/index.html/);
        }
        const canvasRequests = seen.filter(request => request.url.startsWith(`/web/releases/${revision}/dsh-image-canvas/`));
        assert.ok(canvasRequests.every(request => !request.authorization && !request.cookie));
        assert.ok(canvasRequests.every(request => !request.url.includes('?')));
        assert.ok(seen.every(request => request.url === '/web/current/index.html'
            || request.url === '/assets/app.hash.js'
            || request.url.startsWith(`/web/releases/${revision}/dsh-image-canvas/`)));
    } finally {
        if (caddy?.exitCode === null) { caddy.kill('SIGTERM'); await once(caddy, 'exit'); }
        if (oss.listening) { oss.closeAllConnections(); await new Promise(resolve => oss.close(resolve)); }
        await rm(directory, { recursive: true, force: true });
    }
});
}
