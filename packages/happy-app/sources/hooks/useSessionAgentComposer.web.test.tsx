import React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error renderer declarations are not installed
import TestRenderer from 'react-test-renderer';
import { useSessionAgentComposer } from './useSessionAgentComposer.web';
vi.mock('./useMagpieModelCatalog', () => ({ useMagpieModelCatalog: () => ({ catalog: mocks.magpieCatalog, refresh: vi.fn() }) }));
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), retry: vi.fn(), sending: false, hydrationError: null as any, flush: vi.fn(), update: vi.fn(),
    images: [] as any[], sessions: [] as any[], magpieCatalog: null as any, alert: vi.fn(),
    settings: { codingAgentMachines: { m: ['codex', 'claude', 'opencode'] }, agentDefaultOverrides: {} } as any,
    machine: { id: 'm', active: true, activeAt: Date.now(), metadata: { homeDir: '/tmp', cliAvailability: { codex: true, claude: true, opencode: true } } },
}));
vi.mock('@/sync/storage', () => ({ useMachine: () => mocks.machine, useAllSessions: () => mocks.sessions, useSetting: (k: string) => mocks.settings[k] }));
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
beforeEach(() => { renderer?.unmount(); vi.clearAllMocks(); mocks.sending=false;mocks.hydrationError=null;mocks.images=[];mocks.sessions=[];mocks.magpieCatalog=null;mocks.settings.agentDefaultOverrides={};mocks.spawn.mockResolvedValue(true); });
describe('Web composer Agent staging', () => {
 it('switches directly without spawning or changing source settings and restores current selection', () => {
  mount();
  expect(value.pendingAgent).toBeNull();
  act(() => value.modeSelector.agentSwitcher.onSelect('opencode'));
  expect(value.pendingAgent).toBe('opencode');
  act(() => value.modeSelector.agentSwitcher.onSelect('claude'));
  expect(value.modeSelector.modelOptions[0].key).toBe('sonnet-native');
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
  act(() => value.modeSelector.agentSwitcher.onSelect('codex'));
  expect(value.pendingAgent).toBeNull();
  expect(value.modeSelector.model).toEqual(base.model);
 });
 it('spawns the selected Agent with native model and preserves the source draft', async () => {
  mount();
  act(() => value.modeSelector.agentSwitcher.onSelect('claude'));
  await act(async () => { await value.submit(); });
  expect(mocks.spawn).toHaveBeenCalledWith(expect.objectContaining({ machineId:'m',path:'/tmp/project',agent:'claude',prompt:'keep this draft',modelMode:'sonnet-native' }),false,expect.any(Function));
  expect(mocks.flush).toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
 });
 it('shows gateway and account routes together and stages a new Magpie session from managed Codex', async () => {
  mocks.magpieCatalog = { modelsUpdatedAt: 1, models: [
   { code: 'openrouter/google/gemini-4-argon', value: 'Gemini 4 Argon', supportedEffortLevels: ['high'] },
   { code: 'gpt-live', value: 'GPT Live', supportedEffortLevels: ['medium'] },
  ] };
  const source = { ...session, metadata: { ...session.metadata, codexAccountProfileId: 'bound' } };
  mount(source);
  expect(value.modeSelector.modelOptions.map(({ key }: any) => key)).toEqual([
   'gpt-live', 'magpie::openrouter/google/gemini-4-argon', 'magpie::gpt-live',
  ]);
  act(() => value.modeSelector.onModelChange('magpie::openrouter/google/gemini-4-argon'));
  expect(value.pendingAgent).toBe('codex');
  expect(value.modeSelector.model.name).toBe('Gemini 4 Argon');
  expect(mocks.update).not.toHaveBeenCalled();
  await act(async () => value.submit());
  expect(mocks.spawn).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex',
   modelMode: 'openrouter/google/gemini-4-argon', magpieModel: 'openrouter/google/gemini-4-argon',
   expectedCodexAccountProfileId: null,
  }), false, expect.any(Function));
 });
 it('preserves explicit Codex model and Ultra picks when staging a new session from Claude', async () => {
  mocks.settings.codingAgentMachines = { m: ['codex', 'claude', 'opencode'] };
  mocks.sessions = [{ id: 'codex-catalog', activeAt: 1, metadata: { machineId: 'm', flavor: 'codex',
   currentModelCode: 'gpt-6.1-sol', models: [{ code: 'gpt-6.1-sol', value: 'Sol' }, { code: 'gpt-6-astra', value: 'Astra' }],
   thoughtLevels: ['medium', 'high', 'ultra'].map(code => ({ code, value: code })) } }];
  const source = { ...session, metadata: { ...session.metadata, flavor: 'claude' } };
  mount(source);
  act(() => value.modeSelector.agentSwitcher.onSelect('codex'));
  expect(value.pendingAgent).toBe('codex');
  expect(value.modeSelector.model.key).toBe('gpt-6.1-sol');
  act(() => value.modeSelector.onModelChange('gpt-6-astra'));
  act(() => value.modeSelector.onEffortChange('ultra'));
  expect(value.modeSelector.model.key).toBe('gpt-6-astra');
  expect(value.modeSelector.effort.key).toBe('ultra');
  await act(async () => value.submit());
  expect(mocks.spawn).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', modelMode: 'gpt-6-astra', effortLevel: 'ultra' }), false, expect.any(Function));
 });
 it('keeps a staged Codex model selected and blocks submission until it is available again', async () => {
  const source = { ...session, metadata: { ...session.metadata, flavor: 'claude' } };
  const catalog = { id: 'codex-catalog', activeAt: 1, metadata: { machineId: 'm', flavor: 'codex',
   models: [{ code: 'gpt-6.1-sol', value: 'Sol' }, { code: 'gpt-6-astra', value: 'Astra' }] } };
  mocks.sessions = [catalog];
  mount(source);
  act(() => value.modeSelector.agentSwitcher.onSelect('codex'));
  act(() => value.modeSelector.onModelChange('gpt-6-astra'));
  mocks.sessions = [{ ...catalog, metadata: { ...catalog.metadata, models: [catalog.metadata.models[0]] } }];
  act(() => renderer.update(<Harness source={source} />));
  expect(value.modeSelector.model.key).toBe('gpt-6-astra');
  expect(value.disabled).toBe(true);
  await expect(value.submit()).resolves.toBe(false);
  expect(mocks.spawn).not.toHaveBeenCalled();
  mocks.sessions = [catalog];
  act(() => renderer.update(<Harness source={source} />));
  expect(value.disabled).toBe(false);
  await act(async () => value.submit());
  expect(mocks.spawn).toHaveBeenCalledWith(expect.objectContaining({ modelMode: 'gpt-6-astra' }), false, expect.any(Function));
 });
 it('keeps staged Codex CLI reset visible and explicit when its concrete catalog arrives', async () => {
  const source = { ...session, metadata: { ...session.metadata, flavor: 'claude' } };
  mount(source);
  act(() => value.modeSelector.agentSwitcher.onSelect('codex'));
  act(() => value.modeSelector.onModelChange('default'));
  act(() => value.modeSelector.onEffortChange('default'));
  mocks.sessions = [{ id: 'codex-catalog', activeAt: 1, metadata: { machineId: 'm', flavor: 'codex',
   currentModelCode: 'gpt-6.1-sol', models: [{ code: 'gpt-6.1-sol', value: 'Sol' }],
   thoughtLevels: ['medium', 'ultra'].map(code => ({ code, value: code })) } }];
  await act(async () => renderer.update(<Harness source={source} />));
  expect(value.modeSelector.model).toEqual({ key: 'default', name: 'agentInput.model.cliAutomatic' });
  expect(value.modeSelector.effort.key).toBe('default');
  await act(async () => value.submit());
  expect(mocks.spawn).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', modelMode: 'default', effortLevel: 'default' }), false, expect.any(Function));
 });
 it('follows changed Codex defaults without resurrecting obsolete staged choices when defaults change back', async () => {
  mocks.sessions = [{ id: 'codex-catalog', activeAt: 1, metadata: { machineId: 'm', flavor: 'codex',
   currentModelCode: 'gpt-6.1-sol', models: [{ code: 'gpt-6.1-sol', value: 'Sol' }, { code: 'gpt-6-astra', value: 'Astra' }],
   thoughtLevels: ['low', 'medium', 'high', 'ultra'].map(code => ({ code, value: code })) } }];
  const source = { ...session, metadata: { ...session.metadata, flavor: 'claude' } };
  mount(source);
  act(() => value.modeSelector.agentSwitcher.onSelect('codex'));
  expect(value.modeSelector.model.key).toBe('gpt-6.1-sol');
  act(() => value.modeSelector.onModelChange('gpt-6-astra'));
  act(() => value.modeSelector.onEffortChange('low'));
  mocks.settings.agentDefaultOverrides = { codex: { modelMode: 'gpt-6-astra', effortLevel: 'ultra' } };
  await act(async () => renderer.update(<Harness source={source} />));
  expect(value.modeSelector.model.key).toBe('gpt-6-astra');
  expect(value.modeSelector.effort.key).toBe('ultra');
  mocks.settings.agentDefaultOverrides = {};
  await act(async () => renderer.update(<Harness source={source} />));
  expect(value.modeSelector.model.key).toBe('gpt-6.1-sol');
  expect(value.modeSelector.effort.key).toBe('medium');
  await act(async () => value.submit());
  expect(mocks.spawn).toHaveBeenCalledWith(expect.objectContaining({ agent: 'codex', modelMode: 'gpt-6.1-sol', effortLevel: 'medium' }), false, expect.any(Function));
 });
 it('freezes the target during an in-flight spawn and retries hydration instead of spawning twice', async () => { mount();act(() => value.modeSelector.agentSwitcher.onSelect('claude'));mocks.sending=true;act(() => renderer.update(<Harness source={session}/>));act(() => value.modeSelector.agentSwitcher.onSelect('opencode'));expect(value.pendingAgent).toBe('claude');mocks.sending=false;mocks.hydrationError={sessionId:'new'};act(() => renderer.update(<Harness source={session}/>));await act(async () => value.submit());expect(mocks.retry).toHaveBeenCalledOnce();expect(mocks.spawn).not.toHaveBeenCalled(); });
 it('does not leak a staged Agent into another source session', () => { mount();act(() => value.modeSelector.agentSwitcher.onSelect('claude'));act(() => renderer.update(<Harness source={{...session,id:'s2',metadata:{...session.metadata,flavor:'claude'}}}/>));expect(value.pendingAgent).toBeNull(); });
 it('stages target permissions instead of writing source settings', async () => { mount();act(() => value.modeSelector.agentSwitcher.onSelect('claude'));await act(async () => value.permissionSelector.onLevelChange('confirm'));expect(mocks.update).not.toHaveBeenCalled();await act(async () => value.submit());expect(mocks.spawn).toHaveBeenCalledWith(expect.objectContaining({permissionMode:'default'}),false,expect.any(Function)); });
 it('rejects unsupported target attachments before creating a session and lets the user recover', async () => { mount();act(() => value.modeSelector.agentSwitcher.onSelect('opencode'));mocks.images=[{id:'pdf',kind:'file',uri:'file.pdf'}];await act(async () => value.submit());expect(mocks.spawn).not.toHaveBeenCalled();expect(mocks.alert).toHaveBeenCalledOnce();mocks.images=[];await act(async () => value.submit());expect(mocks.spawn).toHaveBeenCalledOnce(); });

 it('keeps the current brand as the sole option when only one Agent is enabled', () => { const previous=mocks.settings.codingAgentMachines;mocks.settings.codingAgentMachines={m:['codex']};try {mount();expect(value.modeSelector.agentSwitcher.id).toBe('codex');expect(value.modeSelector.agentSwitcher.options.map((agent: any) => agent.key)).toEqual(['codex']);} finally {mocks.settings.codingAgentMachines=previous;} });

});
