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

test('installs the secondary canvas proxy while preserving its backend and SPA routing', () => {
    const configured = configure(fixture);
    assert.match(configured ?? '', /@paws_canvas_prefix path \/dsh-image-canvas \/dsh-image-canvas\/\*/);
    assert.match(configured, /rewrite \* \/web\/releases\/\{re.paws_canvas.1\}\/dsh-image-canvas\/\{re.paws_canvas.2\}\?/);
    assert.match(configured, /header_up -Authorization/);
    assert.match(configured, /header_up -Cookie/);
    assert.match(configured, /encode zstd gzip/);
    assert.ok(configured.includes(fixture.slice(fixture.indexOf('    # paws-web-oss:start'))));
    assert.equal(configure(configured), configured);
});

test('secondary proxy configuration rejects unapproved site addresses and ambiguous existing canvas handlers', () => {
    assert.throws(() => configurator.configureSecondaryCanvasCaddy(fixture, 'example.com:8443'), /approved secondary/);
    assert.throws(() => configure(fixture.replace('@backend', '@paws_canvas_prefix path /dsh-image-canvas/*\n    @backend')), /unmanaged canvas/);
    assert.throws(() => configure(fixture.replace('121.43.32.242:8443', 'other.invalid:8443')), /site block not found/);
});

test('secondary Caddy returns exact JS CSS and fonts and cannot fall back to the SPA', {
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
        const configured = configure('{\n admin off\n}\n' + fixture);
        assert.ok(configured, 'secondary canvas proxy must be installed');
        const config = configured.replace(/    tls [^\n]+\n/, '')
            .replace('121.43.32.242:8443', address).replace(/other.example \{[\s\S]*?\}\n/, '')
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
        for (const [file, [mime, bytes]] of files) {
            const response = await fetch(`${address}/dsh-image-canvas/${revision}/${file}?discard=1`, {
                redirect: 'manual', headers: { Authorization: 'Bearer test-only', Cookie: 'local_auth=1', 'Accept-Encoding': 'gzip' },
            });
            assert.equal(response.status, 200, file);
            assert.equal(response.headers.get('content-type'), mime, file);
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
        assert.ok(seen.every(request => !request.authorization && !request.cookie));
        assert.ok(seen.every(request => request.url.startsWith(`/web/releases/${revision}/dsh-image-canvas/`)));
        assert.ok(seen.every(request => !request.url.includes('?')));
    } finally {
        if (caddy?.exitCode === null) { caddy.kill('SIGTERM'); await once(caddy, 'exit'); }
        if (oss.listening) { oss.closeAllConnections(); await new Promise(resolve => oss.close(resolve)); }
        await rm(directory, { recursive: true, force: true });
    }
});
