import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: [fileURLToPath(new URL('./bridge.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node' });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`;

async function bridgeFixture() {
    const bridge = await import(`${moduleUrl}#${Math.random()}`);
    let receive;
    const parent = { postMessage() {} };
    globalThis.window = { parent, location: { origin: 'https://paws.test' }, addEventListener: (_type, listener) => { receive = listener; } };
    bridge.startParentConnection();
    return { bridge, sync: update => receive({ data: update, origin: 'https://paws.test', source: parent }) };
}
const initial = { type: 'paws-project-canvas/sync', sessionKey: 'board', manifestRevision: 1, theme: 'light', assets: [],
    scene: { revision: 2, document: '{"store":{}}' } };

test('late editor attachment retains the last scene after URI-only and palette syncs', async () => {
    const { bridge, sync } = await bridgeFixture();
    sync(initial);
    sync({ ...initial, manifestRevision: 2, scene: undefined });
    sync({ ...initial, manifestRevision: 3, theme: 'dark', scene: undefined });
    assert.deepEqual(bridge.currentSync().scene, initial.scene);
    assert.equal(bridge.currentSync().manifestRevision, 3);
    assert.equal(bridge.currentSync().theme, 'dark');
});

test('a new scene replaces the retained scene and a new session resets it', async () => {
    const { bridge, sync } = await bridgeFixture();
    sync(initial);
    const changed = { revision: 3, document: '{"store":{"changed":true}}' };
    sync({ ...initial, manifestRevision: 2, scene: changed });
    sync({ ...initial, manifestRevision: 3, scene: undefined });
    assert.deepEqual(bridge.currentSync().scene, changed);
    sync({ ...initial, sessionKey: 'another-board', scene: undefined });
    assert.equal(bridge.currentSync().scene, undefined);
});
