import {beforeEach,describe,expect,it,vi} from 'vitest';
const mock=vi.hoisted(()=>({records:new Map<string,string>(),drafts:{} as Record<string,string>,sessions:{} as Record<string,any>,deleted:new Set<string>(),id:0,current:true,
    flush:async()=>{},navigate:vi.fn(),hydrated:vi.fn(),update:vi.fn(),launch:{input:'ordinary unsent text',selectedMachineId:'m',selectedPath:'/work',agentType:'codex',permissionMode:'default',modelMode:'gpt-6-astra',effortLevel:'ultra',sessionType:'simple',worktreeKey:null,updatedAt:1} as any}));
vi.mock('expo-crypto',()=>({randomUUID:()=>`uuid-${++mock.id}`}));
vi.mock('@/auth/accountRuntime',()=>({accountStorageId:(value:string)=>value,accountRuntimeCurrent:()=>mock.current}));
vi.mock('@/sync/serverConfig',()=>({getServerUrl:()=> 'http://test'}));
vi.mock('@/text',()=>({t:(key:string,values?:object)=>key+(values?JSON.stringify(values):'')}));
vi.mock('@/persistence/deviceStorage',()=>({MMKV:class{getString(key:string){return mock.records.get(key);}getAllKeys(){return [...mock.records.keys()];}set(key:string,value:string){mock.records.set(key,value);}},
    writeDeviceStorage:async(disk:any,key:string,value:string)=>{disk.set(key,value);await mock.flush();},flushDeviceStorageWrites:async()=>{await mock.flush();}}));
