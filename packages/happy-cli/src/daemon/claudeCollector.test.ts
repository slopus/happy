import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClaudeCollector, consumeCollectorPermit } from './claudeCollector'
const now = 2000000000000
const pair = generateKeyPairSync('ed25519')
const der = pair.publicKey.export({type:'spki',format:'der'}) as Buffer
const keyId = createHash('sha256').update(der).digest('hex')
const request = {version:1,companyId:'c',userId:'u',machineId:'m',managedAccountId:'11111111-1111-4111-8111-111111111111',permitId:'33333333-3333-4333-8333-333333333333',credentialGeneration:4,policyRevision:2,grant:''}
function envelope(extra = {}) {
 const claims = {v:1,type:'claude-collector-v1',aud:'claude-collector-v1@https://studio.test',keyId,companyId:'c',userId:'u',machineId:'m',managedAccountId:request.managedAccountId,credentialGeneration:4,policyRevision:2,permitId:'33333333-3333-4333-8333-333333333333',reservedAt:now,transportDeadline:now+10000,expiresAt:now+30000,...extra}
 const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
 return payload+'.'+sign(null,Buffer.from(payload),pair.privateKey).toString('base64url')
}
function setup() {
 const used = new Set<string>()
 const invoke = vi.fn(async (_args:string[], _input?:string) => JSON.stringify({version:1,artifact:'saycode-setup-token-runtime-v1',organizationCollectorVersion:1,accounts:[{...request,accountRef:'22222222-2222-4222-8222-222222222222',disabled:false,credentialType:'setup_token'}],observation:{source:'inference_probe',accountRef:'22222222-2222-4222-8222-222222222222',credentialGeneration:4,observedAt:new Date(now).toISOString(),windows:[{kind:'unified5h',pct:45,resetsAt:new Date(now+100000).toISOString(),status:'allowed'}],coverage:'unknown',reason:'coverage_unknown',retryAt:null,secret:'never'}}))
 const deps = {now:()=>now,studioOrigin:'https://studio.test',machineId:'m',authorize:vi.fn(async()=>true),consume:vi.fn(async(id:string)=>{if(used.has(id))return false;used.add(id);return true}),invoke,fetchImpl:vi.fn(async()=>new Response(JSON.stringify({version:1,type:'claude-collector-v1',algorithm:'Ed25519',keyId,publicKeyBase64:der.toString('base64'),audience:'claude-collector-v1@https://studio.test'}))) as unknown as typeof fetch}
 return {deps,invoke,collector:createClaudeCollector(deps)}
}
describe('signed collector boundary',()=>{
 it('verifies, consumes, invokes stdin once and whitelists epoch observations',async()=>{
  const {collector,deps,invoke}=setup(); const input={...request,grant:envelope()}
  const result=await collector(input)
  expect(result).toMatchObject({companyId:'c',permitId:request.permitId,observation:{observedAt:now,reason:'ok'}})
  expect(JSON.stringify(result)).not.toContain('never')
  expect(deps.consume).toHaveBeenCalledTimes(1)
  expect(invoke.mock.calls.find(c=>c[0].includes('collect-org'))?.[1]).toContain('permitId')
  expect(await collector(input)).toMatchObject({error:'COLLECTOR_PERMIT_REPLAYED'})
 })
 for(const change of [{aud:'wrong'},{type:'wrong'},{companyId:'other'},{userId:'other'},{machineId:'other'},{credentialGeneration:5},{policyRevision:3},{transportDeadline:now+20000},{reservedAt:now+1},{expiresAt:now+60000}])it('rejects signed mismatched claim '+JSON.stringify(change),async()=>{
  const {collector,deps}=setup(); expect(await collector({...request,grant:envelope(change)})).toMatchObject({error:'COLLECTOR_GRANT_INVALID'});expect(deps.consume).not.toHaveBeenCalled()
 })
 it('rejects caller origins, tampering, missing config, journal revoke and wrong roster',async()=>{
  const {collector,deps,invoke}=setup()
  expect(await collector({...request,grant:envelope(),origin:'https://evil.test'})).toMatchObject({error:'COLLECTOR_GRANT_INVALID'})
  expect(await collector({...request,grant:envelope().slice(0,-4)+'xxxx'})).toMatchObject({error:'COLLECTOR_GRANT_INVALID'})
  expect(await createClaudeCollector({...deps,studioOrigin:null})({...request,grant:envelope()})).toMatchObject({status:'action-required'})
  deps.authorize.mockResolvedValue(false)
  expect(await collector({...request,grant:envelope()})).toMatchObject({error:'COLLECTOR_ACCOUNT_NOT_ASSIGNED'})
  deps.authorize.mockResolvedValue(true);invoke.mockResolvedValue('{}')
  expect(await collector({...request,grant:envelope()})).toMatchObject({error:'COLLECTOR_RUNTIME_UNSUPPORTED'})
 })
})

describe('durable consume',()=>{
 it('retains replay across instances and fails closed on corrupt state',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'collector-test-'))
  try {
   expect(await consumeCollectorPermit(dir,'company:permit',now+30000,now)).toBe(true)
   expect(await consumeCollectorPermit(dir,'company:permit',now+30000,now)).toBe(false)
   await writeFile(join(dir,'permits.json'),'{broken')
   await expect(consumeCollectorPermit(dir,'new',now+30000,now)).rejects.toThrow()
  }finally{await rm(dir,{recursive:true,force:true})}
 })
})

