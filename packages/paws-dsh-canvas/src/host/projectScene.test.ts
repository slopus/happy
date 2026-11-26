import assert from 'node:assert/strict';
import test from 'node:test';
import {
    AssetRecordType, createShapeId, createTLStore, defaultBindingUtils, defaultShapeUtils, DocumentRecordType,
    ImageShapeUtil, loadSnapshot, PageRecordType, TLDOCUMENT_ID, UserRecordType, type IndexKey, type TLGroupShape, type TLImageShape,
} from 'tldraw';
import {
    PROJECT_CANVAS_SCENE_DOCUMENT_MAX_BYTES, readProjectCanvasCommand, readProjectCanvasFrameMessage,
    readProjectCanvasSceneResult, type ProjectCanvasFrameMessage,
} from '../protocol';
import { readSceneDocument, writeSceneDocument } from './sceneDocument';
import { createSceneSync } from './sceneSync';

const assetKey = `asset-${'a'.repeat(64)}-${'b'.repeat(64)}`;
const assetId = AssetRecordType.createId(`ig-${assetKey}`);
const shapeId = createShapeId(`ig-${assetKey}`);
const pageId = PageRecordType.createId('page');

test('the scene preserves editable geometry and rejects outside resources', () => {
    const store = createTLStore({ shapeUtils: defaultShapeUtils, bindingUtils: defaultBindingUtils });
    const author = UserRecordType.create({ id: UserRecordType.createId('canvas-author'), name: 'Canvas author',
        imageUrl: 'https://example.test/avatar.png' });
    const group: TLGroupShape = {
        id: createShapeId('group'), typeName: 'shape', type: 'group', parentId: pageId,
        x: 47, y: -22, rotation: 0.35, index: 'a2' as IndexKey, isLocked: false, opacity: 1, meta: {}, props: {},
    };
    const shape: TLImageShape = {
        id: shapeId, typeName: 'shape', type: 'image', x: 124, y: 70, rotation: 0.5,
        parentId: group.id, index: 'a2' as IndexKey, isLocked: false, opacity: 0.6,
        meta: { galleryId: assetKey },
        props: { ...ImageShapeUtil.prototype.getDefaultProps(), assetId, w: 110, h: 220,
            crop: { topLeft: { x: 0.1, y: 0 }, bottomRight: { x: 1, y: 0.9 } } },
    };
    store.put([
        DocumentRecordType.create({ id: TLDOCUMENT_ID }),
        PageRecordType.create({ id: pageId, name: 'Page 1', index: 'a1' as IndexKey }),
        author,
        group, shape, {
        id: assetId, typeName: 'asset', type: 'image', meta: { pawsDisplayQuality: 'original' },
        props: { src: 'data:image/png;base64,AAAA', name: 'Jackie', w: 110, h: 220, mimeType: 'image/png', isAnimated: false },
    }]);
    const hiddenAsset = `asset-${'c'.repeat(64)}-${'d'.repeat(64)}`;
    const document = writeSceneDocument(store, new Set([hiddenAsset]));
    assert.ok(document);
    assert.doesNotMatch(document, /base64|pawsDisplayQuality/);
    const restored = readSceneDocument(document, store);
    assert.ok(restored);
    assert.deepEqual(restored.store[shapeId], shape);
    assert.deepEqual(restored.store[author.id], { ...author, imageUrl: '' });
    assert.deepEqual(restored.removed, [hiddenAsset]);
    assert.equal((restored.store[assetId] as { props: { src: unknown } }).props.src, null);
    const fresh = createTLStore({ shapeUtils: defaultShapeUtils, bindingUtils: defaultBindingUtils });
    fresh.mergeRemoteChanges(() => loadSnapshot(fresh, { document: restored }));
    assert.deepEqual(fresh.get(shape.id), shape);
    assert.deepEqual(fresh.get(group.id), group);

    const malicious = JSON.parse(document);
    malicious.store[assetId].props.src = 'https://example.test/track';
    assert.equal(readSceneDocument(JSON.stringify(malicious), store), undefined);
    delete malicious.store[assetId];
    malicious.store[shapeId].parentId = shapeId;
    assert.equal(readSceneDocument(JSON.stringify(malicious), store), undefined);
});

function startSync() {
    const messages: ProjectCanvasFrameMessage[] = [];
    const loaded: string[] = [];
    const failures: string[] = [];
    let draft = 'initial';
    const sync = createSceneSync({ sessionKey: 'project', serialize: () => draft,
        restore: document => { loaded.push(document); draft = document; return true; }, placements: () => [],
        post: message => messages.push(message), failed: reason => failures.push(reason) });
    return { sync, edit(document: string) { draft = document; sync.trackUserEdit(); }, messages, loaded, failures };
}

test('flush waits for scene acknowledgment and a stale sync cannot undo a local edit', () => {
    const { sync, edit, messages, loaded } = startSync();
    try {
        sync.accept({ revision: 1, document: 'initial' });
        edit('first edit');
        sync.flush('export');
        assert.deepEqual(messages.map(message => message.type), ['paws-project-canvas/scene']);
        edit('second edit');
        sync.accept({ revision: 2, document: 'first edit' });
        sync.receive({ type: 'paws-project-canvas/scene-saved', sessionKey: 'project', revision: 2 });
        sync.accept({ revision: 1, document: 'initial' });
        sync.flush('second request');
        assert.deepEqual(loaded, ['initial']);
        const second = messages.at(-1);
        assert.ok(second?.type === 'paws-project-canvas/scene');
        assert.equal(second.revision, 2);
        assert.equal(second.document, 'second edit');
        sync.receive({ type: 'paws-project-canvas/scene-saved', sessionKey: 'project', revision: 3 });
        assert.deepEqual(messages.slice(-2), ['export', 'second request'].map(requestId => ({
            type: 'paws-project-canvas/scene-flushed', sessionKey: 'project', requestId, ok: true,
        })));
    } finally {
        sync.dispose();
    }
});

test('a newer scene leaves a conflicting local edit intact and blocks unchecked writes', () => {
    const { sync, edit, messages, loaded, failures } = startSync();
    try {
        sync.accept({ revision: 1, document: 'initial' });
        sync.trackPointer(true);
        sync.accept({ revision: 2, document: 'other device' });
        edit('retained locally');
        sync.trackPointer(false);
        sync.retry();
        sync.flush('export');
        assert.deepEqual(loaded, ['initial']);
        assert.deepEqual(failures, ['conflict']);
        assert.deepEqual(messages, [{ type: 'paws-project-canvas/scene-flushed', sessionKey: 'project', requestId: 'export', ok: false }]);
    } finally {
        sync.dispose();
    }
});

test('scene protocol checks request identities and the document byte limit', () => {
    const message = { type: 'paws-project-canvas/scene', sessionKey: 'project', revision: 0, placements: [] };
    assert.deepEqual(readProjectCanvasFrameMessage({ ...message, document: '{}' }), { ...message, document: '{}' });
    assert.equal(readProjectCanvasFrameMessage({ ...message, document: '图'.repeat(PROJECT_CANVAS_SCENE_DOCUMENT_MAX_BYTES / 3 + 1) }), undefined);
    assert.equal(readProjectCanvasCommand({ type: 'paws-project-canvas/command', sessionKey: 'project', action: 'flush-scene' }), undefined);
    assert.equal(readProjectCanvasSceneResult({ type: 'paws-project-canvas/scene-saved', sessionKey: 'project', revision: 0 }), undefined);
});
