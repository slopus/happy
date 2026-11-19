import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configureStagingWebCaddy } from './configure-staging-web-caddy.mjs';

const caddyAvailable = spawnSync('caddy', ['version'], { stdio: 'ignore' }).status === 0;

test('Caddy serves staging assets and preserves the core backend proxy', { skip: !caddyAvailable }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'paws-caddy-staging-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, '_expo'), { recursive: true });
    await mkdir(join(root, 'desktop-skins', 'dreamskin'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<html>web</html>');
    await writeFile(join(root, '_expo', 'app.js'), 'web-script');
    await writeFile(join(root, 'desktop-skins', 'dreamskin', 'background.1234567890abcdef.webp'), 'skin');

    const seen = [];
    const upstream = createServer((req, res) => {
        seen.push({ host: req.headers.host, origin: req.headers.origin, method: req.method, path: req.url });
        res.setHeader('Content-Type', 'application/json');
        res.end('{"status":"ok"}');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => upstream.close(resolve)));
    const reserve = createServer();
    await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));

    const source = configureStagingWebCaddy('# local staging fixture\n')
        .replace('47.115.228.20:8444 {', `http://127.0.0.1:${port} {`)
        .replace(/^    tls .*\n/m, '')
        .replaceAll('100.116.134.122:3305', `127.0.0.1:${upstream.address().port}`)
        .replaceAll('/var/www/paws-web-staging/current', root);
    const config = join(root, 'Caddyfile');
    await writeFile(config, `{\n    admin off\n    auto_https off\n}\n${source}`);
    const caddy = spawn('caddy', ['run', '--config', config, '--adapter', 'caddyfile'], { stdio: 'ignore' });
    t.after(() => { caddy.kill('SIGTERM'); });
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(300) });
            if (response.ok) { ready = true; break; }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(ready, 'Caddy did not start with the generated staging site');

    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal(seen.at(-1).path, '/health');
    assert.equal((await fetch(`${url}/_expo/missing.js`)).status, 404);
    assert.equal(await (await fetch(`${url}/`)).text(), '<html>web</html>');
    assert.equal(await (await fetch(`${url}/_expo/app.js`)).text(), 'web-script');
    const beforeRetiredRequests = seen.length;
    for (const path of ['/agent-party/', '/agent-party/api/access/ticket', '/agent-profiles', '/agent-party-access', '/settings/agent-party-admin']) {
        assert.equal((await fetch(`${url}${path}`)).status, 410);
        assert.equal((await fetch(`${url}${path}`, { method: 'POST' })).status, 410);
    }
    assert.equal(seen.length, beforeRetiredRequests, 'Retired paths reached the core backend');
    const skinCache = (await fetch(`${url}/desktop-skins/dreamskin/background.1234567890abcdef.webp`)).headers.get('cache-control') ?? '';
    assert.match(skinCache, /max-age=31536000, immutable/);
    assert.doesNotMatch(skinCache, /no-store/);
    assert.equal((await fetch(`${url}/desktop-skins/dreamskin/background.1234567890abcdef.webp`)).headers.get('content-type'), 'image/webp');
    assert.match((await fetch(`${url}/_expo/app.js`)).headers.get('cache-control') ?? '', /max-age=31536000, immutable/);
    assert.equal((await fetch(`${url}/desktop-skins/dreamskin/missing.webp`)).headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${url}/`)).headers.get('cache-control'), 'no-store');
    assert.match((await fetch(`${url}/share/probe`)).headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
});
