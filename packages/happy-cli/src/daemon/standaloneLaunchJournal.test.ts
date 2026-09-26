import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { StandaloneLaunchJournal } from './standaloneLaunchJournal';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) };
});
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(){const root=mkdtempSync(join(tmpdir(),'standalone-journal-'));roots.push(root);const directory=join(root,'launches');return {directory,journal:await StandaloneLaunchJournal.open(directory)};}
const proof={stored:true,runtimeExited:true,jobEmpty:true};
it('keeps pending ownership across reopen and blocks another daemon generation',async()=>{
  const {journal,directory}=await fixture();await journal.reserve('instance-a','launch-a');
  const reopened=await StandaloneLaunchJournal.open(directory);
  expect(await reopened.snapshot('instance-a')).toEqual({launchIds:['launch-a'],unresolved:false});
  expect(await reopened.snapshot('instance-b')).toEqual({launchIds:[],unresolved:true});
});
it('retains the original intent after verified completion',async()=>{
  const {journal,directory}=await fixture();await journal.reserve('instance-a','launch-a');
  const intent=readFileSync(join(directory,'launch-a.json'),'utf8');
  await journal.complete('instance-a','launch-a',proof);
  expect(await journal.snapshot('instance-a')).toEqual({launchIds:[],unresolved:false});
  expect(readFileSync(join(directory,'launch-a.json'),'utf8')).toBe(intent);
  await expect(journal.reserve('instance-a','launch-a')).rejects.toThrow();
});
it.each(['stored','runtimeExited','jobEmpty'] as const)('does not persist completion without %s',async field=>{
  const {journal}=await fixture();await journal.reserve('instance-a','launch-a');
  await expect(journal.complete('instance-a','launch-a',{...proof,[field]:false})).rejects.toThrow();
  expect(await journal.snapshot('instance-a')).toEqual({launchIds:['launch-a'],unresolved:false});
});
it('blocks partial writes and orphan completion files instead of treating them as empty',async()=>{
  const {journal,directory}=await fixture();writeFileSync(join(directory,'broken.json'),'');
  expect((await journal.snapshot('instance-a')).unresolved).toBe(true);
  rmSync(join(directory,'broken.json'));
  writeFileSync(join(directory,'orphan.done.json'),JSON.stringify({version:1,instanceId:'instance-a',launchId:'orphan',kind:'completed'}));
  expect((await journal.snapshot('instance-a')).unresolved).toBe(true);
});
it('rejects another instance completion and path-shaped identifiers',async()=>{
  const {journal}=await fixture();await journal.reserve('instance-a','launch-a');
  await expect(journal.complete('instance-b','launch-a',proof)).rejects.toThrow();
  await expect(journal.reserve('instance-a','../outside')).rejects.toThrow();
  await expect(journal.reserve('instance-a','LAUNCH')).rejects.toThrow();
});
it('rejects linked records and preserves them for diagnosis',async()=>{
  const {journal,directory}=await fixture();await journal.reserve('instance-a','launch-a');
  linkSync(join(directory,'launch-a.json'),join(directory,'alias.json'));
  expect((await journal.snapshot('instance-a')).unresolved).toBe(true);
  await expect(journal.complete('instance-a','launch-a',proof)).rejects.toThrow();
});
it('cannot reuse an orphan completion to hide a newly reserved launch',async()=>{
  const {journal,directory}=await fixture();
  writeFileSync(join(directory,'launch-a.done.json'),JSON.stringify({version:1,instanceId:'instance-a',launchId:'launch-a',kind:'completed'}));
  await expect(journal.reserve('instance-a','launch-a')).rejects.toThrow();
  expect((await journal.snapshot('instance-a')).unresolved).toBe(true);
});

it('archives verified pairs to allow more than 256 lifetime launches without losing evidence',async()=>{
  const {journal,directory}=await fixture();
  for(let i=0;i<256;i++){
    const intent={version:1,instanceId:'instance-a',launchId:`launch-${i}`,kind:'intent'};
    writeFileSync(join(directory,`launch-${i}.json`),JSON.stringify(intent),{mode:0o600});
    writeFileSync(join(directory,`launch-${i}.done.json`),JSON.stringify({...intent,kind:'completed'}),{mode:0o600});
  }
  await journal.reserve('instance-a','next');
  expect(await journal.snapshot('instance-a')).toEqual({launchIds:['next'],unresolved:false});
  const archived=JSON.parse(readFileSync(join(directory,'completed','launch-0.json'),'utf8'));
  expect(archived.intent.kind).toBe('intent');expect(archived.completion.kind).toBe('completed');
  await expect(journal.reserve('instance-a','launch-0')).rejects.toThrow();
  // Crash after archive publication but before both active records were removed.
  writeFileSync(join(directory,'launch-0.done.json'),JSON.stringify(archived.completion),{mode:0o600});
  expect(await journal.snapshot('instance-a')).toEqual({launchIds:['next'],unresolved:false});
});

