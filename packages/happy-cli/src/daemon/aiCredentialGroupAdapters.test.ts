import { mkdtemp,readFile,writeFile,mkdir,chmod,rename,rm,readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile as exec,execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { describe,expect,it,vi } from 'vitest'
import { createGroupProviderAdapters,groupAccountIdentity } from './aiCredentialGroupAdapters'
import type { AiCredentialRuntimeDependencies } from './aiCredentialRuntime'

let globalRoot=''
try{globalRoot=execFileSync('npm',['root','--global'],{encoding:'utf8'}).trim();execFileSync(process.execPath,['-e',`require.resolve('codex-multi-auth/storage',{paths:[${JSON.stringify(globalRoot)}]})`],{stdio:'ignore'})}catch{globalRoot=''}

describe('provider group custody removal',()=>{
  it.skipIf(!globalRoot)('removes only managed Codex slots using storage locking, preserving live personal auth and indexes',async()=>{
    const home=await mkdtemp(join(tmpdir(),'happy-group-pool-'))
    const root=join(home,'.codex','multi-auth'),pool=join(root,'openai-codex-accounts.json'),live=join(home,'.codex','auth.json')
    await mkdir(root,{recursive:true})
    const personal={accountId:'personal',email:'personal@example.test',refreshToken:'test-personal-refresh',accessToken:'test-personal-access',addedAt:1,lastUsed:1}
    const shared={accountId:'shared',email:'shared@example.test',refreshToken:'test-shared-refresh',accessToken:'test-shared-access',addedAt:1,lastUsed:1}
    await writeFile(pool,JSON.stringify({version:3,accounts:[shared,personal],activeIndex:1,pinnedAccountIndex:1,activeIndexByFamily:{codex:1}}),{mode:0o600})
    const original=JSON.stringify({tokens:{account_id:'personal',access_token:'test-personal-access',refresh_token:'test-personal-refresh'}})
    await writeFile(live,original,{mode:0o600})
    const execFile=vi.fn(async(command:string,args:string[])=>{
      if(command==='npm')return {stdout:globalRoot,stderr:''}
      if(command===process.execPath)return promisify(exec)(command,args,{timeout:30_000})
      throw new Error('Unexpected external command')
    })
    const deps={homeDir:home,env:{},readFile:(path:string)=>readFile(path,'utf8'),writeFile,mkdir,chmod,rename,rm,readdir,execFile,supervisor:{stop:vi.fn()},now:Date.now} as unknown as AiCredentialRuntimeDependencies
    try {
      await createGroupProviderAdapters(deps).remove('codex',[groupAccountIdentity('codex',shared)])
      const saved=JSON.parse(await readFile(pool,'utf8'))
      expect(saved.accounts.map((a:{accountId:string})=>a.accountId)).toEqual(['personal'])
      expect(saved.activeIndex).toBe(0);expect(saved.pinnedAccountIndex).toBe(0)
      expect(await readFile(live,'utf8')).toBe(original)
    }finally{await rm(home,{recursive:true,force:true})}
  })
  it('includes a live personal identity encoded in a JWT and fails closed for unidentifiable auth',async()=>{
    const token='header.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'personal'}})).toString('base64url')+'.signature'
    const read=vi.fn(async(path:string)=>{
      if(path.endsWith('auth.json'))return JSON.stringify({tokens:{access_token:token,refresh_token:'test'}})
      throw Object.assign(new Error('missing'),{code:'ENOENT'})
    })
    const adapter=createGroupProviderAdapters({homeDir:'/fixture',env:{},readFile:read} as unknown as AiCredentialRuntimeDependencies)
    expect(await adapter.snapshot('codex')).toEqual([groupAccountIdentity('codex',{accountId:'personal'})])
    read.mockImplementation(async(path:string)=>{if(path.endsWith('/auth.json'))return JSON.stringify({tokens:{access_token:'unidentifiable'}});throw Object.assign(new Error('missing'),{code:'ENOENT'})})
    await expect(adapter.snapshot('codex')).rejects.toThrow('AI_GROUP_ACCOUNT_IDENTITY_UNAVAILABLE')
  })
  it('refuses Codex removal while a live proxy route is using credentials',async()=>{
    const execFile=vi.fn()
    const adapter=createGroupProviderAdapters({homeDir:'/unused',env:{},execFile,codexProxyStatus:()=>({activeRoutes:1})} as unknown as AiCredentialRuntimeDependencies)
    await expect(adapter.remove('codex',['a'.repeat(64)])).rejects.toThrow('AI_GROUP_REVOKE_BUSY')
    expect(execFile).not.toHaveBeenCalled()
  })
})
