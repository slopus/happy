import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { AppConnectionsMenu } from './AppConnectionsMenu';
import type { AppAuthorizationGrant } from '@/sync/apiAppDelegation';

vi.mock('react-native', () => ({ Modal: 'Modal', View: 'View', Text: 'Text', Pressable: 'Pressable', ScrollView: 'ScrollView', Platform: { OS: 'android' }, useWindowDimensions: () => ({ width: 393, height: 852 }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24 }) }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { hairlineWidth: 1, create: () => ({}) }, useUnistyles: () => ({ theme: { colors: {} } }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Icon' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string, args?: { date: string }) => args ? `${key}: ${args.date}` : key }));
vi.mock('./Item', () => ({ Item: (props: any) => React.createElement('Item', props) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => 'http://127.0.0.1' }));

let renderer: any;
const grant = (id: string, state = 'redeemed'): AppAuthorizationGrant => ({ id, appId: 'relationship-advisor', machineId: 'device', state, expiresAt: null, createdAt: '2026-10-03T12:00:00Z' });
const byId = (id: string) => renderer.root.findByProps({ testID: id });
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = null; delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

it('discloses actions for one chosen connection and binds mutations to that grant', () => {
    const change = vi.fn();
    const grants = [grant('one'), grant('two', 'revoked')];
    act(() => { renderer = TestRenderer.create(<AppConnectionsMenu app={{ name: 'Advisor', origin: null }} anchor={{ x: 0, y: 0 }} grants={grants}
        deviceName={() => 'Mac mini'} busy={false} onClose={vi.fn()} onOpenApp={vi.fn()} onChangeGrant={change} />); });
    expect(renderer.root.findAllByType('Item').filter((node: any) => node.props.destructive)).toHaveLength(0);
    expect(byId('app-connection-toggle-one').props.subtitle).toBe('appConversations.permanent');
    act(() => byId('app-connection-toggle-one').props.onPress());
    expect(change).not.toHaveBeenCalled();
    act(() => byId('app-connection-revoke-one').props.onPress());
    expect(change).toHaveBeenLastCalledWith(grants[0], false);
    act(() => byId('app-connection-toggle-two').props.onPress());
    expect(renderer.root.findAllByProps({ testID: 'app-connection-revoke-one' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'app-connection-revoke-two' })).toHaveLength(0);
    act(() => byId('app-connection-remove-two').props.onPress());
    expect(change).toHaveBeenLastCalledWith(grants[1], true);
});

it('labels finite expiry and disables destructive actions while a mutation is pending', () => {
    const active = { ...grant('finite'), expiresAt: '2099-10-04T12:00:00Z' };
    act(() => { renderer = TestRenderer.create(<AppConnectionsMenu app={{ name: 'Advisor', origin: null }} anchor={{ x: 0, y: 0 }} grants={[active]}
        deviceName={() => 'Mac mini'} busy onClose={vi.fn()} onOpenApp={vi.fn()} onChangeGrant={vi.fn()} />); });
    expect(byId('app-connection-toggle-finite').props.subtitle).toMatch(/^appAuthorization.expiresAt:/);
    act(() => byId('app-connection-toggle-finite').props.onPress());
    expect(byId('app-connection-revoke-finite').props.disabled).toBe(true);
    expect(byId('app-connection-remove-finite').props.disabled).toBe(true);
});
