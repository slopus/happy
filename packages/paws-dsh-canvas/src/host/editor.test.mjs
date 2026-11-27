import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Exercise the real attachment lifecycle and outbound request protocol. Only
// the DOM/SDK and image transport are replaced; viewport and sync events are
// controlled by the tests instead of a running browser.
const hostKey = '__pawsCanvasEditorTest';
const doubles = {
    tldraw: `export const atom = () => { let value; return {get:()=>value,set:next=>{value=next}} };
        export const createShapeId = value => 'shape:'+value; export const loadSnapshot = () => {};`,
    bridge: `const host = () => globalThis.${hostKey};
        export const currentSync = () => host().sync;
        export const postCanvasMessage = message => host().messages.push(message);
        export const subscribeSync = listener => { host().syncListeners.add(listener); return () => host().syncListeners.delete(listener) };
        export const subscribeCommand = listener => { host().commands.add(listener); return () => host().commands.delete(listener) };
        export const subscribeSceneResult = () => () => {};`,
    imageCache: `export const fetchDisplayBlob = uri => globalThis.${hostKey}.readBlob(uri);
        export const setAssetUri = () => {}; export const removeAssetUri = () => {};`,
    sceneSync: `export const createSceneSync = () => ({ accept:()=>false, hasLocalEdits:()=>false,
        dispose:()=>{}, trackPointer:()=>false, saveDraft:()=>{}, trackUserEdit:()=>{}, flush:()=>{}, retry:()=>{} });`,
    sceneDocument: `export const managedAssetKey = /^asset-[a-f0-9]{64}-[a-f0-9]{64}$/;
        export const readSceneDocument = () => undefined; export const writeSceneDocument = () => undefined;`,
    'browser-image-utils': `export const blobToDataUrl = async () => 'data:image/png;base64,AAAA';`,
    'studio-tl-canvas': `export const landTlItems = async (editor, items, allowed) => {
        if (allowed()) globalThis.${hostKey}.landings.push(...items);
    };`,
};
const bundled = await build({
    entryPoints: [fileURLToPath(new URL('./editor.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'controlled-editor-boundaries', setup(builder) {
        builder.onResolve({ filter: /^(tldraw|.*\/(?:bridge|imageCache|sceneSync|sceneDocument|browser-image-utils|studio-tl-canvas))$/ }, args => {
            const name = args.path.split('/').at(-1);
            return name in doubles ? { path: name, namespace: 'test-boundary' } : undefined;
        });
        builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, args => ({ contents: doubles[args.path], loader: 'js' }));
    } }],
});
const { attachProjectEditor } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

