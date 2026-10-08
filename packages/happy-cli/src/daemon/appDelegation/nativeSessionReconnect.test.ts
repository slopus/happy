import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, decodeBase64 } from '@/api/encryption';
import type { TrackedSession } from '../types';
import type { NativeLaunchPolicy } from './nativeLaunchPolicy';
import { nativeSessionReconnectEnvironment } from './nativeSessionReconnect';

const policy = {binding:{id:'binding',appId:'advisor',machineId:'machine',engine:'codex',accountRef:{kind:'codex-profile',id:'profile'}},directory:'/private/work'} as NativeLaunchPolicy;
const stored = (): TrackedSession => ({startedBy:'persisted',pid:0,happySessionId:'original-session',happySessionMetadataFromLocalWebhook:{application:{appId:'advisor',bindingId:'binding'},machineId:'machine',codexAccountProfileId:'profile',path:'/private/work',hostPid:42} as TrackedSession['happySessionMetadataFromLocalWebhook'],encryption:{encryptionKey:new Uint8Array(32).fill(7),encryptionVariant:'dataKey',seq:3,metadataVersion:2,agentStateVersion:1}});
describe('native retry after a failed first spawn',()=>{
 it('reuses the daemon-owned original session and key through the existing reconnect contract',()=>{
  const session=stored(),ciphertext=encrypt(session.encryption!.encryptionKey,'dataKey',{text:'retained native message'});
  expect(decrypt(new Uint8Array(32).fill(8),'dataKey',ciphertext)).toBeNull();
  const env=nativeSessionReconnectEnvironment(policy,[session],()=>false);
  expect(env.HAPPY_RECONNECT_SESSION_ID).toBe('original-session');
  expect(decrypt(decodeBase64(env.HAPPY_RECONNECT_ENCRYPTION_KEY),'dataKey',ciphertext)).toEqual({text:'retained native message'});
  expect(JSON.parse(env.HAPPY_RECONNECT_METADATA_JSON).application.bindingId).toBe('binding');
  expect(env.HAPPY_RECONNECT_SEQ).toBe('3');
 });
 it('does not reconnect unrelated sessions and does not start a second live worker',()=>{
  const unrelated=stored();unrelated.happySessionMetadataFromLocalWebhook!.application!.bindingId='another';
  expect(nativeSessionReconnectEnvironment(policy,[unrelated],()=>false)).toEqual({});
  expect(()=>nativeSessionReconnectEnvironment(policy,[stored()],()=>true)).toThrow('resource-busy');
 });
 it.each(['account','machine','directory','key','multiple'])('fails closed for %s mismatch',kind=>{
  const session=stored();
  if(kind==='account')session.happySessionMetadataFromLocalWebhook!.codexAccountProfileId='other';
  if(kind==='machine')session.happySessionMetadataFromLocalWebhook!.machineId='other';
  if(kind==='directory')session.happySessionMetadataFromLocalWebhook!.path='/other';
  if(kind==='key')session.encryption=undefined;
  expect(()=>nativeSessionReconnectEnvironment(policy,kind==='multiple'?[session,{...stored(),happySessionId:'other-session'}]:[session],()=>false)).toThrow();
 });
});
