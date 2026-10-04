import { describe, expect, it, vi } from 'vitest'
import { createCredentialGroupSync } from './aiCredentialGroups'
function setup() {
  let journal:string|null=null
  const installed=new Set(['personal'])
  const deps={read:async()=>journal,write:vi.fn(async(value:string)=>{journal=value}),snapshot:async()=>[...installed],incoming:(_provider:string,payload:string)=>JSON.parse(payload) as string[],apply:vi.fn(async(_provider:string,payload:string)=>{for(const id of JSON.parse(payload))installed.add(id)}),remove:vi.fn(async(_provider:string,ids:string[])=>{ids.forEach(id=>installed.delete(id))})}
  const sync=createCredentialGroupSync(deps)
  const input=(generation:number,payload:string|null,scope='company')=>({version:1 as const,provider:'claude' as const,scope,userId:'user',generation,fingerprint:String(generation).padStart(64,'a'),payload})
  return {deps,installed,sync,input,restart:()=>createCredentialGroupSync(deps)}
}
describe('scoped credential group synchronization',()=>{
  it('records introduced accounts only and preserves personal credentials on revoke',async()=>{
    const {sync,input,installed,deps}=setup()
    await sync.sync(input(1,JSON.stringify(['personal','shared'])))
    expect(deps.write).toHaveBeenCalledBefore(deps.apply)
    await sync.sync(input(2,null))
    expect([...installed]).toEqual(['personal'])
    expect(deps.remove).toHaveBeenCalledWith('claude',['shared'])
  })
  it('preserves another valid assignment and removes the shared slot after the last revoke',async()=>{
    const {sync,input,installed}=setup()
    await sync.sync(input(1,'["shared"]','a'))
    await sync.sync(input(1,'["shared"]','b'))
    await sync.sync(input(2,null,'a'))
    expect(installed.has('shared')).toBe(true)
    await sync.sync(input(2,null,'b'))
    expect(installed.has('shared')).toBe(false)
  })
  it('rejects stale or conflicting generation and replays a completed operation without reimport',async()=>{
    const {sync,input,deps}=setup()
    const first=input(2,'["shared"]')
    await sync.sync(first)
    expect(await sync.sync(first)).toMatchObject({reconciled:true,generation:2})
    expect(deps.apply).toHaveBeenCalledTimes(1)
    await expect(sync.sync(input(1,null))).rejects.toThrow('AI_GROUP_GENERATION_STALE')
    await expect(sync.sync({...first,payload:null,fingerprint:'b'.repeat(64)})).rejects.toThrow('AI_GROUP_GENERATION_CONFLICT')
  })
  it('recovers introduced account custody when an import was interrupted',async()=>{
    const {sync,input,deps,installed,restart}=setup()
    deps.apply.mockImplementationOnce(async()=>{installed.add('shared');throw new Error('interrupted')})
    await expect(sync.sync(input(1,'["shared"]'))).rejects.toThrow('interrupted')
    await restart().sync(input(2,null))
    expect([...installed]).toEqual(['personal'])
  })
  it('does not revoke accounts taken over by a later manual credential apply',async()=>{
    const {sync,input,installed}=setup()
    await sync.sync(input(1,'["shared"]'))
    await sync.invalidate('claude',['shared'])
    expect(await sync.receipt('company','claude')).toMatchObject({reconciled:false})
    await sync.sync(input(2,null))
    expect(installed.has('shared')).toBe(true)
  })
  it('does not acknowledge incomplete removal or replace a corrupted journal',async()=>{
    const {sync,input,deps}=setup()
    await sync.sync(input(1,'["shared"]'))
    deps.remove.mockResolvedValue(undefined)
    await expect(sync.sync(input(2,null))).rejects.toThrow('AI_GROUP_REMOVAL_INCOMPLETE')
    const corrupt=createCredentialGroupSync({...deps,read:async()=>'{broken'})
    const writes=deps.write.mock.calls.length
    await expect(corrupt.sync(input(3,null))).rejects.toThrow('AI_GROUP_JOURNAL_INVALID')
    expect(deps.write).toHaveBeenCalledTimes(writes)
  })
  it('authorizes only a reconciled desired owned identity for exact company and user',async()=>{
    const {sync,input}=setup()
    const request=input(1,'["shared"]')
    await sync.sync(request)
    expect(await sync.authorize(request.scope,request.userId,'shared')).toBe(true)
    expect(await sync.authorize('other',request.userId,'shared')).toBe(false)
    expect(await sync.authorize(request.scope,'other','shared')).toBe(false)
    expect(await sync.authorize(request.scope,request.userId,'personal')).toBe(false)
    await sync.invalidate('claude',[])
    expect(await sync.authorize(request.scope,request.userId,'shared')).toBe(false)
  })

})