function fixture(count = 126) {
    const state = {
        sync: { type: 'paws-project-canvas/sync', sessionKey: 'board', theme: 'light',
            assets: Array.from({ length: count }, (_, i) => ({ id: `asset-${i.toString(16).padStart(64, '0')}`,
                versionId: 'a'.repeat(64), name: `image ${i}`, mimeType: 'image/png', x: i * 4, y: 0 })) },
        messages: [], syncListeners: new Set(), commands: new Set(), landings: [],
        readBlob: async () => new Blob(['preview'], { type: 'image/png' }),
    };
    globalThis[hostKey] = state;
    const frames = new Map();
    let nextFrame = 0;
    globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
    globalThis.cancelAnimationFrame = id => frames.delete(id);
    globalThis.window = new EventTarget();
    globalThis.Image = class { naturalWidth = 100; naturalHeight = 100; async decode() {} };
    let zoom = 1;
    let viewport = { x: 0, y: 0, w: 1000, h: 800 };
    const viewportListeners = new Set();
    const shapes = new Map();
    const bitmaps = new Map();
    const effects = { registerAfterCreateHandler: () => () => {}, registerAfterChangeHandler: () => () => {},
        registerAfterDeleteHandler: () => () => {} };
    const editor = {
        store: { scopedTypes: { document: ['shape', 'asset'] }, sideEffects: effects,
            mergeRemoteChanges: callback => callback(), allRecords: () => [...shapes.values(), ...bitmaps.values()],
            listen: listener => { viewportListeners.add(listener); return () => viewportListeners.delete(listener); } },
        getTheme: () => undefined, registerExternalContentHandler() {}, getCurrentPageShapes: () => [...shapes.values()],
        getShape: id => shapes.get(id), isShapeHidden: () => false, getCurrentPageBounds: () => undefined,
        getCurrentPageId: () => 'page:1', getZoomLevel: () => zoom,
        getViewportScreenBounds: () => ({ width: 1000, height: 800 }), getBaseZoom: () => 1,
        getCameraOptions: () => ({ zoomSteps: [0.1, 1, 8] }), setCamera() {},
        getViewportPageBounds: () => ({ ...viewport, minX: viewport.x, minY: viewport.y,
            maxX: viewport.x + viewport.w, maxY: viewport.y + viewport.h,
            center: { x: viewport.x + viewport.w / 2, y: viewport.y + viewport.h / 2 } }),
        getAsset: id => bitmaps.get(id), createAssets: assets => assets.forEach(asset => bitmaps.set(asset.id, asset)),
        updateAssets: assets => assets.forEach(asset => bitmaps.set(asset.id, asset)),
        getShapePageBounds: shape => ({ x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h }),
        getShapePageTransform: shape => ({ applyToPoint: () => ({ x: shape.x, y: shape.y }) }),
        getPointInParentSpace: (_shape, point) => ({ x: point.x, y: point.y }),
        run: callback => callback(),
        updateShapes: updates => updates.forEach(update => shapes.set(update.id, { ...shapes.get(update.id), ...update })),
        deleteShapes: ids => ids.forEach(id => shapes.delete(id)), deleteAssets: ids => ids.forEach(id => bitmaps.delete(id)),
        getSelectedShapeIds: () => [], zoomIn: () => { zoom = 1.5; }, zoomOut: () => { zoom = 1; },
    };
    const dispose = attachProjectEditor(editor, 'board');
    const update = (patch = {}) => {
        state.sync = { ...state.sync, ...patch };
        for (const listener of state.syncListeners) listener();
    };
    const settle = async () => { for (let i = 0; i < 512; i++) await Promise.resolve(); };
    const flushFrame = async () => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach(callback => callback(0));
        await settle();
    };
    const requests = () => state.messages.filter(message => message.type === 'paws-project-canvas/request-assets');
    const arrive = ids => update({ assets: state.sync.assets.map(asset => ids.includes(asset.id)
        ? { ...asset, uri: `blob:https://paws.test/${asset.id}`, sourceQuality: 'preview' } : asset) });
    return { state, editor, shapes, bitmaps, dispose, update, flushFrame, settle, requests, arrive, frames,
        async start() { await settle(); await flushFrame(); await flushFrame(); },
        viewport(next) {
            viewport = next;
            for (const listener of viewportListeners) listener({ changes: { updated: { camera: [
                { typeName: 'camera', x: 0, y: 0, z: zoom }, { typeName: 'camera', x: next.x, y: next.y, z: zoom },
            ] } } });
        },
        command(action) { for (const listener of state.commands) listener({ sessionKey: 'board', action }); },
    };
}

test('all 126 visible previews advance without panning and outstanding requests stay bounded', async () => {
    const f = fixture();
    try {
        await f.start();
        assert.equal(f.requests().length, 1);
        assert.equal(f.requests()[0].ids.length, 16);
        f.update();
        await f.flushFrame();
        assert.equal(f.requests().length, 1, 'unrelated sync must not expand pending work');
        const delivered = new Set();
        for (let batch = 0; batch < 8; batch++) {
            const request = f.requests()[batch];
            assert.ok(request, `batch ${batch + 1} must be triggered by the previous arrivals`);
            assert.equal(request.quality, 'preview');
            assert.ok(request.ids.length <= 16);
            for (const id of request.ids) {
                assert.ok(!delivered.has(id), 'a preview is requested at most once');
                delivered.add(id);
            }
            f.arrive(request.ids);
            await f.flushFrame();
        }
        assert.equal(delivered.size, 126);
        await f.flushFrame();
        assert.equal(f.requests().length, 8);
        assert.equal(f.frames.size, 0, 'the completed board must have no continuing scheduler');
    } finally { f.dispose(); }
});

