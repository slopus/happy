import React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error renderer declarations are not installed
import TestRenderer from 'react-test-renderer';
import { useSessionAgentComposer } from './useSessionAgentComposer.web';
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), retry: vi.fn(), sending: false, hydrationError: null as any, flush: vi.fn(), update: vi.fn(),
    images: [] as any[], alert: vi.fn(),
    settings: { codingAgentMachines: { m: ['codex', 'claude', 'opencode'] }, agentDefaultOverrides: {} } as any,
    machine: { id: 'm', active: true, activeAt: Date.now(), metadata: { homeDir: '/tmp', cliAvailability: { codex: true, claude: true, opencode: true } } },
}));
vi.mock('@/sync/storage', () => ({ useMachine: () => mocks.machine, useAllSessions: () => [], useSetting: (k: string) => mocks.settings[k] }));
vi.mock('@/hooks/useCodexAccounts', () => ({ useCodexAccounts: () => ({ loading: false, error: null, bindings: [] }) }));
vi.mock('@/hooks/useClaudeModelCatalog', () => ({ useClaudeModelCatalog: () => ({ catalog: { models: [{ code: 'sonnet-native', value: 'Sonnet Native' }], observedAt: 1 }, refresh: vi.fn() }) }));
vi.mock('@/hooks/useSpawnSession', () => ({ useSpawnSession: () => ({ spawn: mocks.spawn, retryHydration: mocks.retry, sending: mocks.sending, hydrationError: mocks.hydrationError }) }));
vi.mock('@/modal', () => ({ Modal: { alert: mocks.alert, confirm: vi.fn().mockResolvedValue(true) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
const session: any = { id: 's', metadata: { machineId: 'm', path: '/tmp/project', flavor: 'codex' } };
const base: any = { online: true, model: { key: 'gpt-live', name: 'GPT Live' }, modelOptions: [{ key: 'gpt-live', name: 'GPT Live' }], effort: { key: 'high', name: 'High' }, effortOptions: [], onModelChange: mocks.update, onEffortChange: vi.fn() };
let value: any;let renderer: any;
function mount(source = session) { act(() => { renderer = TestRenderer.create(<Harness source={source} />); }); }
function Harness({ source }: any) { value = useSessionAgentComposer({ session: source, base, readSubmission: () => ({ prompt: 'keep this draft', images: mocks.images }), flushDraft: mocks.flush });return null; }
beforeEach(() => { renderer?.unmount(); vi.clearAllMocks(); mocks.sending=false;mocks.hydrationError=null;mocks.images=[];mocks.spawn.mockResolvedValue(true); });
describe('Web composer Agent staging', () => {
 it('cycles brands without spawning or changing source settings and restores current selection', () => { mount();expect(value.pendingAgent).toBeNull();act(() => value.modeSelector.agentSwitcher.onSwitch());expect(value.pendingAgent).toBe('claude');expect(value.modeSelector.modelOptions[0].key).toBe('sonnet-native');expect(mocks.spawn).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled();act(() => value.modeSelector.agentSwitcher.onSwitch());act(() => value.modeSelector.agentSwitcher.onSwitch());expect(value.pendingAgent).toBeNull();expect(value.modeSelector.model).toEqual(base.model); });
 it('spawns the selected Agent with native model and preserves the source draft', async () => { mount();act(() => value.modeSelector.agentSwitcher.onSwitch());await act(async () => { await value.submit(); });expect(mocks.spawn).toHaveBeenCalledWith(expect.objectContaining({ machineId:'m',path:'/tmp/project',agent:'claude',prompt:'keep this draft',modelMode:'sonnet-native' }),false,expect.any(Function));expect(mocks.flush).toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled(); });
 it('freezes the target during an in-flight spawn and retries hydration instead of spawning twice', async () => { mount();act(() => value.modeSelector.agentSwitcher.onSwitch());mocks.sending=true;act(() => renderer.update(<Harness source={session}/>));act(() => value.modeSelector.agentSwitcher.onSwitch());expect(value.pendingAgent).toBe('claude');mocks.sending=false;mocks.hydrationError={sessionId:'new'};act(() => renderer.update(<Harness source={session}/>));await act(async () => value.submit());expect(mocks.retry).toHaveBeenCalledOnce();expect(mocks.spawn).not.toHaveBeenCalled(); });
 it('does not leak a staged Agent into another source session', () => { mount();act(() => value.modeSelector.agentSwitcher.onSwitch());act(() => renderer.update(<Harness source={{...session,id:'s2',metadata:{...session.metadata,flavor:'claude'}}}/>));expect(value.pendingAgent).toBeNull(); });
 it('stages target permissions instead of writing source settings', async () => { mount();act(() => value.modeSelector.agentSwitcher.onSwitch());await act(async () => value.permissionSelector.onLevelChange('confirm'));expect(mocks.update).not.toHaveBeenCalled();await act(async () => value.submit());expect(mocks.spawn).toHaveBeenCalledWith(expect.objectContaining({permissionMode:'default'}),false,expect.any(Function)); });
 it('rejects unsupported target attachments before creating a session and lets the user recover', async () => { mount();act(() => value.modeSelector.agentSwitcher.onSwitch());act(() => value.modeSelector.agentSwitcher.onSwitch());mocks.images=[{id:'pdf',kind:'file',uri:'file.pdf'}];await act(async () => value.submit());expect(mocks.spawn).not.toHaveBeenCalled();expect(mocks.alert).toHaveBeenCalledOnce();mocks.images=[];await act(async () => value.submit());expect(mocks.spawn).toHaveBeenCalledOnce(); });

 it('keeps the current brand with cycling disabled when only one Agent is enabled', () => { const previous=mocks.settings.codingAgentMachines;mocks.settings.codingAgentMachines={m:['codex']};try {mount();expect(value.modeSelector.agentSwitcher.id).toBe('codex');expect(value.modeSelector.agentSwitcher.next).toBeNull();} finally {mocks.settings.codingAgentMachines=previous;} });

});