describe('trusted public key boundary',()=>{
 it('rejects unsafe origin without fetching and wrong key/audience',async()=>{
  const {deps}=setup();const input={...request,grant:envelope()}
  expect(await createClaudeCollector({...deps,studioOrigin:'http://remote.test'})(input)).toMatchObject({error:'COLLECTOR_SIGNER_UNAVAILABLE'})
  expect(deps.fetchImpl).not.toHaveBeenCalled()
  deps.fetchImpl=vi.fn(async()=>new Response(JSON.stringify({version:1,type:'claude-collector-v1',algorithm:'Ed25519',keyId:'wrong',publicKeyBase64:der.toString('base64'),audience:'claude-collector-v1@https://studio.test'}))) as unknown as typeof fetch
  expect(await createClaudeCollector(deps)(input)).toMatchObject({error:'COLLECTOR_SIGNER_UNAVAILABLE'})
 })
 it('never invokes transport when durable consumption fails and rechecks ownership after transport',async()=>{
  const {deps,invoke}=setup();deps.consume.mockRejectedValueOnce(new Error('secret process details'))
  expect(await createClaudeCollector(deps)({...request,grant:envelope()})).toMatchObject({error:'COLLECTOR_REQUEST_FAILED'})
  expect(invoke.mock.calls.some(c=>c[0].includes('collect-org'))).toBe(false)
  deps.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  expect(await createClaudeCollector(deps)({...request,grant:envelope()})).toMatchObject({error:'COLLECTOR_ACCOUNT_NOT_ASSIGNED'})
 })
})

describe('installed provider offline roundtrip',()=>{
 it.skipIf(!process.env.COLLECTOR_PACK_PYTHON||!process.env.COLLECTOR_PACK_INSTALL)('executes marked wheel via stdin and file backend with guarded fake HTTP',async()=>{
  const {runAiCredentialCommand}=await import('./aiCredentialRuntime')
  const root=join(process.cwd(),'dist','collector-pack-smoke')
  const {mkdir}=await import('node:fs/promises');await mkdir(root,{recursive:true})
  const dir=await mkdtemp(join(root,'run-'))
  const script=join(dir,'provider.py')
  await writeFile(script,`import sys, os, json, urllib.request, contextlib, io
sys.platform='linux'
sys.path.insert(0,os.environ['COLLECTOR_PACK_INSTALL'])
def forbidden(*args,**kwargs): raise AssertionError('real network forbidden')
urllib.request.urlopen=forbidden
class Response:
 status=200
 headers={'anthropic-ratelimit-unified-5h-utilization':'0.45','anthropic-ratelimit-unified-5h-reset':'2100000000'}
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self,n):return b'{}'
class Opener:
 def open(self,request,timeout):
  assert request.full_url=='https://api.anthropic.com/v1/messages'
  assert json.loads(request.data)['messages']==[{'role':'user','content':'Hi'}]
  return Response()
urllib.request.build_opener=lambda *args:Opener()
from claude_swap.switcher import ClaudeAccountSwitcher
from claude_swap.models import Platform
from claude_swap.token_runtime import command
switcher=ClaudeAccountSwitcher();switcher.platform=Platform.LINUX
if not (switcher._get_sequence_data() or {}).get('accounts'):
 with contextlib.redirect_stdout(io.StringIO()): switcher.add_account_from_token(token='sk-ant-oat01-offline-fixture',email='managed-${request.managedAccountId}@setup-token.local')
 data=switcher._get_sequence_data();data['accounts']['1'].update(managedAccountId='${request.managedAccountId}',credentialType='setup_token',credentialGeneration=4)
 switcher._write_json(switcher.sequence_file,data)
 with contextlib.redirect_stdout(io.StringIO()): switcher.add_account_from_token(token='sk-ant-oat01-personal-offline-fixture',email='personal@token.local')
command(sys.argv[2:])
`)
  const current=Date.now()
  const {deps}=setup()
  const invoke=async(args:string[],input?:string)=>(await runAiCredentialCommand(process.env.COLLECTOR_PACK_PYTHON!,[script,...args],{input,timeoutMs:10000,maxOutputBytes:65536,environment:{PATH:process.env.PATH,HOME:dir,XDG_DATA_HOME:join(dir,'data'),CLAUDE_CONFIG_DIR:join(dir,'claude'),COLLECTOR_PACK_INSTALL:process.env.COLLECTOR_PACK_INSTALL}})).stdout
  const collector=createClaudeCollector({...deps,now:Date.now,invoke,consume:(id,expires)=>consumeCollectorPermit(join(dir,'receipts'),id,expires,Date.now())})
  const grant=envelope({reservedAt:current,transportDeadline:current+10000,expiresAt:current+30000})
  try {
   const result=await collector({...request,grant})
   expect(result).toMatchObject({companyId:'c',permitId:request.permitId,observation:{source:'inference_probe',reason:'ok',coverage:'unknown'}})
   expect(JSON.stringify(result)).not.toContain('sk-ant-oat01-')
   expect(await collector({...request,grant})).toMatchObject({error:'COLLECTOR_PERMIT_REPLAYED'})
   const {createTokenProbe}=await import('./tokenProbe')
   const roster=JSON.parse(await invoke(['token-runtime','status']))
   const personal=roster.accounts.find((a:any)=>!a.managedAccountId)
   const handle=createTokenProbe({invoke})
   const action={version:1,accountRef:personal.accountRef,credentialGeneration:personal.credentialGeneration}
   expect(await handle({...action,operation:'consent',enabled:true,ackCost:true})).toMatchObject({account:{probeEnabled:true}})
   const probe=await handle({...action,operation:'collect'})
   expect(probe).toMatchObject({account:{observation:{source:'inference_probe',coverage:'unknown'}},budget:{machineUsed24h:2}})
   expect(JSON.stringify(probe)).not.toContain('sk-ant-oat01-')
  }finally{await rm(dir,{recursive:true,force:true})}
 },15000)
})