test('preview arrivals and failures advance without waiting for another paint frame', async () => {
    const f = fixture(64);
    try {
        await f.start();
        assert.equal(f.requests().length, 1);
        const first = f.requests()[0].ids;
        assert.equal(first.length, 16);
        // Freeze all later paint callbacks. Business dispatch must continue
        // from the URI/failure events, even when the browser delays painting.
        f.arrive(first);
        f.update();
        f.update();
        await f.settle();
        assert.equal(f.requests().length, 2, 'arrivals must dispatch the next bounded batch through a microtask');
        const second = f.requests()[1].ids;
        assert.equal(second.length, 16);
        assert.ok(second.every(id => !first.includes(id)));
        assert.deepEqual(second, Array.from({ length: 16 }, (_, index) => f.state.sync.assets[47 - index].id),
            'the nearest remaining placeholders come before the farther left-hand assets');
        const failures = second.map(id => ({ id, versionId: 'a'.repeat(64) }));
        f.update({ previewRequestFailures: failures });
        await f.settle();
        assert.equal(f.requests().length, 3, 'terminal failures must also release capacity without paint');
        const third = f.requests()[2].ids;
        assert.equal(third.length, 16);
        f.arrive(third);
        await f.settle();
        assert.equal(f.requests().length, 4);
        assert.equal(new Set(f.requests().flatMap(request => request.ids)).size, 64);
        f.arrive(f.requests()[3].ids);
        f.update();
        await f.settle();
        assert.equal(f.requests().length, 4, 'failed versions stay terminal and incidental syncs do not retry');
    } finally { f.dispose(); }
});

test('a queued preview dispatch cannot run after disposal or a session change', async () => {
    for (const stop of ['dispose', 'session']) {
        const f = fixture(32);
        try {
            await f.start();
            f.arrive(f.requests()[0].ids);
            if (stop === 'dispose') f.dispose();
            else f.update({ sessionKey: 'other-board' });
            await f.settle();
            assert.equal(f.requests().length, 1);
        } finally { f.dispose(); }
    }
});

test('each actual arrival frees one pending slot and prioritizes the current viewport', async () => {
    const f = fixture();
    try {
        await f.start();
        const first = f.requests()[0].ids;
        f.viewport({ x: -400, y: 0, w: 1000, h: 800 });
        await f.flushFrame();
        assert.equal(f.requests().length, 1, 'a pan alone does not exceed the in-flight bound');
        f.arrive([first[0]]);
        await f.flushFrame();
        assert.deepEqual(f.requests()[1].ids, [f.state.sync.assets[0].id], 'new capacity uses the updated nearest unloaded preview');
        f.update();
        await f.flushFrame();
        assert.equal(f.requests().length, 2);
    } finally { f.dispose(); }
});

test('terminal failures release slots, skip failed versions and never retry automatically', async () => {
    const f = fixture(35);
    try {
        await f.start();
        const failures = [];
        for (let batch = 0; batch < 3; batch++) {
            const request = f.requests()[batch];
            assert.ok(request, 'a failed batch must allow the next visible previews to proceed');
            failures.push(...request.ids.map(id => ({ id, versionId: 'a'.repeat(64) })));
            f.update({ previewRequestFailures: [...failures] });
            await f.flushFrame();
        }
        assert.equal(new Set(f.requests().flatMap(request => request.ids)).size, 35);
        f.update();
        await f.flushFrame();
        assert.equal(f.requests().length, 3);
        assert.equal(f.frames.size, 0);
        f.update({ previewRequestFailures: [] });
        await f.flushFrame();
        assert.equal(f.requests().length, 4, 'an explicit parent retry can clear terminal failure state');
    } finally { f.dispose(); }
});

test('filter changes stop hidden work and stale failures cannot block a new asset version', async () => {
    const f = fixture(40);
    try {
        await f.start();
        const initial = f.requests()[0].ids;
        const target = f.state.sync.assets[0];
        f.update({ visibleAssetIds: [target.id] });
        f.arrive(initial);
        await f.flushFrame();
        await f.flushFrame();
        assert.deepEqual(f.requests().at(-1).ids, [target.id]);
        f.update({ previewRequestFailures: [{ id: target.id, versionId: target.versionId }],
            assets: f.state.sync.assets.map(asset => asset.id === target.id ? { ...asset, versionId: 'b'.repeat(64) } : asset) });
        await f.flushFrame();
        assert.deepEqual(f.requests().at(-1).ids, [target.id]);
        assert.equal(f.requests().length, 3, 'the new version is not suppressed by an old failure');
    } finally { f.dispose(); }
});

