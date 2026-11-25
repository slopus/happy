import * as React from 'react';
import { act } from 'react';
// @ts-expect-error renderer declarations are not installed
import TestRenderer from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { THINKING_ENABLED_KEY, useThinkingPreferences } from './preferences.web';
import { prepareThinkingMessage } from '@/sync/thinkingModeMessage.web';

const mocks = vi.hoisted(() => ({ account: 'account-a' }));
vi.mock('@/auth/accountRuntime', () => ({ accountStorageId: (key: string) => `${key}:${mocks.account}` }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'zh-Hans' }));
let preferences: ReturnType<typeof useThinkingPreferences>;
let renderer: TestRenderer.ReactTestRenderer;
const values = new Map<string, string>();
function mount(session = 's1') {
    function Harness() { preferences = useThinkingPreferences(session); return null; }
    act(() => { renderer = TestRenderer.create(<Harness />); });
}
beforeEach(() => {
    values.clear(); mocks.account = 'account-a';
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
});
afterEach(() => { act(() => renderer?.unmount()); vi.unstubAllGlobals(); });
describe('browser-local thinking preferences', () => {
    it('defaults off, persists a conversation selection, and releases its instruction on cancellation or disable', () => {
        mount(); expect(preferences.enabled).toBe(false);
        expect(prepareThinkingMessage('s1', 'Hello')).toBe('Hello');
        act(() => { preferences.setEnabled(true); preferences.setMethod('two-layer'); });
        expect(values.get(THINKING_ENABLED_KEY)).toBe('true');
        expect(prepareThinkingMessage('s1', 'Explain')).toContain('双层');
        expect(prepareThinkingMessage('s2', 'Other session')).toBe('Other session');
        act(() => preferences.setEnabled(false));
        expect(prepareThinkingMessage('s1', 'Normal')).toContain('not selected for this turn');
        act(() => preferences.setEnabled(true));
        expect(preferences.method).toBe('two-layer');
        act(() => preferences.setMethod(null));
        expect(prepareThinkingMessage('s1', '/compact')).toBe('/compact');
        expect(prepareThinkingMessage('s1', 'Normal')).not.toContain('Original method template:');
        act(() => renderer.unmount()); mount();
        expect(preferences.enabled).toBe(true); expect(preferences.method).toBeNull();
    });
    it('isolates methods by account and treats invalid storage as no selection', () => {
        mount(); act(() => { preferences.setEnabled(true); preferences.setMethod('life-design'); });
        mocks.account = 'account-b'; expect(prepareThinkingMessage('s1', 'Hello')).toBe('Hello');
        mocks.account = 'account-a';
        values.set('paws.thinking-mode.session.v1:account-a:s1', 'bad');
        expect(prepareThinkingMessage('s1', 'Hello')).not.toContain('Original method template:');
    });
    it('does not claim a failed Local Storage write was saved', () => {
        mount(); localStorage.setItem = () => { throw new Error('Quota exceeded'); };
        act(() => { expect(preferences.setEnabled(true)).toBe(false); expect(preferences.setMethod('socratic')).toBe(false); });
        expect(preferences.enabled).toBe(false); expect(preferences.method).toBeNull();
    });
});
