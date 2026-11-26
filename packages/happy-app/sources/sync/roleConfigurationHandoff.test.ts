import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ records: new Map<string, string>(), id: 0, current: true, server: 'http://test', flush: async () => {} }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++mock.id}` }));
vi.mock('@/auth/accountRuntime', () => ({ accountStorageId: (name: string) => name, accountRuntimeCurrent: () => mock.current }));
vi.mock('./serverConfig', () => ({ getServerUrl: () => mock.server }));
vi.mock('@/text', () => ({ t: (key: string, args?: object) => key + (args ? JSON.stringify(args) : '') }));
vi.mock('@/persistence/deviceStorage', () => ({
    MMKV: class { getString(key: string) { return mock.records.get(key); } getAllKeys() { return [...mock.records.keys()]; } set(key: string, value: string) { mock.records.set(key, value); } },
    writeDeviceStorage: async (disk: { set(key: string, value: string): void }, key: string, value: string) => { disk.set(key, value); await mock.flush(); },
    flushDeviceStorageWrites: async () => { await mock.flush(); },
}));
import { setFirstSubmissionScope, getFirstSubmissionScope } from './firstSubmissionScope';
import { createRoleConfiguration, readRoleConfiguration, buildRoleConfigurationContext, bindRoleConfigurationSession, findRoleConfigurationSession, updateRoleConfiguration, roleConfigurationCurrent, prepareRoleConfigurationSessionMessage, recordRoleConfigurationSavedResult, getRoleConfigurationSavedHandoff, subscribeRoleConfigurationSavedResults } from './roleConfigurationHandoff';
import type { NewSessionDraft } from './persistence';
const launch: NewSessionDraft = { input: 'original launch draft', selectedMachineId: 'source-machine', selectedPath: '/original', agentType: 'codex', permissionMode: 'yolo',
    modelMode: 'gpt-6-astra', effortLevel: 'ultra', modelSelection: {agent:'codex',defaultValue:'gpt-6.1-sol'}, fastMode: true, sessionType: 'simple', worktreeKey: null, updatedAt: 1 };
const request = { machineId: 'target-machine', clientRoleId: 'writer-reserved', draft: { name:'Writer',description:'Write grounded README files',agent:'antigravity' as const,model:'neon',effort:'high',autoDelegate:false } };
beforeEach(() => { mock.records.clear(); mock.id = 0; mock.current = true; mock.server = 'http://test'; mock.flush = async () => {}; setFirstSubmissionScope('owner-A',mock.server); });
describe('role configuration handoff', () => {
    it('reserves a create ID without turning it into update or borrowing the role model', async () => {
        const record = await createRoleConfiguration(request,launch);
        expect(record).toMatchObject({roleId:'writer-reserved',action:'create',machineId:'target-machine'});
        expect(record.config).toMatchObject({agentType:'codex',modelMode:'gpt-6-astra',effortLevel:'ultra',selectedMachineId:'target-machine',selectedPath:null});
        expect(launch).toMatchObject({selectedMachineId:'source-machine',input:'original launch draft',selectedPath:'/original'});
        expect(buildRoleConfigurationContext(record)).toContain('action=create');
        expect(buildRoleConfigurationContext(record)).toContain('id:"writer-reserved"');
        expect(record.input).not.toContain('agent_roles');
    });
    it('reopening an unsent matching handoff keeps the user-edited prompt', async () => {
        const first = await createRoleConfiguration(request,launch);
        updateRoleConfiguration(first.id,{input:'My unfinished role request'});
        const again = await createRoleConfiguration(request,launch);
        expect(again.id).toBe(first.id); expect(again.input).toBe('My unfinished role request'); expect(mock.records.size).toBe(1);
    });
    it('binds only the matching machine and session, with an idempotent durable retry', async () => {
        const record = await createRoleConfiguration(request,launch);
        await expect(bindRoleConfigurationSession(record.id,'another-machine','session-1')).rejects.toThrow();
        await bindRoleConfigurationSession(record.id,request.machineId,'session-1');
        await bindRoleConfigurationSession(record.id,request.machineId,'session-1');
        await expect(bindRoleConfigurationSession(record.id,request.machineId,'session-2')).rejects.toThrow();
        expect(findRoleConfigurationSession(request.machineId,'writer-reserved')?.sessionId).toBe('session-1');
        expect(findRoleConfigurationSession('another-machine','writer-reserved')).toBeNull();
    });
    it('manual create with the reserved ID later reuses the existing AI session as update', async () => {
        const record = await createRoleConfiguration(request,launch);
        await bindRoleConfigurationSession(record.id,request.machineId,'created-session');
        const {clientRoleId:_reserved,...savedRequest} = request;
        const reopened = await createRoleConfiguration({...savedRequest,roleId:'writer-reserved',draft:{...request.draft,description:'Manually saved latest requirements'}},launch);
        expect(reopened).toMatchObject({id:record.id,sessionId:'created-session',roleId:'writer-reserved',action:'update'});
        expect(reopened.draft.description).toBe('Manually saved latest requirements');
        expect(buildRoleConfigurationContext(reopened)).toContain('action=update'); expect(mock.records.size).toBe(1);
    });
    it('does not let a retained old composer overwrite a newer role handoff', async () => {
        const record=await createRoleConfiguration(request,launch);await bindRoleConfigurationSession(record.id,request.machineId,'session-1');
        const next=await createRoleConfiguration({machineId:request.machineId,roleId:request.clientRoleId,draft:{...request.draft,description:'Newest manual draft'}},launch);
        expect(next.revision).toBeGreaterThan(record.revision);
        updateRoleConfiguration(record.id,{input:'Late callback from the original composer'},record.revision);
        expect(readRoleConfiguration(record.id)?.input).toBe(next.input);
    });
    it('rejects a foreign account and an account freeze even with the same key', async () => {
        const record = await createRoleConfiguration(request,launch);
        setFirstSubmissionScope('owner-B',mock.server); expect(readRoleConfiguration(record.id)).toBeNull();
        setFirstSubmissionScope('owner-A',mock.server); expect(readRoleConfiguration(record.id)?.id).toBe(record.id);
        mock.current = false; expect(readRoleConfiguration(record.id)).toBeNull();
        await expect(createRoleConfiguration(request,launch)).rejects.toThrow();
    });
    it('does not complete an old navigation transaction after A → B → A', async () => {
        const owner = getFirstSubmissionScope();
        mock.flush = async () => { setFirstSubmissionScope('owner-B',mock.server); setFirstSubmissionScope('owner-A',mock.server); };
        await expect(createRoleConfiguration(request,launch)).rejects.toThrow();
        expect(getFirstSubmissionScope()).not.toBe(owner);
        // The same account may reopen saved material in a fresh transaction.
        mock.flush = async () => {};
        const restored = readRoleConfiguration('rc-uuid-1'); expect(restored?.roleId).toBe('writer-reserved');
        expect(roleConfigurationCurrent(restored!,owner)).toBe(false);
    });
    it('does not complete association when the runtime freezes while saving', async () => {
        const record = await createRoleConfiguration(request,launch);
        mock.flush = async () => { mock.current = false; };
        await expect(bindRoleConfigurationSession(record.id,request.machineId,'session-1')).rejects.toThrow();
    });
});

describe('role flow return and revision receipts',()=>{
    it('updates an unsent return origin without replacing user input or selected model',async()=>{
        const first=await createRoleConfiguration({...request,roleId:'existing-role',returnContext:{view:'detail',step:1,query:''}},launch);
        updateRoleConfiguration(first.id,{input:'My unfinished question',config:{...first.config,modelMode:'chosen-model'}});
        const next=await createRoleConfiguration({...request,roleId:'existing-role',returnContext:{view:'edit',step:1,query:'Writer',baseline:'baseline',desktopModal:true,scrollY:80,advanced:true}},launch);
        expect(next.id).toBe(first.id);expect(next.revision).toBeGreaterThan(first.revision);
        expect(next.requestedAt).toBeGreaterThan(first.requestedAt!);
        expect(next).toMatchObject({input:'My unfinished question',config:{modelMode:'chosen-model'},returnContext:{view:'edit',query:'Writer',scrollY:80,advanced:true}});
    });
    it('consumes only the context revision accepted by a durable queue',async()=>{
        const first=await createRoleConfiguration(request,launch);await bindRoleConfigurationSession(first.id,request.machineId,'s');
        const current=await createRoleConfiguration({...request,roleId:request.clientRoleId},launch);
        const prepared=prepareRoleConfigurationSessionMessage(request.machineId,'s','Please change the title')!;
        expect(prepared.text).toContain('action=update');expect(prepared.displayText).toBe('Please change the title');
        const next=await createRoleConfiguration({...request,roleId:request.clientRoleId,draft:{...request.draft,description:'Later requirements'}},launch);
        prepared.commit();expect(readRoleConfiguration(first.id)).toMatchObject({revision:next.revision,contextPending:true});
        const latest=prepareRoleConfigurationSessionMessage(request.machineId,'s','Use the latest')!;latest.commit();
        expect(readRoleConfiguration(first.id)?.contextPending).toBe(false);expect(current.revision).toBeLessThan(next.revision);
    });
    it('rejects historical saved cards, wrong ownership and an older role version for a fresh revision',async()=>{
        const first=await createRoleConfiguration(request,launch);await bindRoleConfigurationSession(first.id,request.machineId,'s');
        const current=await createRoleConfiguration({...request,roleId:request.clientRoleId,returnContext:{view:'edit',step:1,query:'',roleUpdatedAt:20}},launch);
        const role={...request.draft,id:request.clientRoleId,name:'AI saved',createdAt:10,updatedAt:30};
        const valid={machineId:request.machineId,sessionId:'s',role,toolCreatedAt:current.requestedAt!+1};
        expect(recordRoleConfigurationSavedResult({...valid,toolCreatedAt:current.requestedAt!-1})).toBe(false);
        expect(recordRoleConfigurationSavedResult({...valid,sessionId:'foreign'})).toBe(false);
        expect(recordRoleConfigurationSavedResult({...valid,machineId:'foreign'})).toBe(false);
        expect(recordRoleConfigurationSavedResult({...valid,role:{...role,updatedAt:20}})).toBe(false);
        expect(recordRoleConfigurationSavedResult(valid)).toBe(true);
        expect(getRoleConfigurationSavedHandoff(request.machineId,role.id)).toMatchObject({sourceDraft:request.draft,savedRole:role,revision:current.revision});
        const reopened=await createRoleConfiguration({...request,roleId:request.clientRoleId,returnContext:{view:'edit',step:1,query:'',roleUpdatedAt:30}},launch);
        expect(getRoleConfigurationSavedHandoff(request.machineId,role.id)).toBeNull();
        expect(recordRoleConfigurationSavedResult({...valid,toolCreatedAt:current.requestedAt!})).toBe(false);
        expect(reopened.revision).toBeGreaterThan(current.revision);
    });
    it('does not consume a pending handoff after account A → B → A',async()=>{
        const first=await createRoleConfiguration(request,launch);await bindRoleConfigurationSession(first.id,request.machineId,'s');
        await createRoleConfiguration({...request,roleId:request.clientRoleId},launch);
        const prepared=prepareRoleConfigurationSessionMessage(request.machineId,'s','Change')!;
        setFirstSubmissionScope('B',mock.server);setFirstSubmissionScope('owner-A',mock.server);
        expect(prepared.isCurrent()).toBe(false);prepared.commit();
        expect(readRoleConfiguration(first.id)?.contextPending).toBe(true);
    });
    it('announces only trusted fresh successful saves once, never local draft changes or historical cards',async()=>{
        const received=vi.fn();const unsubscribe=subscribeRoleConfigurationSavedResults(received);
        try {
            const first=await createRoleConfiguration(request,launch);await bindRoleConfigurationSession(first.id,request.machineId,'s');
            const current=await createRoleConfiguration({...request,roleId:request.clientRoleId},launch);
            updateRoleConfiguration(first.id,{input:'My latest question'});
            expect(received).not.toHaveBeenCalled();
            const saved={machineId:request.machineId,sessionId:'s',role:{...request.draft,id:request.clientRoleId,createdAt:1,updatedAt:2},toolCreatedAt:current.requestedAt!};
            expect(recordRoleConfigurationSavedResult({...saved,toolCreatedAt:current.requestedAt!-1})).toBe(false);
            expect(received).not.toHaveBeenCalled();
            expect(recordRoleConfigurationSavedResult(saved)).toBe(true);
            expect(received).toHaveBeenCalledExactlyOnceWith({machineId:request.machineId,roleId:request.clientRoleId});
            expect(recordRoleConfigurationSavedResult(saved)).toBe(false);
            expect(received).toHaveBeenCalledOnce();
        } finally { unsubscribe(); }
    });
});