test('queued arrivals cannot request or mutate the editor after session change or disposal', async () => {
    for (const stop of ['session', 'dispose']) {
        const f = fixture();
        let complete;
        f.state.readBlob = () => new Promise(resolve => { complete = resolve; });
        try {
            await f.start();
            f.arrive(f.requests()[0].ids);
            await f.settle();
            const requestsBeforeStop = f.requests().length;
            if (stop === 'session') f.update({ sessionKey: 'other-board' });
            else f.dispose();
            complete(new Blob(['preview'], { type: 'image/png' }));
            await f.settle();
            await f.flushFrame();
            assert.equal(f.requests().length, requestsBeforeStop, 'stopping the editor must prevent further dispatch');
            assert.equal(f.state.landings.length, 0, 'obsolete image work cannot land in the previous editor');
        } finally { f.dispose(); }
    }
});

test('progressive previews never upgrade every image to original bytes', async () => {
    const f = fixture(30);
    try {
        f.arrive(f.state.sync.assets.map(asset => asset.id));
        await f.start();
        assert.equal(f.requests().length, 0);
        f.command('zoom-in');
        assert.equal(f.requests().length, 1);
        assert.equal(f.requests()[0].quality, 'original');
        assert.equal(f.requests()[0].ids.length, 4);
        f.update();
        await f.flushFrame();
        assert.equal(f.requests().length, 1, 'background preview progression cannot expand the original window');
    } finally { f.dispose(); }
});

test('a failing local bitmap is attempted once per URI while other arrivals continue', async () => {
    const f = fixture(20);
    const warn = console.warn;
    let reads = 0;
    console.warn = () => {};
    f.state.readBlob = async () => { reads++; throw new Error('invalid image'); };
    try {
        await f.start();
        f.arrive([f.requests()[0].ids[0]]);
        await f.settle();
        const failedReads = reads;
        for (let event = 0; event < 4; event++) { f.update(); await f.settle(); }
        assert.equal(reads, failedReads, 'unrelated syncs cannot retry identical failing bytes');
        assert.equal(failedReads, 1);
        const id = f.requests()[0].ids[0];
        f.update({ assets: f.state.sync.assets.map(asset => asset.id === id ? { ...asset, uri: 'blob:https://paws.test/replaced' } : asset) });
        await f.settle();
        assert.equal(reads, 2, 'replacement bytes can be decoded once');
    } finally { console.warn = warn; f.dispose(); }
});

test('preview hydration only updates the bitmap and retains crop, rotation, grouping and shape metadata', async () => {
    const f = fixture(1);
    const asset = f.state.sync.assets[0];
    const key = `${asset.id}-${asset.versionId}`;
    const imageId = `asset:ig-${key}`;
    const shape = { id: `shape:ig-${key}`, typeName: 'shape', type: 'image', x: 0, y: 0, rotation: 0.5,
        parentId: 'shape:edited-group', opacity: 0.6, isLocked: true,
        meta: { galleryId: key, customNote: 'keep', pawsPlacementX: 0, pawsPlacementY: 0 },
        props: { assetId: imageId, w: 110, h: 220,
            crop: { topLeft: { x: 0.1, y: 0 }, bottomRight: { x: 1, y: 0.9 } } } };
    f.shapes.set(shape.id, structuredClone(shape));
    f.bitmaps.set(imageId, { id: imageId, type: 'image', typeName: 'asset', meta: { customNote: 'keep' },
        props: { src: 'data:image/png;base64,OLD', name: 'Edited name' } });
    try {
        f.arrive([asset.id]);
        await f.settle();
        assert.deepEqual(f.shapes.get(shape.id), shape);
        assert.equal(f.bitmaps.get(imageId).props.src, 'data:image/png;base64,AAAA');
        assert.equal(f.bitmaps.get(imageId).props.name, 'Edited name');
        assert.equal(f.bitmaps.get(imageId).meta.customNote, 'keep');
        assert.equal(f.state.landings.length, 0, 'an existing editable shape must not be landed again');
    } finally { f.dispose(); }
});

test('omitting an unchanged scene keeps its revision for later authoritative placements', async () => {
    const f = fixture(1);
    const asset = f.state.sync.assets[0];
    const key = `${asset.id}-${asset.versionId}`;
    const id = `shape:ig-${key}`;
    f.shapes.set(id, { id, typeName: 'shape', type: 'image', x: 0, y: 0,
        meta: { galleryId: key }, props: { w: 100, h: 100 } });
    try {
        f.update({ scene: { revision: 1, document: '{}' } });
        await f.settle();
        f.update({ scene: undefined, assets: [{ ...asset, x: 40, y: 20 }] });
        await f.settle();
        assert.equal(f.shapes.get(id).x, 40);
        assert.equal(f.shapes.get(id).y, 20);
    } finally { f.dispose(); }
});
