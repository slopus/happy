import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const settings = vi.hoisted(() => ({ happyHomeDir: '', serverUrl: 'https://example.test' }));
vi.mock('@/configuration', () => ({ configuration: settings }));
vi.mock('@/daemon/controlClient', () => ({ readArtifactWorkerInventory: async () => [] }));
vi.mock('@/ui/logger', () => ({logger:{debug:vi.fn()}}));
import { createArtifactRuntime, watchArtifactChanges } from './runtime';
import { withMachineLock, atomicFile, ArtifactError } from './files';
let directory: string;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
it('retains the invalidation watcher when startup races a live machine lock', async () => {
  directory = await mkdtemp(join(tmpdir(), 'paws-version-events-')); settings.happyHomeDir = join(directory, 'home'); await mkdir(settings.happyHomeDir);
  const root = join(directory, 'project'); await mkdir(root); await writeFile(join(root, 'a.md'), 'one');
  const runtime = createArtifactRuntime(new Uint8Array(32).fill(1), 'machine');
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = withMachineLock(join(settings.happyHomeDir, 'artifact-workspaces'), async () => { started(); await new Promise<void>(resolve => { release = resolve; }); });
  await ready;
  let store;
  try { store = await runtime.getStore(); } finally { release(); await held; }
  let watcher: { dispose(): void } | undefined;
  const event = new Promise<any>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Missing artifact invalidation event')), 5000);
    watcher = watchArtifactChanges(runtime.getStore, events => { clearTimeout(deadline); resolve(events); });
  });
  try {
    const artifact = await store!.register({ root, entryPath: 'a.md', managedPaths: ['a.md'], operationId: 'register' });
    expect((await event)[0]).toMatchObject({ artifactId: artifact.id, currentVersionId: artifact.currentVersionId });
  } finally { watcher?.dispose(); }
});
it('publishes a catalog replacement after its writer releases the lock, without requiring another write', async () => {
  directory = await mkdtemp(join(tmpdir(), 'paws-version-unlock-'));settings.happyHomeDir=join(directory,'home');await mkdir(settings.happyHomeDir);
  const root=join(directory,'project');await mkdir(root);await writeFile(join(root,'a.md'),'one');
  const runtime=createArtifactRuntime(new Uint8Array(32).fill(2),'machine');const store=await runtime.getStore();
  const artifact=await store.register({root,entryPath:'a.md',managedPaths:['a.md'],operationId:'register'});
  const events:any[]=[];let baseline!:()=>void,changed!:()=>void;
  const initial=new Promise<void>(r=>{baseline=r;});const delivered=new Promise<void>(r=>{changed=r;});
  const watcher=watchArtifactChanges(runtime.getStore,value=>{events.push(...value);if(value.some(e=>e.sequence===1))baseline();if(value.some(e=>e.sequence===2))changed();});
  await initial;
  const original=store.invalidations.bind(store);let attempted!:()=>void;const observed=new Promise<void>(r=>{attempted=r;});
  vi.spyOn(store,'invalidations').mockImplementation(async()=>{try{return await original();}catch(error){if(error instanceof ArtifactError&&error.code==='WRITER_ACTIVE')attempted();throw error;}});
  let release: (()=>void) | undefined;const storage=join(settings.happyHomeDir,'artifact-workspaces');
  let replaced!:()=>void;const replacement=new Promise<void>(r=>{replaced=r;});
  let held: Promise<void> | undefined;
  try {
    held=withMachineLock(storage,async()=>{const wait=new Promise<void>(r=>{release=r;});const db=JSON.parse(await readFile(join(storage,'catalog.json'),'utf8'));db.workspaces[0].changes[0].sequence=2;await atomicFile(join(storage,'catalog.json'),JSON.stringify(db));replaced();await wait;});
    // Linux can report lock-owner creation before the lock callback starts.
    // Wait for the replacement itself, rather than assuming any read means the
    // writer has installed its release handle and finished replacing the catalog.
    await Promise.race([replacement, held.then(()=>{throw new Error('Writer exited before replacing the catalog');})]);
    await observed;const notifiedWhileLocked=events.some(e=>e.sequence===2);release!();await held;
    await delivered;expect(notifiedWhileLocked).toBe(false);expect(events.filter(e=>e.sequence===2)).toHaveLength(1);expect(events[0].artifactId).toBe(artifact.id);
  } finally {release?.();try{await held;}finally{watcher.dispose();}}
});
