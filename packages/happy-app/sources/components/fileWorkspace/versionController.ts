import type { Artifact, ArtifactReadResult, ArtifactVersion, ArtifactRequests, ArtifactResponses } from '@slopus/happy-wire';
import { ARTIFACT_LIMITS, ARTIFACT_PROTOCOL } from '@slopus/happy-wire';
import type { z } from 'zod';
export type VersionRPC = <K extends keyof typeof ArtifactRequests>(method: K, input: z.infer<(typeof ArtifactRequests)[K]>) => Promise<z.infer<(typeof ArtifactResponses)[K]>>;
type Operation = z.infer<typeof ArtifactResponses.artifactOperation>;
export type RestoreSelection = {workspaceId:string;artifactId:string;versionId:string;expectedRevision:string};
type FrozenMutation = {method:'artifactSave';input:z.infer<typeof ArtifactRequests.artifactSave>} | {method:'artifactRestore';input:z.infer<typeof ArtifactRequests.artifactRestore>};
export type PendingVersionOperation = { resolution?: {id:string;action:'resume'|'rollback'}; request?: FrozenMutation; managedPaths?: string[]; canRetry?: boolean; operationId: string; workspaceId: string; kind: 'restore' | 'save' | 'register' };
export type VersionState = {
 artifact: Artifact | null; current: ArtifactReadResult | null; versions: ArtifactVersion[]; cursor?: string;
 selectedId: string | null; preview: ArtifactReadResult | null; loading: boolean; selecting: boolean;
 busy: boolean; error: string | null; pending: PendingVersionOperation | null; operation: Operation | null;
};
const empty = (): VersionState => ({artifact:null,current:null,versions:[],selectedId:null,preview:null,loading:false,selecting:false,busy:false,error:null,pending:null,operation:null});
const errorCode = (e: any) => e?.detail?.code ?? 'UNAVAILABLE';
const uncertainError = (e:any) => !!e?.detail?.operationId || ['INTERNAL','COMMIT_PENDING','PARTIAL_COMMIT'].includes(errorCode(e)) || (errorCode(e)==='UNAVAILABLE' && e?.uncertain!==false);
const ref = (artifact: Artifact) => ({workspaceId:artifact.workspaceId,artifactId:artifact.id});
export class VersionController {
 private snapshot: Record<string,VersionState> = {};
 private listeners = new Set<()=>void>();
 private selections = new Map<string,object>();
 private currentRequests = new Map<string,Promise<ArtifactReadResult|null>>();
 private currentWaiters = new Map<string,{
  resolve:(value:ArtifactReadResult|null|PromiseLike<ArtifactReadResult|null>)=>void;
  reject:(reason:unknown)=>void;
 }>();
 private reads = new Map<string,object>();
 private disposed = false;
 private active() {return !this.disposed && this.valid();}
 constructor(readonly root: string, private rpc: VersionRPC, private valid:()=>boolean=()=>true,
  pending: Record<string,PendingVersionOperation> = {}, private persist?:(p:Record<string,PendingVersionOperation>)=>void) {
  this.root=root.replace(/\/+$/,'') || '/';
  for (const [path,value] of Object.entries(pending)) this.snapshot[path]={...empty(),pending:value};
 }
 getSnapshot=()=>this.snapshot;
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
 state=(path:string):VersionState=>this.snapshot[path] ?? EMPTY;
 currentForHash(path:string,hash:string|null):ArtifactReadResult|null {
  const state=this.state(path),current=state.current;
  if(!this.active() || !hash || !current || state.pending)return null;
  return current.manifest.files.find(file=>file.path===current.manifest.entryPath)?.sha256===hash ? current : null;
 }
 private patch(path:string,change:Partial<VersionState>) {
  if(this.disposed || !this.valid()) return;
  this.snapshot={...this.snapshot,[path]:{...this.state(path),...change}}; this.listeners.forEach(fn=>fn());
  try {this.persist?.(Object.fromEntries(Object.entries(this.snapshot).filter(([,s])=>s.pending).map(([p,s])=>[p,s.pending!])));} catch {this.snapshot={...this.snapshot,[path]:{...this.state(path),error:'LOCAL_STORAGE'}};}
 }
 private async ensureCompatible() {
  const caps=await this.rpc('artifactCapabilities',{});
  if(caps.protocol!==ARTIFACT_PROTOCOL)throw Object.assign(new Error('Unsupported artifact protocol'),{detail:{code:'UNAVAILABLE'}});
 }
 async discover(path:string) {
  await this.ensureCompatible();
  const catalog=await this.rpc('artifactCatalog',{root:this.root});
  if(catalog.length>1)throw Object.assign(new Error('Unfiltered artifact catalog'),{detail:{code:'UNAVAILABLE'}});
  const artifact=catalog[0]?.artifacts.find(a=>this.root+'/'+a.entryPath===path) ?? null;
  this.patch(path,{artifact}); return artifact;
 }
 current(path:string):Promise<ArtifactReadResult|null> {
  if(!this.active())return Promise.resolve(null);
  const token={}; this.reads.set(path,token);
  let resolveCurrent!:(value:ArtifactReadResult|null|PromiseLike<ArtifactReadResult|null>)=>void;
  let rejectCurrent!:(reason:unknown)=>void;
  const request=new Promise<ArtifactReadResult|null>((resolve,reject)=>{resolveCurrent=resolve;rejectCurrent=reject;});
  this.currentWaiters.get(path)?.resolve(request);
  this.currentWaiters.set(path,{resolve:resolveCurrent,reject:rejectCurrent});
  this.currentRequests.set(path,request);
  this.patch(path,{current:null});
  void this.readCurrent(path,token).then(value=>{
   if(this.reads.get(path)!==token)return;
   this.currentWaiters.delete(path);resolveCurrent(value);
  },error=>{
   if(this.reads.get(path)!==token)return;
   this.currentWaiters.delete(path);rejectCurrent(error);
  });
  return request;
 }
 waitForCurrent(path:string):Promise<ArtifactReadResult|null> {
  if(!this.active())return Promise.resolve(null);
  return this.currentRequests.get(path) ?? Promise.resolve(this.state(path).current);
 }
 private async readCurrent(path:string,token:object):Promise<ArtifactReadResult|null> {
  const a=this.state(path).artifact ?? await this.discover(path);
  if(!a || !this.active() || this.reads.get(path)!==token) return null;
  const current=await this.rpc('artifactRead',ref(a));
  if(!this.active() || this.reads.get(path)!==token)return null;
  const pending=this.state(path).pending;
  this.patch(path,{current,artifact:current.artifact,...(current.pendingOperationId ? {pending:pending?.operationId===current.pendingOperationId && pending.workspaceId===current.artifact.workspaceId ? pending : {operationId:current.pendingOperationId,workspaceId:current.artifact.workspaceId,kind:'restore' as const}} : {})});
  return current;
 }
 async load(path:string,more=false,refreshCurrent=true) {
  if(!this.active() || this.state(path).loading) return false;
  this.patch(path,{loading:true,error:null});
  try {
   const a=this.state(path).artifact ?? await this.discover(path); if(!a) return false;
   if(refreshCurrent)await this.current(path);
   const result=await this.rpc('artifactVersions',{...ref(a),...(more && this.state(path).cursor?{cursor:this.state(path).cursor}:{})});
   this.patch(path,{versions:more?[...this.state(path).versions,...result.versions.filter(v=>!this.state(path).versions.some(x=>x.id===v.id))]:result.versions,cursor:result.nextCursor}); return true;
  } catch(e) {this.patch(path,{error:errorCode(e),current:null});return false;} finally {this.patch(path,{loading:false});}
 }
 async register(path:string,managedPaths:string[]) {
  if(!this.active() || this.state(path).busy || this.state(path).pending) return false;
  try {await this.ensureCompatible();}catch(e){this.patch(path,{error:errorCode(e)});return false;}
  return this.registerWithOperation(path,[...managedPaths],crypto.randomUUID());
 }
 private async registerWithOperation(path:string,managedPaths:string[],operationId:string) {
  if(!this.active()) return false;
  this.patch(path,{busy:true,error:null});
  try {
   const artifact=await this.rpc('artifactRegister',{root:this.root,entryPath:path.slice(this.root.length+1),managedPaths,operationId});
   this.patch(path,{artifact,pending:null}); await this.load(path); return true;
  } catch(e) {
   // Registration may have committed before its reply was lost. Discover once, never resend.
   if(uncertainError(e)) {try {if(await this.discover(path)) {await this.load(path); return true;}} catch { /* show unknown outcome */ }
    this.patch(path,{pending:{operationId,workspaceId:'',kind:'register',managedPaths:[...managedPaths],canRetry:false}});
   }
   this.patch(path,{error:errorCode(e),...(!uncertainError(e)?{pending:null}:{})}); return false;
  } finally {this.patch(path,{busy:false});}
 }
 /** Only an explicit UI action may replay this idempotent, frozen registration. */
 async retryRegistration(path:string) {
  const pending=this.state(path).pending;
  if(!this.active() || this.state(path).busy || pending?.kind!=='register' || !pending.canRetry || !pending.managedPaths?.length)return false;
  this.patch(path,{busy:true,error:null});
  try {
   if(await this.discover(path)){this.patch(path,{pending:null});await this.load(path);return true;}
   return await this.registerWithOperation(path,pending.managedPaths,pending.operationId);
  }catch(e){this.patch(path,{error:errorCode(e),pending:{...pending,canRetry:false}});return false;}finally{this.patch(path,{busy:false});}
 }
 async select(path:string,versionId:string) {
  if(!this.active() || this.state(path).busy || this.state(path).pending) return;
  const artifact=this.state(path).artifact; if(!artifact) return;
  const token={};this.selections.set(path,token);this.patch(path,{selectedId:versionId,preview:null,selecting:true,error:null});
  try {const preview=await this.rpc('artifactRead',{...ref(artifact),versionId});if(this.selections.get(path)===token)this.patch(path,{preview});}
  catch(e){if(this.selections.get(path)===token)this.patch(path,{error:errorCode(e)});}
  finally {if(this.selections.get(path)===token)this.patch(path,{selecting:false});}
 }
 canRestore(path:string) {const s=this.state(path);return this.active() && !!(s.current && s.preview && s.selectedId && s.preview.readRef.kind==='version' && s.preview.readRef.versionId===s.selectedId && (s.selectedId!==s.current.artifact.currentVersionId || s.current.workingState==='dirty') && !s.selecting && !s.loading && !s.busy && !s.pending && !['writing','recovery-required'].includes(s.current.workingState));}
 prepareRestore(path:string):RestoreSelection|null {
  if(!this.canRestore(path))return null;const s=this.state(path);return {...ref(s.artifact!),versionId:s.selectedId!,expectedRevision:s.current!.workingRevision};
 }
 async restore(path:string,selection=this.prepareRestore(path)) {
  if(!this.canRestore(path) || !selection)return false;
  const s=this.state(path);
  if(s.artifact!.workspaceId!==selection.workspaceId || s.artifact!.id!==selection.artifactId || s.selectedId!==selection.versionId || s.current!.workingRevision!==selection.expectedRevision){this.patch(path,{error:'CONFLICT'});return false;}
  const operationId=crypto.randomUUID();
  const input={...ref(s.artifact!),operationId,expectedRevision:selection.expectedRevision,versionId:selection.versionId};
  return this.mutate(path,{operationId,workspaceId:s.artifact!.workspaceId,kind:'restore',request:{method:'artifactRestore',input}},()=>this.rpc('artifactRestore',input));
 }
 async save(path:string,content:string,hash:string) {
  await this.waitForCurrent(path);
  const s=this.state(path); if(!this.active() || !s.artifact || !s.current || s.busy || s.pending)throw new Error('VERSION_BUSY');
  if(s.current.manifest.files.find(f=>f.path===s.current!.manifest.entryPath)?.sha256!==hash)throw new Error('VERSION_CONFLICT');
  const operationId=crypto.randomUUID();const input={...ref(s.artifact!),operationId,expectedRevision:s.current!.workingRevision,entryContent:content};
  const ok=await this.mutate(path,{operationId,workspaceId:s.artifact.workspaceId,kind:'save',request:{method:'artifactSave',input}},()=>this.rpc('artifactSave',input));
  if(!ok)throw new Error('VERSION_'+(this.state(path).error??'PENDING'));
  const loaded=this.state(path).current; if(!loaded)throw new Error('VERSION_REFRESH_FAILED');
  const bytes=new TextEncoder().encode(content);
  const digest=await crypto.subtle.digest('SHA-256',bytes as BufferSource);
  return {hash:Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('')};
 }
 private async mutate(path:string,pending:PendingVersionOperation,run:()=>Promise<unknown>) {
  this.patch(path,{busy:true,operation:null,error:null});
  let dispatched=false;
  try {await this.ensureCompatible();if(!this.active())return false;this.patch(path,{pending});dispatched=true;await run();this.patch(path,{current:null,selectedId:null,preview:null});}
  catch(e:any) {
   const code=errorCode(e); const uncertain=dispatched && uncertainError(e);
   this.patch(path,{error:code,...(!uncertain?{pending:null}:{pending:{...pending,operationId:e?.detail?.operationId??pending.operationId}})});return false;
  } finally {this.patch(path,{busy:false});}
  // A successful mutation and a failed refresh are distinct. Keep success so the file layer reloads.
  const loaded=await this.load(path); if(loaded && !this.state(path).current?.pendingOperationId)this.patch(path,{pending:null,operation:null});return loaded && !this.state(path).current?.pendingOperationId;
 }
 async inspect(path:string) {
  const s=this.state(path);if(!this.active() || !s.pending || s.busy)return false;
  this.patch(path,{busy:true,error:null});
  try {
   if(s.pending.kind==='register') {if(await this.discover(path)) {this.patch(path,{pending:null});await this.load(path);return true;} this.patch(path,{pending:{...s.pending,canRetry:!!s.pending.managedPaths?.length},error:'REGISTRATION_NOT_FOUND'});return false;}
   let operation=await this.rpc('artifactOperation',{workspaceId:s.pending.workspaceId,operationId:s.pending.operationId});
   if(operation.pendingOperationId) {
    const linked={...s.pending,resolution:undefined,operationId:operation.pendingOperationId};this.patch(path,{pending:linked});
    operation=await this.rpc('artifactOperation',{workspaceId:linked.workspaceId,operationId:linked.operationId});
   }
   this.patch(path,{operation});
   if(operation.status==='committed'){this.patch(path,{current:null,selectedId:null,preview:null});const loaded=await this.load(path);if(loaded && !this.state(path).current?.pendingOperationId)this.patch(path,{pending:null});return loaded && !this.state(path).current?.pendingOperationId;}
   if(operation.status==='failed' && !operation.actions.length && !operation.pendingOperationId)this.patch(path,{pending:null,error:'INTERNAL'});
   return false;
  }catch(e){this.patch(path,{error:errorCode(e),...(errorCode(e)==='NOT_FOUND' && this.state(path).pending?.request?.input.operationId===this.state(path).pending?.operationId ? {pending:{...this.state(path).pending!,canRetry:true}}:{})});return false;}finally{this.patch(path,{busy:false});}
 }
 async retryOperation(path:string) {
  const pending=this.state(path).pending;
  if(!this.active() || this.state(path).busy || !pending?.canRetry || !pending.request || pending.request.input.operationId!==pending.operationId)return false;
  this.patch(path,{busy:true,error:null});
  try {
   const a=await this.discover(path);
   if(!a || a.id!==pending.request.input.artifactId || a.workspaceId!==pending.request.input.workspaceId)throw Object.assign(new Error('Artifact changed'),{detail:{code:'CONFLICT'},uncertain:false});
   try {await this.rpc('artifactOperation',{workspaceId:pending.workspaceId,operationId:pending.operationId});}
   catch(e) {
    if(errorCode(e)!=='NOT_FOUND')throw e;
    if(!this.active())return false;
    const request=pending.request;return await this.mutate(path,{...pending,canRetry:false},()=>this.rpc(request.method,request.input));
   }
  }catch(e){this.patch(path,{error:errorCode(e)});return false;}finally{this.patch(path,{busy:false});}
  return this.inspect(path);
 }
 async resolve(path:string,action:'resume'|'rollback') {
  const s=this.state(path);if(!this.active() || s.busy || !s.pending || !s.operation?.actions.includes(action))return false;
  const resolution=s.pending.resolution?.action===action ? s.pending.resolution : {id:crypto.randomUUID(),action};
  this.patch(path,{busy:true,error:null,pending:{...s.pending,resolution}});
  try {
   await this.ensureCompatible();if(!this.active())return false;
   await this.rpc('artifactResolveOperation',{workspaceId:s.pending.workspaceId,operationId:s.pending.operationId,resolutionId:resolution.id,action,expectedObservedRevision:s.operation.observedRevision});
   // Inspect on this explicit action only. Never infer a full commit from a resolution reply.
  }catch(e){this.patch(path,{error:errorCode(e)});return false;}finally{this.patch(path,{busy:false});}
  if(action==='rollback'){const loaded=await this.load(path);if(loaded && !this.state(path).current?.pendingOperationId)this.patch(path,{pending:null,operation:null,selectedId:null,preview:null,error:null});return loaded && !this.state(path).current?.pendingOperationId;}
  return this.inspect(path);
 }
 reader(value:ArtifactReadResult) {
  return async (absolute:string):Promise<Uint8Array>=>{
   const path=absolute.startsWith(this.root+'/')?absolute.slice(this.root.length+1):'';
   const file=value.manifest.files.find(f=>f.path===path);if(!file)throw new Error('INCOMPLETE_VERSION');
   const bytes=new Uint8Array(file.size);
   for(let offset=0;offset<file.size;) {
    const chunk=await this.rpc('artifactResourceRead',{...ref(value.artifact),readRef:value.readRef,path,offset,length:Math.min(ARTIFACT_LIMITS.chunk,file.size-offset)});
    const part=Uint8Array.from(atob(chunk.content),c=>c.charCodeAt(0));
    if(chunk.offset!==offset || chunk.sha256!==file.sha256 || chunk.totalSize!==file.size || !part.length || part.length>file.size-offset)throw new Error('INCOMPLETE_VERSION');
    bytes.set(part,offset);offset+=part.length;
   }
   return bytes;
  };
 }
 dispose(){
  this.disposed=true;this.listeners.clear();this.selections.clear();this.reads.clear();
  for(const waiter of this.currentWaiters.values())waiter.resolve(null);
  this.currentWaiters.clear();this.currentRequests.clear();
 }
}
const EMPTY=empty();
