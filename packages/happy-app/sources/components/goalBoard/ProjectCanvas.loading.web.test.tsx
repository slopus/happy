import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations.
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectCanvasSync } from '../../../../paws-dsh-canvas/src/protocol';
import { ProjectCanvas } from './ProjectCanvas.web';

const fixture = vi.hoisted(() => ({
    machine: { active: true, metadata: { projectCanvas: { version: 1, daemonStartedAt: 1729, previewReceipts: true } }, daemonState: {} as Record<string, unknown> },
    get: vi.fn(), readPreview: vi.fn(), readAsset: vi.fn(), putPreview: vi.fn(),
    post: vi.fn(),
    clientCapabilities: [] as Array<{ previewReceipts?: boolean }>,
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'canvas-test' }));
vi.mock('react-native', () => ({ Text: 'Text' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { dark: false, colors: {
    text: '#111', textLink: '#00f', textSecondary: '#333', textDestructive: '#f00', divider: '#ddd',
    surface: '#fff', surfaceSelected: '#eee', groupped: { background: '#fff' },
} } }) }));
vi.mock('@/auth/accountRuntime', () => ({ getActiveAccountKey: () => 'account' }));
vi.mock('@/sync/storage', () => ({ useMachine: () => fixture.machine }));
vi.mock('@/components/PanelTabs', () => ({ PanelTabs: 'PanelTabs' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), header: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key, getCurrentLanguage: () => 'en' }));
vi.mock('./GoalBoardButton', () => ({ GoalBoardButton: 'Button' }));
vi.mock('./ProjectCanvasTools.web', () => ({ ProjectCanvasTools: 'Tools' }));
vi.mock('./ProjectCanvasGeneratedPicker.web', () => ({ ProjectCanvasGeneratedPicker: 'GeneratedPicker' }));
vi.mock('./projectCanvasClient.web', () => ({
    projectCanvasClient: (_machine: string, _path: string, capabilities: { previewReceipts?: boolean }) => {
        fixture.clientCapabilities.push(capabilities);
        return { get: fixture.get, readPreview: fixture.readPreview, readAsset: fixture.readAsset, putPreview: fixture.putPreview };
    },
    projectCanvasImageTypes: ['image/png'],
}));

const firstAsset = { id: `asset-${'a'.repeat(64)}`, versionId: 'a'.repeat(64), name: 'image.png', mimeType: 'image/png', size: 4, x: 1, y: 2,
    preview: { size: 4, versionId: 'b'.repeat(64) } };
const secondAsset = { ...firstAsset, id: `asset-${'c'.repeat(64)}`, versionId: 'c'.repeat(64) };
const initial = { id: `canvas-${'d'.repeat(64)}`, revision: 4, assets: [firstAsset, secondAsset], scene: { revision: 2, document: '{"store":{}}' } };
const sessionKey = JSON.stringify(['account', 'machine', initial.id]);
const frameWindow = { postMessage: fixture.post };
const listeners = new Set<(event: unknown) => void>();
let renderer: ReturnType<typeof TestRenderer.create> | undefined;
const props = { machineId: 'machine', projectPath: '/project', files: null, showFile: false, fileMaximized: false, onSelectSurface: () => {} };
const render = () => <ProjectCanvas {...props} />;
const messages = () => fixture.post.mock.calls.map(([message]) => message as ProjectCanvasSync).filter(message => message.type === 'paws-project-canvas/sync');
const lastSync = () => messages().at(-1)!;

async function mount() {
    await act(async () => {
        renderer = TestRenderer.create(render(), { createNodeMock: ({ type }: { type: string }) => type === 'iframe' ? { contentWindow: frameWindow } : null });
    });
    await send({ type: 'paws-project-canvas/ready' });
}
async function send(data: object) {
    await act(async () => { for (const listener of listeners) listener({ origin: 'http://localhost', source: frameWindow, data }); });
}
async function machineChange(daemonState: Record<string, unknown>) {
    fixture.machine.daemonState = { status: 'running', startedAt: 1729, ...daemonState };
    await act(async () => { renderer.update(render()); });
}
function previewNotice(revision = 5, baseRevision = 4) {
    return { kind: 'preview', canvasId: initial.id, baseRevision, revision,
        asset: { ...firstAsset, preview: { size: 4, versionId: 'e'.repeat(64) } } };
}

beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    fixture.machine.daemonState = { status: 'running', startedAt: 1729 };
    fixture.clientCapabilities = [];
    fixture.get.mockReset().mockResolvedValue(initial);
    fixture.readPreview.mockReset().mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
    fixture.readAsset.mockReset().mockRejectedValue(new Error('unavailable'));
    fixture.putPreview.mockReset();
    fixture.post.mockReset();
    vi.stubGlobal('document', { querySelector: () => undefined });
    vi.stubGlobal('window', { location: { hostname: 'localhost', origin: 'http://localhost' }, setTimeout, clearTimeout,
        addEventListener: (_name: string, fn: (event: unknown) => void) => listeners.add(fn),
        removeEventListener: (_name: string, fn: (event: unknown) => void) => listeners.delete(fn) });
});
afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    listeners.clear();
    vi.unstubAllGlobals();
});

describe('project canvas image lifecycle', () => {
    it('does not lose a notice arriving before the initial manifest finishes loading', async () => {
        let complete!: (value: unknown) => void;
        fixture.get.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
        await mount();
        await machineChange({ goalProjectRevision: 'content-1', goalProjectCanvasChange: { token: 'content-1',
            change: { kind: 'content', canvasId: initial.id, baseRevision: 4, revision: 5 } } });
        fixture.get.mockResolvedValueOnce({ ...initial, revision: 5 });
        await act(async () => { complete(initial); });
        expect(fixture.get).toHaveBeenCalledTimes(2);
        expect(lastSync().manifestRevision).toBe(5);
    });
    it('uses preview receipts only for the matching active daemon capability', async () => {
        await mount();
        expect(fixture.clientCapabilities.at(-1)).toEqual({ previewReceipts: true });
        await machineChange({ startedAt: 1730 });
        expect(fixture.clientCapabilities.at(-1)).toEqual({ previewReceipts: false });
    });
    it('applies contiguous preview notices without rereading the full scene', async () => {
        await mount();
        await machineChange({ goalProjectCanvasChange: { token: 'preview-1', change: previewNotice() } });
        expect(lastSync().manifestRevision).toBe(5);
        expect(messages()[0].scene).toEqual(initial.scene);
        expect(lastSync().scene).toBeUndefined();
        expect(fixture.get).toHaveBeenCalledTimes(1);
    });

    it('coalesces a revision-gap notice and its legacy token into one full refresh', async () => {
        await mount();
        let complete!: (value: unknown) => void;
        fixture.get.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
        await machineChange({ goalProjectRevision: 'content-1', goalProjectCanvasChange: { token: 'content-1', change: previewNotice(7, 6) } });
        expect(fixture.get).toHaveBeenCalledTimes(2);
        await machineChange({ goalProjectRevision: 'content-1', goalProjectCanvasChange: { token: 'preview-2', change: previewNotice(8, 7) } });
        expect(fixture.get).toHaveBeenCalledTimes(2);
        await act(async () => { complete({ ...initial, revision: 8 }); });
        expect(lastSync().manifestRevision).toBe(8);
    });

    it('refreshes once more for a newer event arriving after an in-flight snapshot was captured', async () => {
        await mount();
        let complete!: (value: unknown) => void;
        fixture.get.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
        fixture.get.mockResolvedValueOnce({ ...initial, revision: 8, scene: { revision: 3, document: '{"store":{"new":true}}' } });
        await machineChange({ goalProjectCanvasChange: { token: 'preview-1', change: previewNotice(7, 6) } });
        await machineChange({ goalProjectCanvasChange: { token: 'preview-2', change: previewNotice(8, 7) } });
        expect(fixture.get).toHaveBeenCalledTimes(2);
        await act(async () => { complete({ ...initial, revision: 7 }); });
        expect(fixture.get).toHaveBeenCalledTimes(3);
        expect(lastSync().manifestRevision).toBe(8);
        expect(lastSync().scene?.revision).toBe(3);
    });

    it('preserves an unversioned invalidation arriving during a scoped snapshot read', async () => {
        await mount();
        let complete!: (value: unknown) => void;
        fixture.get.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
        fixture.get.mockResolvedValueOnce({ ...initial, revision: 8 });
        await machineChange({ goalProjectCanvasChange: { token: 'preview-1', change: previewNotice(7, 6) } });
        await machineChange({ goalProjectRevision: 'generic-1' });
        await act(async () => { complete({ ...initial, revision: 7 }); });
        expect(fixture.get).toHaveBeenCalledTimes(3);
        expect(lastSync().manifestRevision).toBe(8);
    });

    it('uses a successful event-triggered refresh when the first request fails', async () => {
        let reject!: (reason: unknown) => void;
        fixture.get.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
        await mount();
        fixture.get.mockResolvedValueOnce({ ...initial, revision: 5 });
        await machineChange({ goalProjectRevision: 'generic-1' });
        await act(async () => { reject(new Error('first snapshot failed')); });
        expect(lastSync().manifestRevision).toBe(5);
        expect(renderer.root.findAllByType('Button').some((button: { props: { label: string } }) => button.props.label === 'projectCanvas.retry')).toBe(false);
    });

    it('ignores paired invalidations for another canvas', async () => {
        await mount();
        await machineChange({ goalProjectRevision: 'other-1', goalProjectCanvasChange: { token: 'other-1',
            change: { kind: 'content', canvasId: `canvas-${'e'.repeat(64)}`, baseRevision: 4, revision: 5 } } });
        expect(fixture.get).toHaveBeenCalledTimes(1);
    });

    it('does not display a late preview for a replaced preview version', async () => {
        await mount();
        let complete!: (value: Blob) => void;
        let completeNew!: (value: Blob) => void;
        fixture.readPreview.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
        fixture.readPreview.mockReturnValueOnce(new Promise(resolve => { completeNew = resolve; }));
        await send({ type: 'paws-project-canvas/request-assets', sessionKey, ids: [firstAsset.id], quality: 'preview' });
        await machineChange({ goalProjectCanvasChange: { token: 'preview-1', change: previewNotice() } });
        await act(async () => { complete(new Blob(['old!'])); });
        expect(lastSync().assets[0].uri).toBeUndefined();
        expect(fixture.readPreview).toHaveBeenCalledTimes(2);
        await act(async () => { completeNew(new Blob(['new!'])); });
        expect(lastSync().assets[0].uri).toMatch(/^blob:/);
    });

    it('releases the blob URL when an asset leaves the manifest', async () => {
        await mount();
        await send({ type: 'paws-project-canvas/request-assets', sessionKey, ids: [firstAsset.id], quality: 'preview' });
        const uri = lastSync().assets[0].uri;
        const revoke = vi.spyOn(URL, 'revokeObjectURL');
        fixture.get.mockResolvedValueOnce({ ...initial, revision: 5, assets: [secondAsset] });
        await machineChange({ goalProjectCanvasChange: { token: 'content-1', change: {
            kind: 'content', canvasId: initial.id, baseRevision: 4, revision: 5,
        } } });
        expect(revoke).toHaveBeenCalledWith(uri);
        revoke.mockRestore();
    });

    it('reports every terminal preview failure even when the status was already an error', async () => {
        await mount();
        fixture.readPreview.mockRejectedValue(new Error('unavailable'));
        await send({ type: 'paws-project-canvas/request-assets', sessionKey, ids: [firstAsset.id], quality: 'preview' });
        expect(lastSync().previewRequestFailures).toEqual([{ id: firstAsset.id, versionId: firstAsset.versionId }]);
        await send({ type: 'paws-project-canvas/request-assets', sessionKey, ids: [secondAsset.id], quality: 'preview' });
        expect(lastSync().previewRequestFailures).toEqual([
            { id: firstAsset.id, versionId: firstAsset.versionId }, { id: secondAsset.id, versionId: secondAsset.versionId },
        ]);
    });

    it('preserves cumulative failures across incidental syncs and clears a changed preview version', async () => {
        await mount();
        fixture.readPreview.mockRejectedValue(new Error('unavailable'));
        await send({ type: 'paws-project-canvas/request-assets', sessionKey, ids: [firstAsset.id], quality: 'preview' });
        await machineChange({ goalProjectCanvasChange: { token: 'preview-1', change: { ...previewNotice(), asset: secondAsset } } });
        expect(lastSync().previewRequestFailures).toEqual([{ id: firstAsset.id, versionId: firstAsset.versionId }]);
        await machineChange({ goalProjectCanvasChange: { token: 'preview-2', change: { ...previewNotice(6, 5) } } });
        expect(lastSync().previewRequestFailures).toEqual([]);
    });

    it('does not create a blob URL for a preview finishing after unmount', async () => {
        await mount();
        let complete!: (value: Blob) => void;
        fixture.readPreview.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
        await send({ type: 'paws-project-canvas/request-assets', sessionKey, ids: [firstAsset.id], quality: 'preview' });
        const createUri = vi.spyOn(URL, 'createObjectURL');
        await act(async () => { renderer.unmount(); renderer = undefined; });
        await act(async () => { complete(new Blob(['jpeg'])); });
        expect(createUri).not.toHaveBeenCalled();
        createUri.mockRestore();
    });
});
