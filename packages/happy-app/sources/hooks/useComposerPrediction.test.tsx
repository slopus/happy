// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not ship declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { useComposerPrediction, type ComposerPredictionSource } from './useComposerPrediction';
import type { ComposerPredictionResponse } from '@slopus/happy-wire';

const api = vi.hoisted(() => ({ request: vi.fn(), cancel: vi.fn(), sequence: 0 }));
vi.mock('@/sync/ops', () => ({ sessionComposerPrediction: api.request, sessionCancelComposerPrediction: api.cancel }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `request-${++api.sequence}` }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: {
    currentState: 'active', addEventListener: () => ({ remove() {} }),
} }));

describe('composer prediction lifecycle', () => {
    const renderers: Array<{ unmount(): void }> = [];
    let resolve: (value: ComposerPredictionResponse) => void;
    let current: ReturnType<typeof useComposerPrediction>;
    let draft: string;
    const readDraft = () => draft;
    const source: ComposerPredictionSource = { turnId: 'finished', contextKey: 'model-a', enabled: true };
    function Probe({ sessionId = 'session-a', value = source }: { sessionId?: string; value?: ComposerPredictionSource }) {
        current = useComposerPrediction(sessionId, value, readDraft);
        return null;
    }
    async function mount(strict = false) {
        let renderer: any;
        await act(async () => {
            renderer = TestRenderer.create(strict ? <React.StrictMode><Probe /></React.StrictMode> : <Probe />);
            renderers.push(renderer);
        });
        return renderer;
    }
    beforeEach(() => {
        draft = '';
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        api.request.mockReset().mockImplementation(() => new Promise<ComposerPredictionResponse>(r => { resolve = r; }));
        api.cancel.mockReset().mockResolvedValue(undefined);
    });
    afterEach(() => {
        act(() => renderers.splice(0).forEach(renderer => renderer.unmount()));
        vi.restoreAllMocks();
    });

    it('requests once under StrictMode and keeps the candidate separate from the draft', async () => {
        await mount(true);
        expect(api.request).toHaveBeenCalledTimes(1);
        await act(async () => resolve({ sourceTurnId: 'finished', status: 'ready', text: 'Show the preview.' }));
        expect(current.text).toBe('Show the preview.');
        expect(draft).toBe('');
        act(() => current.invalidate());
        expect(current.text).toBeNull();
        expect(api.request).toHaveBeenCalledTimes(1);
    });

    it('rejects late inference after typing and clearing before the deferred draft render', async () => {
        await mount();
        act(() => { draft = 'my text'; current.invalidate(); draft = ''; });
        await act(async () => resolve({ sourceTurnId: 'finished', status: 'ready', text: 'Stale text' }));
        expect(current.text).toBeNull();
        expect(api.cancel).toHaveBeenCalledTimes(1);
        expect(api.request).toHaveBeenCalledTimes(1);
    });

    it('rejects the old result when the session or model context changes', async () => {
        const renderer = await mount();
        const oldResolve = resolve;
        await act(async () => renderer.update(<Probe value={{ ...source, contextKey: 'model-b' }} />));
        await act(async () => oldResolve({ sourceTurnId: 'finished', status: 'ready', text: 'Old model' }));
        expect(current.text).toBeNull();
        expect(api.request).toHaveBeenCalledTimes(1);
        await act(async () => renderer.update(<Probe sessionId="session-b" value={{ ...source, turnId: 'other' }} />));
        expect(api.request).toHaveBeenCalledTimes(2);
        await act(async () => resolve({ sourceTurnId: 'finished', status: 'ready', text: 'Wrong source' }));
        expect(current.text).toBeNull();
    });

    it('does not request for saved drafts, pending attachments or a background page', async () => {
        draft = 'saved';
        const renderer = await mount();
        expect(api.request).not.toHaveBeenCalled();
        draft = '';
        await act(async () => renderer.update(<Probe value={{ ...source, enabled: false }} />));
        expect(api.request).not.toHaveBeenCalled();
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        act(() => document.dispatchEvent(new Event('visibilitychange')));
        await act(async () => renderer.update(<Probe value={{ ...source, turnId: 'next' }} />));
        expect(api.request).not.toHaveBeenCalled();
    });

    it('cancels when backgrounded and never revives the same suggestion on focus', async () => {
        await mount();
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        act(() => document.dispatchEvent(new Event('visibilitychange')));
        await act(async () => resolve({ sourceTurnId: 'finished', status: 'ready', text: 'Late' }));
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        act(() => window.dispatchEvent(new Event('focus')));
        expect(current.text).toBeNull();
        expect(api.cancel).toHaveBeenCalledTimes(1);
        expect(api.request).toHaveBeenCalledTimes(1);
    });
});
