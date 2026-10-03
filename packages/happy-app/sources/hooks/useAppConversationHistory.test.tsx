import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
const mocks = vi.hoisted(() => ({ token: 'owner-a', server: 'https://paws.test', request: vi.fn(), decryptRaw: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'native' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } }));
vi.mock('expo-router', () => ({ useFocusEffect: (callback: () => (() => void) | undefined) => React.useEffect(callback, [callback]) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ credentials: { token: mocks.token } }) }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => mocks.server }));
vi.mock('@/sync/apiAppDelegation', () => ({ appAuthorizationRequest: mocks.request }));
vi.mock('@/sync/sync', () => ({ sync: { encryption: { getMachineEncryption: () => ({ decryptRaw: mocks.decryptRaw }) } } }));
vi.mock('@/sync/appConversationHistory', () => ({ parseAppConversationHistory: (data: unknown) => data, decryptAppConversationHistory: (data: unknown) => data }));
import { useAppConversationHistory } from './useAppConversationHistory';
let latest: ReturnType<typeof useAppConversationHistory>;
let renderer: any;
function Probe({ id }: { id: string }) { latest = useAppConversationHistory(id); return null; }
const data = (id: string) => ({ conversationId: id, machineId: 'machine', machineEnvelope: 'sealed', messages: [{ role: 'user', text: id }] });
beforeEach(() => { mocks.token = 'owner-a'; mocks.server = 'https://paws.test'; mocks.request.mockReset(); mocks.decryptRaw.mockReset().mockResolvedValue({}); });
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = null; });
it('aborts a previous selection and rejects its late result after another conversation is visible', async () => {
    let resolveA!: (value: unknown) => void;
    mocks.request.mockReturnValueOnce(new Promise(resolve => { resolveA = resolve; })).mockResolvedValueOnce(data('b'));
    await act(async () => { renderer = TestRenderer.create(<Probe id="a" />); });
    const signal = mocks.request.mock.calls[0][4] as AbortSignal;
    await act(async () => { renderer.update(<Probe id="b" />); });
    expect(signal.aborted).toBe(true);
    expect(latest.content?.conversationId).toBe('b');
    await act(async () => { resolveA(data('a')); });
    expect(latest.content?.conversationId).toBe('b');
});
it('hides the old owner content immediately while the new account waits for its response', async () => {
    mocks.request.mockResolvedValueOnce(data('private-a')).mockReturnValueOnce(new Promise(() => {}));
    await act(async () => { renderer = TestRenderer.create(<Probe id="a" />); });
    expect(latest.content?.conversationId).toBe('private-a');
    mocks.token = 'owner-b';
    await act(async () => { renderer.update(<Probe id="a" />); });
    expect(latest.content).toBeNull(); expect(latest.loading).toBe(true);
});
it('clears displayed content when a refreshed history has been deleted', async () => {
    mocks.request.mockResolvedValueOnce(data('a')).mockRejectedValueOnce({ status: 403 });
    await act(async () => { renderer = TestRenderer.create(<Probe id="a" />); });
    await act(async () => { latest.refresh(); });
    expect(latest.content).toBeNull(); expect(latest.error).toBe('removed');
});
it('does not publish decrypted content after the server changes during decryption', async () => {
    let decrypt!: (value: unknown) => void;
    mocks.request.mockResolvedValue(data('a'));
    mocks.decryptRaw.mockReturnValueOnce(new Promise(resolve => { decrypt = resolve; }));
    await act(async () => { renderer = TestRenderer.create(<Probe id="a" />); });
    mocks.server = 'https://other.test';
    await act(async () => { decrypt({}); });
    expect(latest.content).toBeNull();
});
