import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import {
    RUNTIME_CONFIG_END,
    RUNTIME_CONFIG_START,
    injectWebRuntimeServerConfig,
} from './inject-web-runtime-server-config.mjs';

function extractManagedScript(html) {
    const start = html.indexOf(RUNTIME_CONFIG_START);
    const end = html.indexOf(RUNTIME_CONFIG_END);
    assert.ok(start >= 0, 'expected the managed runtime configuration block');
    assert.ok(end > start, 'expected the managed runtime configuration block to be complete');
    const block = html.slice(start, end + RUNTIME_CONFIG_END.length);
    return block.match(/<script>([\s\S]*?)<\/script>/)?.[1];
}

function runInjectedScript(script, origin, existingConfig) {
    const location = new URL(origin);
    const globalThis = { location, __HAPPY_CONFIG__: existingConfig };
    runInNewContext(script, { globalThis });
    return globalThis.__HAPPY_CONFIG__;
}

test('uses the current origin only for approved production web hosts', () => {
    const output = injectWebRuntimeServerConfig('<html><head></head><body></body></html>');
    const script = extractManagedScript(output);

    assert.equal(runInjectedScript(script, 'https://paws.rodeo').serverUrl, 'https://paws.rodeo');
    assert.equal(runInjectedScript(script, 'https://app.paws.rodeo').serverUrl, 'https://app.paws.rodeo');
    assert.equal(runInjectedScript(script, 'http://app.paws.rodeo')?.serverUrl, undefined);
    assert.equal(runInjectedScript(script, 'https://app.paws.rodeo.evil.example')?.serverUrl, undefined);
    assert.equal(runInjectedScript(script, 'https://47.115.228.20:8443').serverUrl, 'https://47.115.228.20:8443');
    assert.equal(runInjectedScript(script, 'https://121.43.32.242:8443')?.serverUrl, 'https://121.43.32.242:8443');
    assert.equal(runInjectedScript(script, 'https://preview.example')?.serverUrl, undefined);
});

test('preserves existing browser runtime configuration keys', () => {
    const script = extractManagedScript(injectWebRuntimeServerConfig('<head></head>'));

    const config = runInjectedScript(script, 'https://paws.rodeo', { featureFlag: 'keep-me' });
    assert.equal(config.featureFlag, 'keep-me');
    assert.equal(config.serverUrl, 'https://paws.rodeo');
});

test('replaces the managed runtime configuration block on reinjection', () => {
    const once = injectWebRuntimeServerConfig('<html><head></head></html>');
    const twice = injectWebRuntimeServerConfig(once);

    assert.equal(twice, once);
    assert.equal(twice.split(RUNTIME_CONFIG_START).length - 1, 1);
    assert.equal(twice.split(RUNTIME_CONFIG_END).length - 1, 1);
});

test('rejects an HTML entry without a head closing tag', () => {
    assert.throws(
        () => injectWebRuntimeServerConfig('<html><body></body></html>'),
        /Web entry has no <\/head>/,
    );
});

test('rejects a one-sided managed runtime configuration marker', () => {
    assert.throws(
        () => injectWebRuntimeServerConfig(`<html><head>${RUNTIME_CONFIG_START}</head></html>`),
        /incomplete managed runtime configuration block/,
    );
});

test('stamps the canvas entry for this release and exposes its license only on the canonical origin', () => {
    const origin = 'https://47.115.228.20:8443';
    const revision = 'abcd'.repeat(10);
    const license = 'sample</script>';
    const evaluationExpiry = '1800057600000';
    const html = injectWebRuntimeServerConfig('<head></head>', { origin, revision, license, evaluationExpiry });
    assert.ok(html.includes(`<meta name="paws-project-canvas-entry" content="/dsh-image-canvas/${revision}/index.html">`));
    assert.equal(html.split('</script>').length, 2);
    const script = extractManagedScript(html);
    assert.equal(runInjectedScript(script, origin).projectCanvasTldrawLicense, license);
    assert.equal(runInjectedScript(script, origin).projectCanvasTldrawExpiresAt, Number(evaluationExpiry));
    assert.equal(runInjectedScript(script, 'https://47.115.228.20').projectCanvasTldrawLicense, undefined);
    assert.equal(runInjectedScript(script, 'https://paws.rodeo').projectCanvasTldrawLicense, undefined);
    assert.throws(
        () => injectWebRuntimeServerConfig('<head></head>', { origin, revision }),
        /Missing or malformed PAWS_PROJECT_CANVAS_TLDRAW_LICENSE/,
    );
    assert.throws(
        () => injectWebRuntimeServerConfig('<head></head>', { origin, revision, license, evaluationExpiry: 'not a date' }),
        /Invalid Project Canvas evaluation expiry/,
    );
});
