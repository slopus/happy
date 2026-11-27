import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Use the real SDK records/store and the production editor + scene persistence
// hooks. The adapter replaces DOM/view methods only; all record effects and
// outbound scene documents come from the actual implementation.
process.env.NODE_ENV = 'test';
const sdk = await import('tldraw');
const hostKey = '__pawsCanvasUserMetadataTest';
globalThis[hostKey] = { sdk };
const doubles = {
    tldraw: `const sdk = globalThis.${hostKey}.sdk;
        export const atom = sdk.atom; export const createShapeId = sdk.createShapeId; export const loadSnapshot = sdk.loadSnapshot;`,
    bridge: `const host = () => globalThis.${hostKey};
        export const currentSync = () => host().sync;
        export const postCanvasMessage = message => host().messages.push(message);
        export const subscribeSync = listener => { host().syncListeners.add(listener); return () => host().syncListeners.delete(listener); };
        export const subscribeCommand = listener => { host().commands.add(listener); return () => host().commands.delete(listener); };
        export const subscribeSceneResult = () => () => {};`,
    imageCache: `export const fetchDisplayBlob = () => { throw new Error('No image reads expected'); };
        export const setAssetUri = () => {}; export const removeAssetUri = () => {};`,
    'browser-image-utils': `export const blobToDataUrl = () => { throw new Error('No bitmap conversions expected'); };`,
    'studio-tl-canvas': `export const landTlItems = () => { throw new Error('No image landings expected'); };`,
};
const bundled = await build({
    stdin: { contents: `export { attachProjectEditor } from './editor'; export { writeSceneDocument } from './sceneDocument';`,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'controlled-view-boundaries', setup(builder) {
        builder.onResolve({ filter: /^(tldraw|.*\/(?:bridge|imageCache|browser-image-utils|studio-tl-canvas))$/ }, args => {
            const name = args.path.split('/').at(-1);
            return name in doubles ? { path: name, namespace: 'test-boundary' } : undefined;
        });
        builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, args => ({ contents: doubles[args.path], loader: 'js' }));
    } }],
});
const { attachProjectEditor, writeSceneDocument } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

function fixture(withAuthor = false) {
    const store = sdk.createTLStore({ shapeUtils: sdk.defaultShapeUtils, bindingUtils: sdk.defaultBindingUtils });
    const author = sdk.UserRecordType.create({ id: sdk.UserRecordType.createId('canvas-author'), name: 'Canvas author' });
    const pageId = sdk.PageRecordType.createId('page');
    const shape = {
        id: sdk.createShapeId('attributed-note'), typeName: 'shape', type: 'note', parentId: pageId,
        x: 10, y: 20, rotation: 0, index: 'a1', isLocked: false, opacity: 1, meta: {},
        props: { ...sdk.NoteShapeUtil.prototype.getDefaultProps(), richText: sdk.toRichText('Attributed note'), textLastEditedBy: 'canvas-author' },
    };
    store.put([sdk.DocumentRecordType.create({ id: sdk.TLDOCUMENT_ID }),
        sdk.PageRecordType.create({ id: pageId, name: 'Page 1', index: 'a1' }), shape, ...(withAuthor ? [author] : [])]);
    const state = { sdk, messages: [], syncListeners: new Set(), commands: new Set(),
        sync: { type: 'paws-project-canvas/sync', sessionKey: 'board', theme: 'light', assets: [],
            scene: { revision: 19, document: writeSceneDocument(store, new Set()) } } };
    globalThis[hostKey] = state;
    globalThis.window = new EventTarget();
    globalThis.window.devicePixelRatio = 1;
    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
    globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const editor = {
        store, getTheme: () => undefined, clearHistory() {}, registerExternalContentHandler() {},
        // Editor.run with history:'ignore' still produces source:'user' record
        // effects. Keep that actual SDK call, with a memory-only transaction.
        run: sdk.Editor.prototype.run,
        history: { batch: callback => store.atomic(callback) },
    };
    const dispose = attachProjectEditor(editor, 'board');
    return { store, author, shape, editor, state, dispose,
        scenePosts: () => state.messages.filter(message => message.type === 'paws-project-canvas/scene'),
        ensureAuthor(user = author) { sdk.Editor.prototype._ensureUserRecord.call(editor, user); },
    };
}

for (const operation of ['create', 'change', 'delete']) {
    test(`SDK user record ${operation} alone never auto-saves the canvas`, t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const f = fixture(operation !== 'create');
        try {
            if (operation === 'delete') f.store.remove([f.author.id]);
            else f.ensureAuthor(operation === 'change' ? { ...f.author, name: 'Updated author' } : f.author);
            t.mock.timers.tick(130);
            assert.equal(f.scenePosts().length, 0, 'SDK attribution metadata is not a canvas edit');
        } finally { f.dispose(); }
    });
}

test('a real shape edit still saves the current user attribution with the scene', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    try {
        f.ensureAuthor({ ...f.author, name: 'Updated author', imageUrl: 'https://example.test/avatar.png' });
        t.mock.timers.tick(130);
        assert.equal(f.scenePosts().length, 0);
        f.store.put([{ ...f.shape, x: 99 }]);
        t.mock.timers.tick(130);
        assert.equal(f.scenePosts().length, 1);
        const saved = f.scenePosts()[0];
        assert.equal(saved.revision, 19);
        const document = JSON.parse(saved.document);
        assert.equal(document.store[f.shape.id].x, 99);
        assert.equal(document.store[f.shape.id].props.textLastEditedBy, 'canvas-author');
        assert.deepEqual(document.store[f.author.id], { ...f.author, name: 'Updated author', imageUrl: '' });
    } finally { f.dispose(); }
});
