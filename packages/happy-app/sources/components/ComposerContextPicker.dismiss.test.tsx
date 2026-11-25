// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error RN Web runtime is installed without a declarations package.
vi.mock('react-native', async () => import('react-native-web'));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('./codingAgents/CodingAgentIcon', () => ({ CodingAgentIcon: () => null }));
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await import('@/themePacks'); const theme = appThemes.ginghamDark;
    return { useUnistyles: () => ({ theme }), StyleSheet: { hairlineWidth: 1, create: (factory: any) => factory(theme) } };
});
vi.mock('@/sync/storage', () => ({ useSocketStatus: () => ({ status: 'connected' }), storage: (select: any) => select({ sessions: {}, sessionMessages: {} }) }));
vi.mock('@/hooks/usePlugins', () => ({ usePlugins: () => ({ plugins: [], loading: false, status: 'ready' }) }));
vi.mock('@/utils/sessionUtils', () => ({ getSessionName: () => '' }));
vi.mock('./plugins/pluginText', () => ({ resolvePluginText: () => '' }));
vi.mock('@/sync/suggestionFile', () => ({ searchFiles: async () => [] }));
vi.mock('./autocomplete/contextItems', () => ({ contextPlugins: () => [], contextSessions: () => [], contextSites: () => [], filterContextItems: (items: any) => items }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
import { ComposerContextPicker } from './ComposerContextPicker';
let root: Root, host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
it('keeps its own portalled picker/composer inside and closes across stopped propagation or another composer', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    const owner = document.createElement('div'); owner.dataset.testid = 'message-composer-content'; document.body.append(owner);
    const other = document.createElement('button'); other.dataset.testid = 'message-composer-content'; document.body.append(other);
    other.addEventListener('pointerdown', event => event.stopPropagation());
    const onClose = vi.fn();
    act(() => root.render(<ComposerContextPicker query="" ownerRef={{ current: owner as any }} onClose={onClose} onSelect={vi.fn()} onPickFiles={vi.fn()} />));
    const down = (node: Element) => act(() => { node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
    down(document.querySelector('[data-testid="composer-context-picker"]')!); down(owner);
    expect(onClose).not.toHaveBeenCalled();
    down(other); expect(onClose).toHaveBeenCalledWith(false);
    act(() => root.unmount()); root = undefined as any;
    down(other); expect(onClose).toHaveBeenCalledOnce();
    owner.remove(); other.remove();
});
it('closes with Escape from its Add trigger or menu without consuming another overlay key', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    const owner = document.createElement('div'), trigger = document.createElement('button'), outside = document.createElement('button');
    owner.append(trigger); document.body.append(owner, outside);
    const onClose = vi.fn();
    act(() => root.render(<ComposerContextPicker query="" ownerRef={{ current: owner as any }} onClose={onClose} onSelect={vi.fn()} onPickFiles={vi.fn()} />));
    const escape = (node: Element) => act(() => { node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    escape(outside); expect(onClose).not.toHaveBeenCalled();
    escape(trigger); expect(onClose).toHaveBeenCalledOnce();
    escape(document.querySelector('[data-testid="composer-context-picker"]')!); expect(onClose).toHaveBeenCalledTimes(2);
    act(() => root.unmount()); root = undefined as any;
    escape(trigger); expect(onClose).toHaveBeenCalledTimes(2);
    owner.remove(); outside.remove();
});
