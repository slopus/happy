import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AiCredentialRuntimeDependencies } from './aiCredentialRuntime'
import type { GroupProvider } from './aiCredentialGroups'
type Account = Record<string,unknown>
export function groupAccountIdentity(provider:GroupProvider,account:Account):string {
  const email=typeof account.email==='string'?account.email.trim().toLowerCase():''
  const accountId=typeof account.accountId==='string'?account.accountId.trim():''
  if(!email&&!accountId)throw new Error('AI_GROUP_ACCOUNT_IDENTITY_UNAVAILABLE')
  return createHash('sha256').update(JSON.stringify(provider==='claude'?['claude',email,account.organizationUuid??'']:['codex',accountId?'id':'email',accountId||email])).digest('hex')
}
export function groupPayloadIdentities(provider:GroupProvider,payload:string):string[] {
  const value=JSON.parse(payload)
  const accounts=provider==='claude'?value.accounts:value.accounts?.accounts
  if(value.version!==1||!Array.isArray(accounts)||!accounts.length||accounts.length>500||(provider==='claude'&&value.encrypted!==false))throw new Error('AI_GROUP_INVALID_PAYLOAD')
  return accounts.map((account:Account)=>groupAccountIdentity(provider,account))
}
function liveCodexAccountId(live:Account|null):string|null {
  if(!live)return null
  const tokens=live.tokens as Record<string,unknown>|undefined
  let accountId=tokens?.account_id
  if(!accountId){
    for(const token of [tokens?.id_token,tokens?.access_token]){
      try{const claims=JSON.parse(Buffer.from(String(token).split('.')[1]||'','base64url').toString());accountId=claims['https://api.openai.com/auth']?.chatgpt_account_id;if(accountId)break}catch{}
    }
  }
  if(typeof accountId!=='string'||!accountId)throw new Error('AI_GROUP_ACCOUNT_IDENTITY_UNAVAILABLE')
  return accountId
}
export function createGroupProviderAdapters(deps:AiCredentialRuntimeDependencies) {
  const codexHome=deps.env.CODEX_HOME||join(deps.homeDir,'.codex')
  const poolPath=join(codexHome,'multi-auth','openai-codex-accounts.json')
  const livePath=deps.env.CODEX_CLI_AUTH_PATH||join(codexHome,'auth.json')
  async function optional(path:string) {
    try{return JSON.parse(await deps.readFile(path))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
  }
  async function claude() {
    const value=JSON.parse((await deps.execFile('cswap',['list','--json'],{timeoutMs:120_000,maxOutputBytes:1024*1024})).stdout)
    if(!Array.isArray(value.accounts))throw new Error('AI_GROUP_SNAPSHOT_FAILED')
    return value as {accounts:Account[];activeAccountNumber:number|null}
  }
  async function snapshot(provider:GroupProvider) {
    if(provider==='claude'){
      const list=await claude(),accounts=[...list.accounts]
      const config=await optional(deps.env.CLAUDE_CONFIG_DIR?join(deps.env.CLAUDE_CONFIG_DIR,'.claude.json'):join(deps.homeDir,'.claude.json'))
      if(config?.oauthAccount?.emailAddress)accounts.push({email:config.oauthAccount.emailAddress,organizationUuid:config.oauthAccount.organizationUuid??''})
      return [...new Set(accounts.map(a=>groupAccountIdentity(provider,a)))]
    }
    const pool=await optional(poolPath)
    if(pool&&(!Array.isArray(pool.accounts)||pool.version!==3))throw new Error('AI_GROUP_SNAPSHOT_FAILED')
    const accounts:Account[]=[...(pool?.accounts??[])]
    const live=await optional(livePath)
    const accountId=liveCodexAccountId(live)
    if(accountId)accounts.push({accountId})
    return [...new Set(accounts.map(a=>groupAccountIdentity(provider,a)))]
  }
  async function remove(provider:GroupProvider,identities:string[]) {
    const unwanted=new Set(identities)
    if(provider==='claude'){
      let list=await claude()
      for(const identity of identities){
        list=await claude()
        const target=list.accounts.find(account=>groupAccountIdentity(provider,account)===identity)
        if(!target)continue
        if(list.activeAccountNumber===target.number){
          const next=list.accounts.find(account=>!unwanted.has(groupAccountIdentity(provider,account))&&account.disabled!==true)
          if(next)await deps.execFile('cswap',['switch',String(next.number),'--force','--json'],{timeoutMs:120_000})
          else await deps.execFile('claude',['auth','logout'],{timeoutMs:120_000})
        }
        await deps.execFile('cswap',['remove',String(target.number)],{input:'y\n',timeoutMs:120_000})
      }
      return
    }
    if((deps.codexProxyStatus?.().activeRoutes??0)>0)throw new Error('AI_GROUP_REVOKE_BUSY')
    const globalRoot=(await deps.execFile('npm',['root','--global'])).stdout.trim()
    const script=`const {createRequire}=require('node:module'),{pathToFileURL}=require('node:url'),crypto=require('node:crypto');
const fs=require('node:fs/promises');const req=createRequire(${JSON.stringify(join(globalRoot,'codex-multi-auth','package.json'))});
const unwanted=new Set(${JSON.stringify(identities)});const identity=a=>crypto.createHash('sha256').update(JSON.stringify(['codex',a.accountId?'id':'email',a.accountId||(a.email||'').trim().toLowerCase()])).digest('hex');
(async()=>{const s=await import(pathToFileURL(req.resolve('codex-multi-auth/storage')).href);s.setStoragePathDirect(${JSON.stringify(poolPath)});s.setStorageBackupEnabled(false);
await s.withAccountStorageTransaction(async(current,persist)=>{if(!current)return;const keep=current.accounts.filter(a=>!unwanted.has(identity(a)));const index=i=>{const a=current.accounts[i];return a?s.findMatchingAccountIndex(keep,a):undefined};const next={...current,accounts:keep,activeIndex:index(current.activeIndex)??0,activeIndexByFamily:Object.fromEntries(Object.entries(current.activeIndexByFamily||{}).map(([k,v])=>[k,index(v)??0]))};const pin=index(current.pinnedAccountIndex);if(pin===undefined)delete next.pinnedAccountIndex;else next.pinnedAccountIndex=pin;await persist(next)});
})().catch(()=>{process.exitCode=1});`
    await deps.execFile(process.execPath,['-e',script],{timeoutMs:120_000})
    const live=await optional(livePath)
    const accountId=liveCodexAccountId(live)
    if(accountId&&unwanted.has(groupAccountIdentity(provider,{accountId}))){
      const pool=await optional(poolPath)
      if(pool?.accounts?.length)await deps.execFile('codex-multi-auth',['switch',String(pool.activeIndex+1)],{timeoutMs:120_000})
      else await deps.rm(livePath,{force:true})
    }
  }
  return {snapshot,remove}
}
