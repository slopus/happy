import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, vi } from 'vitest';
// @ts-expect-error The workspace renderer has no declarations.
import TestRenderer from 'react-test-renderer';
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Text: 'Text', View: 'View', TextInput: 'TextInput', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/components/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/components/RoundButton', () => ({ RoundButton: 'Button' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (factory: any) => factory({ colors: {} }) }, useUnistyles: () => ({ theme: { colors: {} } }) }));
let renderer: any;
let warning: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    warning = vi.spyOn(console, 'error').mockImplementation((...args) => { if (!String(args[0]).includes('react-test-renderer is deprecated')) throw new Error(args.join(' ')); });
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = null; warning.mockRestore(); });
export async function render(element: React.ReactNode) { await act(async () => { renderer = TestRenderer.create(element); }); return renderer; }
export async function press(r: any, title: string) { await act(async () => { const node = r.root.findAllByType('Button').find((n: any) => n.props.title === title); if (!node || node.props.disabled) throw new Error(`Unavailable button: ${title}`); await node.props.onPress(); }); }
export const snapshot = { service: { id: 's1', name: '私人助理', ownerId: 'owner', enabled: true, revision: 3 }, revision: { serviceId: 's1', revision: 3, createdAt: 1, config: { machineId: 'm1', engine: 'codex', accountRef: { kind: 'codex-profile', id: 'a1' }, modelId: null, reasoning: { mode: 'default' } } } } as const;
export const catalog = { ...snapshot.revision.config, protocol: 'ai-services/1', observedAt: 1, availability: 'online', completeness: 'complete', defaultModelId: 'model1', models: [{ id: 'model1', name: 'Model One', supportsImages: true, reasoning: { supportsDefault: true, values: ['high'], defaultValue: 'high' } }] } as const;
export const worker = { machineId: 'm1', serviceProtocol: 'ai-services/1', servicePublicKey: 'key', serviceClaudeIdentity: 'claude:observed', serviceClaudeObservedAt: new Date().toISOString() } as const;
export const account = { id: 'a1', displayName: 'Work', status: 'available', quota: { state: 'unknown', remainingPercent: null } };
