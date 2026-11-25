import * as React from 'react';
import { act } from 'react';
// @ts-expect-error renderer declarations are not installed
import TestRenderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThinkingReplyActions } from './ThinkingMode.web';
const mocks = vi.hoisted(() => ({ stage: vi.fn(), enabled: true }));
vi.mock('@/thinking/preferences.web', () => ({ useThinkingPreferences: () => ({ enabled: mocks.enabled, method: 'teach-me' }) }));
vi.mock('@/sync/messageStagingQueueRuntime', () => ({ stageSessionMessage: mocks.stage }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {} } }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('@/components/DesktopDialogFrame', () => ({ DesktopDialogFrame: () => null }));
vi.mock('@/components/Item', () => ({ Item: () => null }));
vi.mock('@/components/Switch', () => ({ Switch: () => null }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key, getCurrentLanguage: () => 'en' }));
let renderer: TestRenderer.ReactTestRenderer;
function mount() { act(() => { renderer = TestRenderer.create(<ThinkingReplyActions sessionId="session-a" messageId="old-reply" text="The full OLD answer" />); }); }
function draw() { return renderer.root.findByProps({ 'data-testid': 'thinking-followup-draw' }); }
beforeEach(() => {
    mocks.stage.mockReset(); mocks.enabled = true;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('document', { getElementById: () => ({}) });
});
afterEach(() => { act(() => renderer?.unmount()); vi.unstubAllGlobals(); });
describe('reply-bound actions', () => {
    it('is collapsed by default, directly queues the old reply, and blocks duplicate clicks', async () => {
        let resolve!: () => void;
        mocks.stage.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
        mount(); expect(renderer.root.findAllByProps({ 'data-testid': 'thinking-followup-draw' })).toHaveLength(0);
        act(() => renderer.root.findByProps({ className: 'tm-followup-toggle' }).props.onClick());
        act(() => { draw().props.onClick(); draw().props.onClick(); });
        expect(mocks.stage).toHaveBeenCalledTimes(1);
        expect(draw().props.disabled).toBe(true);
        const [session, prompt, attachments, delivery, context] = mocks.stage.mock.calls[0];
        expect(session).toBe('session-a'); expect(delivery).toBe('queue'); expect(attachments).toBeUndefined();
        expect(prompt).toContain('old-reply'); expect(prompt).toContain('The full OLD answer');
        expect(context).toEqual({ displayText: expect.stringContaining('The full OLD answer') });
        await act(async () => resolve());
        expect(draw().props.disabled).toBe(true);
        expect(JSON.stringify(renderer.toJSON())).toContain('thinkingMode.queued');
    });
    it('restores a failed action for retry and hides the feature when disabled', async () => {
        mocks.stage.mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValueOnce(undefined);
        mount(); act(() => renderer.root.findByProps({ className: 'tm-followup-toggle' }).props.onClick());
        await act(async () => draw().props.onClick());
        expect(draw().props.disabled).toBe(false);
        expect(JSON.stringify(renderer.toJSON())).toContain('thinkingMode.failed');
        await act(async () => draw().props.onClick()); expect(mocks.stage).toHaveBeenCalledTimes(2);
        act(() => { mocks.enabled = false; renderer.update(<ThinkingReplyActions sessionId="session-a" messageId="old-reply" text="The full OLD answer" />); });
        expect(renderer.toJSON()).toBeNull();
    });
});
