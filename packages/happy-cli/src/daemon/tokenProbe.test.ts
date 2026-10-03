import { describe,expect,it,vi } from 'vitest'
import { createTokenProbe } from './tokenProbe'
const ref='11111111-1111-4111-8111-111111111111'
function setup() {
 const row={accountRef:ref,credentialGeneration:2,credentialType:'setup_token',probeEnabled:false,authState:'unverified',usageStatus:'unavailable',reasonCodes:['coverage_unknown'],secret:'private'}
 const invoke=vi.fn(async(args:string[])=>JSON.stringify(args[1]==='capabilities'?{version:1,artifact:'saycode-setup-token-runtime-v1',setupTokenObservation:true,durableProbeBudget:true,personalProbeVersion:1}:args[1]==='status'?{accounts:[row],budget:{machineUsed24h:0,machineLimit24h:288,accountLimit24h:96}}:{version:1,artifact:'saycode-setup-token-runtime-v1'}))
 return {row,invoke,handle:createTokenProbe({invoke})}
}
const request=(operation:string,extra={})=>({version:1,operation,accountRef:ref,credentialGeneration:2,...extra})
describe('personal Core probe',()=>{
 it('status reads only local status and whitelists the result',async()=>{
  const {handle,invoke}=setup();const result=await handle(request('status'))
  expect(result).toMatchObject({operation:'status',account:{probeEnabled:false}})
  expect(JSON.stringify(result)).not.toContain('private')
  expect(invoke.mock.calls.map(c=>c[0][1])).toEqual(['capabilities','status','status'])
 })
 it('consent requires explicit cost acknowledgment and exact ref/generation',async()=>{
  const {handle,invoke}=setup()
  expect(await handle(request('consent',{enabled:true}))).toMatchObject({error:'TOKEN_PROBE_COST_ACK_REQUIRED'})
  expect(await handle(request('consent',{enabled:true,ackCost:true,credentialGeneration:1}))).toMatchObject({error:'TOKEN_PROBE_GENERATION_CHANGED'})
  await handle(request('consent',{enabled:true,ackCost:true}))
  expect(invoke.mock.calls.some(c=>c[0].join(' ')==='token-runtime consent '+ref+' --generation 2 --enable --ack-cost')).toBe(true)
 })
 it.each(['consent','collect'])('managed account always refuses %s',async(operation)=>{
  const {row,handle,invoke}=setup();Object.assign(row,{managedAccountId:ref,probeEnabled:true})
  expect(await handle(request(operation,operation==='consent'?{enabled:true,ackCost:true}:{}))).toMatchObject({error:'TOKEN_PROBE_ORGANIZATION_COLLECTOR_REQUIRED'})
  expect(invoke.mock.calls.some(c=>['consent','collect'].includes(c[0][1]))).toBe(false)
 })
 it('manual collect uses stable selector only and discards changed generation',async()=>{
  const {row,handle,invoke}=setup();const original=invoke.getMockImplementation()!
  invoke.mockImplementation(async(args)=>{if(args[1]==='collect')row.credentialGeneration=3;return original(args)})
  expect(await handle(request('collect'))).toMatchObject({error:'TOKEN_PROBE_GENERATION_CHANGED'})
  expect(invoke.mock.calls.some(c=>c[0].join(' ')==='token-runtime collect '+ref+' --generation 2 --in-use')).toBe(true)
 })
 it('rejects extra fields and masks subprocess details',async()=>{
  const {handle,invoke}=setup()
  expect(await handle(request('collect',{token:'secret'}))).toMatchObject({error:'TOKEN_PROBE_INVALID_INPUT'})
  invoke.mockRejectedValue(new Error('sk-ant-oat01-secret'))
  expect(JSON.stringify(await handle(request('status')))).not.toContain('sk-ant-oat01-')
 })
})

it('preserves provider budget/backoff refusals and disables consent without a cost acknowledgment',async()=>{
 const {handle,invoke}=setup();const original=invoke.getMockImplementation()!
 invoke.mockImplementation(async(args)=>args[1]==='collect'?JSON.stringify({reason:'budget_exhausted'}):original(args))
 expect(await handle(request('collect'))).toMatchObject({error:'TOKEN_PROBE_BUDGET_EXHAUSTED'})
 expect(await handle(request('consent',{enabled:false}))).toMatchObject({operation:'consent'})
 expect(invoke.mock.calls.some(c=>c[0].join(' ')==='token-runtime consent '+ref+' --generation 2 --disable')).toBe(true)
})

it('exposes a metadata-only roster for discovery without replacing legacy usage',async()=>{
 const {readTokenRuntime}=await import('./tokenProbe')
 const {invoke,row}=setup();Object.assign(row,{number:1,roster:{email:'personal@token.local',organizationUuid:'',uuid:''}})
 const roster=await readTokenRuntime({invoke})
 expect(roster).toMatchObject({version:1,state:'available',accounts:[{accountRef:ref,number:1,credentialGeneration:2,legacyUsageOwned:false}]})
 expect(JSON.stringify(roster)).not.toContain('private')
 expect(invoke.mock.calls.map(c=>c[0][1])).toEqual(['capabilities','status'])
})