vi.mock('@/hooks/useNewSessionDraft',()=>({useNewSessionDraft:{getState:()=>mock.launch},newSessionDraftSnapshot:(value:object)=>({...value})}));
vi.mock('@/hooks/useNavigateToSession',()=>({navigateToSession:(...args:any[])=>mock.navigate(...args)}));
vi.mock('@/sync/storage',()=>({storage:{getState:()=>({sessions:mock.sessions,updateSessionDraft:(id:string,value:string)=>{mock.update(id,value);mock.drafts[id]=value;if(mock.sessions[id])mock.sessions[id].draft=value;}})}}));
vi.mock('@/sync/persistence',()=>({loadSessionDrafts:()=>mock.drafts}));
vi.mock('@/sync/projectSessionLinks',()=>({isProjectSessionDeleted:(id:string)=>mock.deleted.has(id)}));
vi.mock('@/sync/sync',()=>({sync:{ensureSessionHydrated:(id:string)=>mock.hydrated(id)}}));
import {setFirstSubmissionScope} from '@/sync/firstSubmissionScope';
import {createRoleConfiguration,bindRoleConfigurationSession,readRoleConfiguration} from '@/sync/roleConfigurationHandoff';
import {openRoleConfiguration,returnToRoleConfigurationSettings} from './roleConfigurationNavigation';
const request={machineId:'m',clientRoleId:'reserved-role',draft:{name:'Writer',description:'README',agent:'antigravity' as const,model:'neon',autoDelegate:false}};
beforeEach(()=>{mock.records.clear();mock.drafts={};mock.sessions={};mock.deleted.clear();mock.id=0;mock.current=true;mock.flush=async()=>{};vi.clearAllMocks();setFirstSubmissionScope('A','http://test');});
async function linked(){const record=await createRoleConfiguration(request,mock.launch);await bindRoleConfigurationSession(record.id,'m','existing-session');mock.sessions['existing-session']={id:'existing-session',metadata:{machineId:'m'},draft:'Unfinished original question'};return record;}
describe('role configuration navigation',()=>{
    it('opens the native new route with only a private reference and leaves the ordinary draft untouched',async()=>{
        const router={navigate:vi.fn()} as any;const before={...mock.launch};
        await openRoleConfiguration(router,request);
        const target=router.navigate.mock.calls[0][0];expect(target).toEqual({pathname:'/new',params:{roleConfiguration:expect.any(String)}});
        expect(JSON.stringify(target)).not.toContain('neon');expect(mock.launch).toEqual(before);
        expect(readRoleConfiguration(target.params.roleConfiguration)).toMatchObject({roleId:'reserved-role',action:'create'});
    });
    it('preserves the retained visible draft and uses unified native session navigation',async()=>{
        const record=await linked();const router={navigate:vi.fn()} as any;let count=0;
        mock.flush=async()=>{if(++count===2)mock.sessions['existing-session'].draft='Latest characters flushed from the live input';};
        await openRoleConfiguration(router,{machineId:'m',roleId:'reserved-role',draft:request.draft});
        expect(mock.update).not.toHaveBeenCalled();
        expect(mock.navigate).toHaveBeenCalledWith(router,'existing-session',{roleConfigurationId:record.id});expect(router.navigate).not.toHaveBeenCalled();
        expect(readRoleConfiguration(record.id)?.action).toBe('update');
    });
    it('reopens repeatedly without appending another configuration template',async()=>{
        await linked();const router={navigate:vi.fn()} as any;
        await openRoleConfiguration(router,{machineId:'m',roleId:'reserved-role',draft:request.draft});
        await openRoleConfiguration(router,{machineId:'m',roleId:'reserved-role',draft:request.draft});
        expect(mock.sessions['existing-session'].draft).toBe('Unfinished original question');
        expect(mock.update).not.toHaveBeenCalled();
    });
    it('returns to the exact source role surface even when the ordinary stack was compacted',async()=>{
        const record=await createRoleConfiguration({...request,returnContext:{view:'create',step:2,query:'writer',desktopModal:true,scrollY:120}},mock.launch);
        const router={navigate:vi.fn(),canGoBack:()=>false} as any;
        await returnToRoleConfigurationSettings(router,record.id);
        expect(router.navigate).toHaveBeenCalledWith({pathname:'/settings/delegation-roles',params:{machineId:'m',roleConfigurationReturn:record.id,desktopModal:'1'}});
    });
    it('rejects an old A → B → A navigation transaction before changing a retained draft',async()=>{
        await linked();const router={navigate:vi.fn()} as any;let count=0;
        mock.flush=async()=>{if(++count===2){setFirstSubmissionScope('B','http://test');setFirstSubmissionScope('A','http://test');}};
        await expect(openRoleConfiguration(router,{machineId:'m',roleId:'reserved-role',draft:request.draft})).rejects.toThrow();
        expect(mock.update).not.toHaveBeenCalled();expect(mock.navigate).not.toHaveBeenCalled();
    });
    it('does not write a request to a session belonging to another machine',async()=>{
        await linked();mock.sessions['existing-session'].metadata.machineId='foreign';const router={navigate:vi.fn()} as any;
        await expect(openRoleConfiguration(router,{machineId:'m',roleId:'reserved-role',draft:request.draft})).rejects.toThrow();
        expect(mock.update).not.toHaveBeenCalled();expect(mock.navigate).not.toHaveBeenCalled();expect(router.navigate).not.toHaveBeenCalled();
    });
    it('hydrates a missing cache row once without treating failure as a deleted session',async()=>{
        const record=await linked();delete mock.sessions['existing-session'];mock.hydrated.mockResolvedValue(false);const router={navigate:vi.fn()} as any;
        await expect(openRoleConfiguration(router,{machineId:'m',roleId:'reserved-role',draft:request.draft})).rejects.toThrow();
        expect(mock.hydrated).toHaveBeenCalledExactlyOnceWith('existing-session');expect(router.navigate).not.toHaveBeenCalled();expect(readRoleConfiguration(record.id)?.sessionId).toBe('existing-session');
    });
    it('can reopen a new native conversation after authoritative deletion without changing role identity',async()=>{
        const record=await linked();mock.deleted.add('existing-session');delete mock.sessions['existing-session'];const router={navigate:vi.fn()} as any;
        await openRoleConfiguration(router,{machineId:'m',roleId:'reserved-role',draft:request.draft});
        expect(router.navigate).toHaveBeenCalledWith({pathname:'/new',params:{roleConfiguration:record.id}});
        expect(readRoleConfiguration(record.id)).toMatchObject({roleId:'reserved-role',action:'update'});expect(readRoleConfiguration(record.id)?.sessionId).toBeUndefined();
        await bindRoleConfigurationSession(record.id,'m','replacement-session');expect(readRoleConfiguration(record.id)?.sessionId).toBe('replacement-session');
    });
});
