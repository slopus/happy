import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    enabled: false, permission: 'default', setEnabled: vi.fn(), request: vi.fn(), preview: vi.fn(),
}));
vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: { accent: 'accent', textSecondary: 'secondary' } } }) }));
vi.mock('./Item', () => ({ Item: (props: any) => React.createElement('Item', props, props.rightElement) }));
vi.mock('./ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('./Switch', () => ({ Switch: 'Switch' }));
vi.mock('@/text', () => ({ getCurrentLanguage: () => 'zh-Hans' }));
vi.mock('@/sync/storage', () => ({ useLocalSettingMutable: () => [mocks.enabled, mocks.setEnabled] }));
vi.mock('@/sync/webCompletionNotifications.web', () => ({
    getBrowserNotificationPermission: () => mocks.permission,
    requestBrowserNotificationPermission: mocks.request,
    previewBrowserNotification: mocks.preview,
}));
import { BrowserNotificationSettings } from './BrowserNotificationSettings.web';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled = false;
    mocks.permission = 'default';
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
async function render() {
    let tree: any;
    await act(async () => { tree = TestRenderer.create(<BrowserNotificationSettings />); });
    return tree;
}
it('asks for permission only when the user switches on, then saves the granted setting', async () => {
    const tree = await render();
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.request.mockResolvedValue('granted');
    await act(async () => { await tree.root.findByType('Switch' as any).props.onValueChange(true); });
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.setEnabled).toHaveBeenCalledWith(true);
    await act(async () => tree.unmount());
});
it('does not enable notifications when permission is denied and explains how to recover', async () => {
    const tree = await render();
    mocks.request.mockResolvedValue('denied');
    await act(async () => { await tree.root.findByType('Switch' as any).props.onValueChange(true); });
    expect(mocks.setEnabled).toHaveBeenCalledWith(false);
    expect(tree.root.findByProps({ testID: 'web-completion-notification-enable' }).props.subtitle).toContain('网站设置');
    expect(tree.root.findByProps({ testID: 'web-completion-notification-test' }).props.disabled).toBe(true);
    await act(async () => tree.unmount());
});
it('can turn off without requesting permission and can test with permission granted', async () => {
    mocks.permission = 'granted';
    mocks.enabled = true;
    mocks.preview.mockReturnValue(true);
    const tree = await render();
    await act(async () => { await tree.root.findByType('Switch' as any).props.onValueChange(false); });
    expect(mocks.setEnabled).toHaveBeenCalledWith(false);
    expect(mocks.request).not.toHaveBeenCalled();
    await act(async () => { tree.root.findByProps({ testID: 'web-completion-notification-test' }).props.onPress(); });
    expect(mocks.preview).toHaveBeenCalledOnce();
    await act(async () => tree.unmount());
});
it('refreshes revoked permissions on focus and cleans up listeners', async () => {
    mocks.permission = 'granted';
    mocks.enabled = true;
    const tree = await render();
    mocks.permission = 'denied';
    const refresh = vi.mocked(window.addEventListener).mock.calls[0][1] as () => void;
    await act(async () => refresh());
    expect(tree.root.findByType('Switch' as any).props.value).toBe(false);
    await act(async () => tree.unmount());
    expect(window.removeEventListener).toHaveBeenCalledWith('focus', refresh);
    expect(document.removeEventListener).toHaveBeenCalledWith('visibilitychange', refresh);
});
