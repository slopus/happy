import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({owner:{key:'a',generation:'1'},metadata:new Map<string,any>(),encryption:{} as any}));
vi.mock('@/auth/accountRuntime',()=>({getRuntimeAccountSelection:()=>mock.owner,assertAccountRuntime:()=>{}}));
vi.mock('@/auth/tokenStorage',()=>({TokenStorage:{getCredentials:vi.fn().mockResolvedValue({token:'token',secret:'secret'})}}));
vi.mock('./sync',()=>({sync:{get encryption(){return mock.encryption;}}}));
vi.mock('./apiSessions',()=>({fetchSessionSnapshotPage:vi.fn()}));
import { fetchSessionSnapshotPage } from './apiSessions';
import { loadProjectConversationCandidates } from './projectConversationCandidates.web';
const raw=(id:string)=>({id,seq:2,metadata:id,metadataVersion:3,dataEncryptionKey:'wrapped',active:true,activeAt:1,createdAt:1,updatedAt:2,agentState:null,agentStateVersion:0});
beforeEach(()=>{vi.clearAllMocks();mock.owner={key:'a',generation:'1'};mock.metadata=new Map([['one',{machineId:'m',path:'/archive',goalBoard:{featurePath:'/p',taskId:'GFT-abcd1234'},summary:{text:'Title'}}],['other',{machineId:'other',path:'/other'}]]);mock.encryption={decryptEncryptionKey:vi.fn().mockResolvedValue(new Uint8Array(32)),prepareSessionEncryption:vi.fn(async(id:string)=>({sessionEncryption:{decryptMetadata:async()=>mock.metadata.get(id)},commit:vi.fn()}))};});
describe('complete Web-owned conversation candidates',()=>{
 it('exhausts cursor pages and decrypts detached metadata without exporting keys or mutating the session cache',async()=>{
  vi.mocked(fetchSessionSnapshotPage).mockResolvedValueOnce({sessions:[raw('one')],hasNext:true,nextCursor:'next'}).mockResolvedValueOnce({sessions:[raw('other')],hasNext:false,nextCursor:null});
  const result=await loadProjectConversationCandidates('m');expect(result.candidates).toEqual([{sessionId:'one',metadataVersion:3,directory:'/archive',title:'Title',featurePath:'/p',taskId:'GFT-abcd1234'}]);expect(fetchSessionSnapshotPage).toHaveBeenCalledTimes(2);
  const expected=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([['one',3],['other',3]])));
  expect(result.catalogFingerprint).toBe([...new Uint8Array(expected)].map(b=>b.toString(16).padStart(2,'0')).join(''));
  expect((await mock.encryption.prepareSessionEncryption.mock.results[0].value).commit).not.toHaveBeenCalled();expect(JSON.stringify(result)).not.toMatch(/token|secret|wrapped|encryptionKey/);
 });
 it('rejects incomplete or stalled pagination instead of claiming a complete total',async()=>{
  vi.mocked(fetchSessionSnapshotPage).mockResolvedValue({sessions:[raw('one')],hasNext:true,nextCursor:'same'});await expect(loadProjectConversationCandidates('m')).rejects.toThrow(/cursor|catalog/i);
 });
 it('fails closed on unreadable historical record keys',async()=>{
  mock.encryption.decryptEncryptionKey.mockResolvedValue(null);vi.mocked(fetchSessionSnapshotPage).mockResolvedValue({sessions:[raw('one')],hasNext:false,nextCursor:null});await expect(loadProjectConversationCandidates('m')).rejects.toThrow(/decrypt|history/i);
 });
 it('fences an account change during metadata decryption',async()=>{
  mock.encryption.prepareSessionEncryption.mockImplementation(async()=>{mock.owner={key:'b',generation:'2'};return {sessionEncryption:{decryptMetadata:async()=>({machineId:'m',path:'/p'})}};});vi.mocked(fetchSessionSnapshotPage).mockResolvedValue({sessions:[raw('one')],hasNext:false,nextCursor:null});await expect(loadProjectConversationCandidates('m')).rejects.toThrow(/account|changed/i);
 });
});
it('never sends old-account credentials on a next-page request after yielding to a server switch',async()=>{
 vi.mocked(fetchSessionSnapshotPage).mockResolvedValueOnce({sessions:Array.from({length:32},()=>raw('one')),hasNext:true,nextCursor:'next'}).mockResolvedValueOnce({sessions:[raw('other')],hasNext:false,nextCursor:null});
 const timer=vi.spyOn(globalThis,'setTimeout').mockImplementationOnce(((callback:()=>void)=>{mock.owner={key:'b',generation:'2'};queueMicrotask(callback);return 0;}) as any);
 try{await expect(loadProjectConversationCandidates('m')).rejects.toThrow(/account|changed/i);expect(fetchSessionSnapshotPage).toHaveBeenCalledTimes(1);}finally{timer.mockRestore();}
});