it('ignores an unpublished archive left by a crash and preserves the active proof',async()=>{
  const {journal,directory}=await fixture();await journal.reserve('instance-a','launch-a');await journal.complete('instance-a','launch-a',proof);
  writeFileSync(join(directory,'completed','.launch-a-interrupted.tmp'),'');
  expect(await journal.snapshot('instance-a')).toEqual({launchIds:[],unresolved:false});
});
it('can finish a new launch after a crash left an archived completion in the active directory',async()=>{
  const {journal,directory}=await fixture();
  const intent={version:1,instanceId:'instance-a',launchId:'archived',kind:'intent'};
  const completion={...intent,kind:'completed'};
  writeFileSync(join(directory,'completed','archived.json'),JSON.stringify({version:1,intent,completion}),{mode:0o600});
  writeFileSync(join(directory,'archived.done.json'),JSON.stringify(completion),{mode:0o600});
  for(let i=0;i<255;i++){
    const pending={...intent,launchId:`launch-${i}`};
    writeFileSync(join(directory,`launch-${i}.json`),JSON.stringify(pending),{mode:0o600});
    writeFileSync(join(directory,`launch-${i}.done.json`),JSON.stringify({...pending,kind:'completed'}),{mode:0o600});
  }
  await journal.reserve('instance-a','next');await journal.complete('instance-a','next',proof);
  expect(await journal.snapshot('instance-a')).toEqual({launchIds:[],unresolved:false});
  await journal.reserve('instance-a','another');
});

it('recovers when archive publication fails after creating an empty file',async()=>{
  const {journal,directory}=await fixture();
  for(let i=0;i<256;i++){
    const intent={version:1,instanceId:'instance-a',launchId:`launch-${i}`,kind:'intent'};
    writeFileSync(join(directory,`launch-${i}.json`),JSON.stringify(intent),{mode:0o600});
    writeFileSync(join(directory,`launch-${i}.done.json`),JSON.stringify({...intent,kind:'completed'}),{mode:0o600});
  }
  vi.mocked(writeFileSync).mockImplementationOnce(()=>{throw new Error('simulated archive write failure')});
  await expect(journal.reserve('instance-a','next')).rejects.toThrow('simulated archive write failure');
  expect(await journal.snapshot('instance-a')).toEqual({launchIds:[],unresolved:false});
  await journal.reserve('instance-a','next');
  expect(await journal.snapshot('instance-a')).toEqual({launchIds:['next'],unresolved:false});
});

it.skipIf(process.platform==='win32')('rejects a FIFO without blocking journal inspection',async()=>{
  const {journal,directory}=await fixture();execFileSync('mkfifo',[join(directory,'pipe.json')]);
  expect(await journal.snapshot('instance-a')).toEqual({launchIds:[],unresolved:true});
});
it('keeps an archived completion idempotent but rejects another owner',async()=>{
  const {journal,directory}=await fixture();
  const intent={version:1,instanceId:'instance-a',launchId:'archived',kind:'intent'};
  const completion={...intent,kind:'completed'};
  writeFileSync(join(directory,'completed','archived.json'),JSON.stringify({version:1,intent,completion}),{mode:0o600});
  await journal.complete('instance-a','archived',proof);
  await expect(journal.complete('instance-b','archived',proof)).rejects.toThrow('ownership mismatch');
  writeFileSync(join(directory,'archived.json'),JSON.stringify({...intent,instanceId:'instance-b'}),{mode:0o600});
  expect((await journal.snapshot('instance-b')).unresolved).toBe(true);
});

