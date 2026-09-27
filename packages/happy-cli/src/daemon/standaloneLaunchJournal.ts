/** Daemon exclusive lock must own this single-writer store. Verified pairs may be archived; no PID signalling. */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// Same SID/ancestor policy as Desktop windowsSecretAcl; this store owns no credential contents.
const ACL_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SAYCODE_ACL_PATH))
$path=[IO.Path]::GetFullPath($path)
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User
$allowed=@($sid.Value,'S-1-5-18') | Select-Object -Unique
$trusted=@($sid.Value,'S-1-5-18','S-1-5-32-544',([Security.Principal.NTAccount]::new('NT SERVICE','TrustedInstaller')).Translate([Security.Principal.SecurityIdentifier]).Value)
function Assert-Ancestor($info, [bool]$root) {
  if ($info.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Credential ancestor has an untrusted owner' }
  $danger=[Security.AccessControl.FileSystemRights]'DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'
  if (-not $root) { $danger=$danger -bor [Security.AccessControl.FileSystemRights]::Delete }
  foreach ($rule in $info.GetAccessControl().GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted -and ($rule.FileSystemRights -band $danger)) { throw 'Credential ancestor permits replacement by another principal' }
  }
}
function Assert-Chain([string]$target) {
  for ($p=$target; $p; $p=[IO.Path]::GetDirectoryName($p)) {
    if (Test-Path -LiteralPath $p) {
      $item=Get-Item -LiteralPath $p -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not credential storage' }
      if ($p -ne $target) { Assert-Ancestor $item ($p -eq [IO.Path]::GetPathRoot($p)) }
    }
    if ($p -eq [IO.Path]::GetPathRoot($p)) { break }
  }
}
function Assert-Owner($info) {
  $owner=$info.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $sid.Value -and $owner -ne $identity.Owner.Value) { throw 'Credential storage has a different owner' }
}
function New-Security([bool]$directory, [bool]$creating) {
  if ($directory) { $acl=[Security.AccessControl.DirectorySecurity]::new() }
  else { $acl=[Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true,$false)
  if ($creating) { $acl.SetOwner($sid) }
  $inherit=[Security.AccessControl.InheritanceFlags]::None
  if ($directory) { $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
  foreach ($principal in $allowed) {
    $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($principal),[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  return $acl
}
function Assert-Security($info) {
  $acl=$info.GetAccessControl()
  if (-not $acl.AreAccessRulesProtected) { throw 'Credential ACL still inherits access' }
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne $allowed.Count) { throw 'Unexpected credential ACL rule count' }
  if (@($rules.IdentityReference.Value | Select-Object -Unique).Count -ne $allowed.Count) { throw 'Missing credential principal' }
  $inherit=[Security.AccessControl.InheritanceFlags]::None
  if ($info -is [IO.DirectoryInfo]) { $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -notin $allowed -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { throw 'Unexpected credential access rule' }
    if ($rule.InheritanceFlags -ne $inherit -or $rule.PropagationFlags -ne 'None') { throw 'Unexpected credential inheritance' }
  }
}
Assert-Chain $path

if ($path -eq [IO.Path]::GetPathRoot($path) -or $path.TrimEnd('\') -eq [Environment]::GetFolderPath('UserProfile').TrimEnd('\')) { throw 'Unsafe journal root' }
$info=[IO.DirectoryInfo]::new($path)
if ($info.Exists) {
 Assert-Owner $info
 if ($env:SAYCODE_ACL_INITIALIZE -eq '1') { $info.SetAccessControl((New-Security $true $false)) }
} elseif ($env:SAYCODE_ACL_INITIALIZE -eq '1') { $info.Create((New-Security $true $true)) }
else { throw 'Journal directory disappeared' }
Assert-Chain $path
Assert-Security $info
$entries=@($info.GetFileSystemInfos())
$archive=[IO.DirectoryInfo]::new([IO.Path]::Combine($path,'completed'))
if ($archive.Exists) {
 if ($archive.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Invalid archive directory' }
 Assert-Owner $archive
 Assert-Security $archive
 $entries=@($entries | Where-Object { $_.FullName -ne $archive.FullName })
 if ($env:SAYCODE_ACL_INITIALIZE -eq '1') { $entries += @($archive.GetFileSystemInfos()) }
 else {
  # Validate precisely the archives that this operation may use, not lifetime history.
  $ids=@($env:SAYCODE_ACL_ARCHIVE_ID)
  foreach ($entry in $entries) {
   if ($entry.Name -match '^([a-z0-9][a-z0-9-]{0,63})(\.done)?\.json$') { $ids += $Matches[1] }
  }
  foreach ($id in @($ids | Where-Object { $_ } | Select-Object -Unique)) {
   $candidatePath=[IO.Path]::Combine($archive.FullName,($id+'.json'))
   if (Test-Path -LiteralPath $candidatePath) { $entries += Get-Item -LiteralPath $candidatePath -Force }
  }
 }
}
foreach ($file in $entries) {
 if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint -or $file -isnot [IO.FileInfo]) { throw 'Invalid journal entry' }
 Assert-Owner $file
 $rules=@($file.GetAccessControl().GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 if ($rules.Count -ne $allowed.Count -or @($rules.IdentityReference.Value | Select-Object -Unique).Count -ne $allowed.Count) { throw 'Unexpected journal file ACL' }
 foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') { throw 'Unsafe journal file ACL' }
 }
}
`;
const execFileAsync = promisify(execFile);
async function protectDirectory(directory: string, initialize = false, archiveId = '') {
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(directory)) throw new Error('Journal requires an absolute local path');
    try {
      await execFileAsync(win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64')], {
          windowsHide: true, timeout: 15000, maxBuffer: 32768,
          env: { ...process.env, SAYCODE_ACL_PATH: Buffer.from(directory).toString('base64'), SAYCODE_ACL_INITIALIZE: initialize ? '1' : '0', SAYCODE_ACL_ARCHIVE_ID: archiveId },
        });
    } catch { throw new Error('Standalone journal ACL protection failed'); }
  } else {
    try { if (initialize) mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(directory);
    if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error('Journal directory must be private');
  }
}
/** Native observations live beside, never inside, the strict journal namespace. */
export async function protectStandaloneObservationDirectory(directory: string, initialize = false): Promise<void> {
  if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error('Invalid observation directory');
  await protectDirectory(directory, initialize);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid observation directory');
}
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const baseRecord = { version: z.literal(1), instanceId: id, launchId: id };
const recordSchema = z.discriminatedUnion('kind', [
  z.object({ ...baseRecord, kind: z.literal('intent') }).strict(),
  z.object({ ...baseRecord, kind: z.literal('completed') }).strict(),
  z.object({ ...baseRecord, kind: z.literal('ended'), rootExit: z.number().int().min(0).max(0xffffffff) }).strict(),
  z.object({ ...baseRecord, kind: z.literal('not-launched') }).strict(),
  z.object({ ...baseRecord, kind: z.literal('rolled-back'), rootExit: z.number().int().min(0).max(0xffffffff) }).strict(),
  z.object({ ...baseRecord, kind: z.literal('owner-terminated'), rootExit: z.number().int().min(0).max(0xffffffff) }).strict(),
]);
type Record = z.infer<typeof recordSchema>;
const proofSchema = z.object({ stored: z.literal(true), runtimeExited: z.literal(true), jobEmpty: z.literal(true) }).strict();

export class StandaloneLaunchJournal {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private readonly directory: string, private readonly identity: string, private readonly archiveIdentity: string) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  private static identity(directory: string) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid journal directory');
    return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
  }
  static async open(directory: string) {
    if (!isAbsolute(directory) || resolve(directory) !== directory) throw new Error('Invalid journal path');
    await protectDirectory(directory, true);
    const archive = join(directory, 'completed');
    await protectDirectory(archive, true);
    return new StandaloneLaunchJournal(directory, this.identity(directory), this.identity(archive));
  }
  private async check(launchId?: string) {
    if (launchId !== undefined) id.parse(launchId);
    if (StandaloneLaunchJournal.identity(this.directory) !== this.identity) throw new Error('Journal directory was replaced');
    if (StandaloneLaunchJournal.identity(join(this.directory, 'completed')) !== this.archiveIdentity) throw new Error('Journal archive was replaced');
    await protectDirectory(this.directory, false, launchId);
    if (process.platform !== 'win32') await protectDirectory(join(this.directory, 'completed'));
    if (StandaloneLaunchJournal.identity(this.directory) !== this.identity) throw new Error('Journal directory was replaced');
  }
  private file(launchId: string, completed = false) { return join(this.directory, `${id.parse(launchId)}${completed ? '.done' : ''}.json`); }
  private readData(path: string): unknown {
    const fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size > 4096) throw new Error('Invalid journal record');
      return JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
  }
  private read(path: string): Record { return recordSchema.parse(this.readData(path)); }
  private syncDirectory(path: string) {
    if (process.platform === 'win32') return; // Windows power-loss durability is not claimed.
    const fd = openSync(path, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  private write(path: string, record: unknown) {
    const fd = openSync(path, 'wx', 0o600);
    // A crash/failed write leaves an unknown entry; never erase it to permit a second launch.
    const contents = JSON.stringify(record);
    try { writeFileSync(fd, contents); fsyncSync(fd); }
    finally { closeSync(fd); }
    this.syncDirectory(dirname(path));
    if (JSON.stringify(this.readData(path)) !== contents) throw new Error('Journal readback mismatch');
  }
  private archived(launchId: string): { intent: Record; completion: Record } | null {
    let raw: unknown;
    try { raw = this.readData(join(this.directory, 'completed', `${id.parse(launchId)}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const pair = z.object({ version: z.literal(1), intent: recordSchema, completion: recordSchema }).strict().parse(raw);
    if (pair.intent.kind !== 'intent' || pair.completion.kind === 'intent' || pair.intent.launchId !== launchId
      || pair.completion.launchId !== launchId || pair.intent.instanceId !== pair.completion.instanceId) throw new Error('Invalid journal archive');
    return pair;
  }
  private publishArchive(launchId: string, pair: { intent: Record; completion: Record }) {
    const directory = join(this.directory, 'completed');
    const temporary = join(directory, `.${launchId}-${randomUUID()}.tmp`);
    const final = join(directory, `${launchId}.json`);
    // A crash before rename leaves only an unpublished file, never a partial final proof.
    this.write(temporary, { version: 1, ...pair });
    try { lstatSync(final); throw new Error('Journal archive already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    renameSync(temporary, final); // Exclusive daemon lock rules out competing publishers.
    this.syncDirectory(directory);
    if (!this.archived(launchId)) throw new Error('Journal archive publication failed');
  }
  private compact() {
    for (const name of readdirSync(this.directory)) {
      if (name === 'completed') continue;
      let record: Record;
      try { record = this.read(join(this.directory, name)); } catch { continue; }
      if (name !== `${record.launchId}${record.kind !== 'intent' ? '.done' : ''}.json`) continue;
      let pair = this.archived(record.launchId);
      if (!pair) {
        if (record.kind !== 'intent') continue;
        let completion: Record;
        try { completion = this.read(this.file(record.launchId, true)); } catch { continue; }
        if (completion.kind === 'intent' || completion.launchId !== record.launchId || completion.instanceId !== record.instanceId) continue;
        pair = { intent: record, completion };
        this.publishArchive(record.launchId, pair);
      }
      // Only remove an active record whose exact original evidence is already durable.
      let releasedIntent = false;
      for (const expected of [pair.intent, pair.completion]) {
        const path = this.file(expected.launchId, expected.kind !== 'intent');
        let current: Record;
        try { current = this.read(path); } catch { continue; }
        if (JSON.stringify(current) !== JSON.stringify(expected)) continue;
        unlinkSync(path);
        this.syncDirectory(this.directory);
        if (expected.kind === 'intent') releasedIntent = true;
      }
      if (releasedIntent) return; // Reclaim only the slot needed by this reservation.
    }
  }
  reserve(instanceId: string, launchId: string) { return this.serial(() => this.reserveRecord(instanceId, launchId)); }
  complete(instanceId: string, launchId: string, evidence: { stored: boolean; runtimeExited: boolean; jobEmpty: boolean }) {
    return this.serial(() => {
      proofSchema.parse(evidence);
      return this.finishRecord({ version: 1, instanceId, launchId, kind: 'completed' });
    });
  }
  end(instanceId: string, launchId: string, evidence: { runtimeExited: boolean; jobEmpty: boolean; rootExit: number }) {
    return this.serial(() => {
      z.object({ runtimeExited: z.literal(true), jobEmpty: z.literal(true), rootExit: z.number().int().min(0).max(0xffffffff) }).strict().parse(evidence);
      return this.finishRecord({ version: 1, instanceId, launchId, kind: 'ended', rootExit: evidence.rootExit });
    });
  }
  terminate(instanceId: string, launchId: string, evidence: { runtimeExited: boolean; jobEmpty: boolean; ownerTerminated: boolean; rootExit: number }) {
    return this.serial(() => {
      z.object({ runtimeExited: z.literal(true), jobEmpty: z.literal(true), ownerTerminated: z.literal(true),
        rootExit: z.number().int().min(0).max(0xffffffff) }).strict().parse(evidence);
      return this.finishRecord({ version: 1, instanceId, launchId, kind: 'owner-terminated', rootExit: evidence.rootExit });
    });
  }
  rollback(instanceId: string, launchId: string, evidence: { runtimeExited: boolean; jobEmpty: boolean; resumed: boolean; forced: boolean; rootExit: number }) {
    return this.serial(() => {
      z.object({ runtimeExited: z.literal(true), jobEmpty: z.literal(true), resumed: z.literal(false),
        forced: z.literal(true), rootExit: z.number().int().min(0).max(0xffffffff) }).strict().parse(evidence);
      return this.finishRecord({ version: 1, instanceId, launchId, kind: 'rolled-back', rootExit: evidence.rootExit });
    });
  }
  notLaunched(instanceId: string, launchId: string, evidence: { processCreated: boolean }) {
    return this.serial(() => {
      z.object({ processCreated: z.literal(false) }).strict().parse(evidence);
      return this.finishRecord({ version: 1, instanceId, launchId, kind: 'not-launched' });
    });
  }
  pendingRecords() { return this.serial(() => this.pendingRecordSnapshot()); }
  snapshot(instanceId: string) { return this.serial(() => this.snapshotRecords(instanceId)); }
  private async reserveRecord(instanceId: string, launchId: string) {
    const record = recordSchema.parse({ version: 1, instanceId, launchId, kind: 'intent' });
    await this.check(launchId);
    const count = () => readdirSync(this.directory).filter(name => name !== 'completed' && !name.endsWith('.done.json')).length;
    if (count() >= 256) this.compact();
    if (count() >= 256) throw new Error('Journal capacity exceeded');
    if (this.archived(launchId)) throw new Error('Journal completion already archived');
    try { lstatSync(this.file(launchId, true)); throw new Error('Journal completion already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.write(this.file(launchId), record);
  }
  private async finishRecord(raw: Record) {
    const record = recordSchema.parse(raw);
    if (record.kind === 'intent') throw new Error('Invalid completion');
    const { instanceId, launchId } = record;
    await this.check(launchId);
    const same = (previous: Record) => {
      if (JSON.stringify(previous) !== JSON.stringify(record)) throw new Error('Journal completion mismatch');
    };
    const archived = this.archived(launchId);
    if (archived) {
      if (archived.intent.instanceId !== instanceId) throw new Error('Journal ownership mismatch');
      same(archived.completion);
      return;
    }
    const intent = this.read(this.file(launchId));
    if (intent.kind !== 'intent' || intent.instanceId !== instanceId || intent.launchId !== launchId) throw new Error('Journal ownership mismatch');
    const path = this.file(launchId, true);
    try { this.write(path, record); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      same(this.read(path));
    }
  }
  private async pendingRecordSnapshot() {
    await this.check();
    const intents = new Map<string, Record>(), completions = new Map<string, Record>();
    let unresolved = false;
    for (const name of readdirSync(this.directory)) {
      if (name === 'completed') continue;
      try {
        const record = this.read(join(this.directory, name));
        const expected = `${record.launchId}${record.kind !== 'intent' ? '.done' : ''}.json`;
        if (name !== expected) throw new Error('Journal name mismatch');
        const archived = this.archived(record.launchId);
        if (archived) {
          if (JSON.stringify(record) !== JSON.stringify(record.kind === 'intent' ? archived.intent : archived.completion)) unresolved = true;
          continue;
        }
        (record.kind === 'intent' ? intents : completions).set(record.launchId, record);
      } catch { unresolved = true; }
    }
    const records: { instanceId: string; launchId: string }[] = [];
    for (const [launchId, intent] of intents) {
      const done = completions.get(launchId);
      if (done && done.instanceId === intent.instanceId) continue;
      if (done) unresolved = true;
      records.push({ instanceId: intent.instanceId, launchId });
    }
    for (const launchId of completions.keys()) if (!intents.has(launchId)) unresolved = true;
    return { records: records.sort((a, b) => a.launchId < b.launchId ? -1 : a.launchId > b.launchId ? 1 : 0), unresolved };
  }
  private async snapshotRecords(instanceId: string) {
    id.parse(instanceId);
    const pending = await this.pendingRecordSnapshot();
    return { launchIds: pending.records.filter(record => record.instanceId === instanceId).map(record => record.launchId),
      unresolved: pending.unresolved || pending.records.some(record => record.instanceId !== instanceId) };
  }
}