it('records an observed ordinary end without calling it a stored drain', async () => {
  const { journal, directory } = await fixture();
  await journal.reserve('instance-a', 'ordinary');
  await journal.end('instance-a', 'ordinary', { runtimeExited: true, jobEmpty: true, rootExit: 1 });
  expect(await journal.snapshot('instance-a')).toEqual({ launchIds: [], unresolved: false });
  expect(JSON.parse(readFileSync(join(directory, 'ordinary.done.json'), 'utf8'))).toMatchObject({ kind: 'ended', rootExit: 1 });
  await expect(journal.complete('instance-a', 'ordinary', proof)).rejects.toThrow('completion mismatch');
});
it('keeps an ordinary end unresolved when descendants remain', async () => {
  const { journal } = await fixture(); await journal.reserve('instance-a', 'ordinary');
  await expect(journal.end('instance-a', 'ordinary', { runtimeExited: true, jobEmpty: false, rootExit: 0 })).rejects.toThrow();
  expect(await journal.snapshot('instance-a')).toEqual({ launchIds: ['ordinary'], unresolved: false });
});
it('retains an explicit no-process outcome instead of leaking a failed spawn reservation', async () => {
  const { journal, directory } = await fixture(); await journal.reserve('instance-a', 'missing');
  await journal.notLaunched('instance-a', 'missing', { processCreated: false });
  expect(await journal.snapshot('instance-a')).toEqual({ launchIds: [], unresolved: false });
  expect(JSON.parse(readFileSync(join(directory, 'missing.done.json'), 'utf8'))).toMatchObject({ kind: 'not-launched' });
});

it('records a rolled-back suspended process without claiming no process or storage', async () => {
  const { journal, directory } = await fixture(); await journal.reserve('instance-a', 'rollback');
  const evidence = { runtimeExited: true, jobEmpty: true, resumed: false, forced: true, rootExit: 125 };
  await journal.rollback('instance-a', 'rollback', evidence);
  expect(JSON.parse(readFileSync(join(directory, 'rollback.done.json'), 'utf8'))).toMatchObject({ kind: 'rolled-back', rootExit: 125 });
  expect(await journal.snapshot('instance-a')).toEqual({ launchIds: [], unresolved: false });
  await expect(journal.notLaunched('instance-a', 'rollback', { processCreated: false })).rejects.toThrow('completion mismatch');
  await expect(journal.complete('instance-a', 'rollback', proof)).rejects.toThrow('completion mismatch');
});
it.each([{ resumed: true }, { forced: false }, { jobEmpty: false }])('rejects incomplete rollback evidence %j', async change => {
  const { journal } = await fixture(); await journal.reserve('instance-a', 'rollback');
  await expect(journal.rollback('instance-a', 'rollback', { runtimeExited: true, jobEmpty: true, resumed: false, forced: true, rootExit: 125, ...change })).rejects.toThrow();
  expect((await journal.snapshot('instance-a')).launchIds).toEqual(['rollback']);
});

it('lists all pending generations for native reconciliation without claiming foreign ownership', async () => {
  const { journal } = await fixture(); await journal.reserve('instance-a', 'first'); await journal.reserve('instance-b', 'second');
  expect(await journal.pendingRecords()).toEqual({ records: [{ instanceId: 'instance-a', launchId: 'first' },
    { instanceId: 'instance-b', launchId: 'second' }], unresolved: false });
  expect((await journal.snapshot('instance-a')).unresolved).toBe(true);
  await journal.end('instance-b', 'second', { runtimeExited: true, jobEmpty: true, rootExit: 0 });
  expect(await journal.pendingRecords()).toEqual({ records: [{ instanceId: 'instance-a', launchId: 'first' }], unresolved: false });
});
it('keeps corruption visible to the pending-record reconciliation reader', async () => {
  const { journal, directory } = await fixture(); writeFileSync(join(directory, 'broken.json'), '{');
  expect(await journal.pendingRecords()).toEqual({ records: [], unresolved: true });
});
it('records explicit owner termination without allowing a stored completion upgrade', async () => {
  const { journal, directory } = await fixture(); await journal.reserve('instance-a', 'terminated');
  const evidence = { runtimeExited: true, jobEmpty: true, ownerTerminated: true, rootExit: 125 };
  await expect(journal.terminate('instance-a', 'terminated', { ...evidence, ownerTerminated: false })).rejects.toThrow();
  await journal.terminate('instance-a', 'terminated', evidence);
  expect(JSON.parse(readFileSync(join(directory, 'terminated.done.json'), 'utf8'))).toMatchObject({ kind: 'owner-terminated', rootExit: 125 });
  expect(await journal.pendingRecords()).toEqual({ records: [], unresolved: false });
  await expect(journal.complete('instance-a', 'terminated', proof)).rejects.toThrow('completion mismatch');
});
