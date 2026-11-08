import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve, relative } from 'node:path';
import { lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import { ArtifactRequests, ARTIFACT_LIMITS, ARTIFACT_PROTOCOL, type Artifact, type ArtifactChanged, type ArtifactManifest, type ArtifactMutationResult, type ArtifactReadRef, type ArtifactReadResult, type ArtifactRef, type ArtifactVersion } from '@slopus/happy-wire';
import { ArtifactError, atomicFile, atomicCreateFile, boundedRead, canonicalWriteTarget, digest, inside, intersects, normalized, ownedPath, ownerAlive, processOwner, syncDirectory, withMachineLock, type ProcessOwner, type MachineLockOptions } from './files';

type StoredVersion = { version: ArtifactVersion; manifest: ArtifactManifest };
type Record = { artifact: Artifact; versions: StoredVersion[]; reads: { id: string; expires: number; manifest: ArtifactManifest }[] };
type Operation = { signature: string; artifactId: string; status: 'pending' | 'committed' | 'failed'; result?: ArtifactMutationResult; before: ArtifactManifest; after: ArtifactManifest; nextArtifact: Artifact; version: ArtifactVersion; resolution?: { id: string; action: string }; };
type TerminalReceipt = { runId: string; owner: ProcessOwner; status: 'completed' | 'failed' | 'cancelled' };
type Lease = { writerOwners?: ProcessOwner[]; runId: string; owner: ProcessOwner; sessionId: string; prompt: string };
type CaptureFailure = { resolution?: { id: string; action: 'resume' | 'rollback' }; id: string; runId: string; prompt: string; snapshots: { artifactId: string; snapshot?: ArtifactManifest; base: StoredVersion }[] };
type Workspace = { captureFailure?: CaptureFailure; captureHistory?: { [id: string]: CaptureFailure & { resolutionId: string; action: string } };  id: string; root: string; accountScope: string; records: Record[]; operations: { [id: string]: Operation }; registrations: { [id: string]: { signature: string; artifactId: string } }; lease?: Lease; runs: { [id: string]: 'completed' | 'failed' | 'cancelled' }; sequence: number; changes?: ArtifactChanged[]; changed?: ArtifactChanged };
type Writer = Lease & { directory: string; accountScope: string; status?: 'completed' | 'failed' | 'cancelled' };
type Database = { schema: 1; workspaces: Workspace[]; writers: Writer[] };
export type ArtifactWorker = { pid: number; directory?: string; protocol?: number; sessionId?: string };
export type StoreOptions = { storage: string; accountScope: string; inventory: () => Promise<ArtifactWorker[]>; onChanged?: (event: ArtifactChanged) => void | Promise<void> };
type Register = import('zod').infer<typeof ArtifactRequests.artifactRegister>;
type Save = import('zod').infer<typeof ArtifactRequests.artifactSave>;
type Restore = import('zod').infer<typeof ArtifactRequests.artifactRestore>;
type Rename = import('zod').infer<typeof ArtifactRequests.artifactRename>;
const mime = (path: string) => ({ html: 'text/html', htm: 'text/html', md: 'text/markdown', markdown: 'text/markdown', css: 'text/css', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp' }[path.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream');
const manifest = (entryPath: string, files: ArtifactManifest['files']): ArtifactManifest => { files.sort((a, b) => a.path.localeCompare(b.path, 'en')); return { entryPath, files, digest: digest(JSON.stringify({ entryPath, files: files.map(({ path, sha256, size }) => ({ path, sha256, size })) })) }; };
const same = (a: ArtifactManifest, b: ArtifactManifest) => a.digest === b.digest;
const decodeText = (bytes: Buffer) => { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new ArtifactError('UNSUPPORTED_PREVIEW', 'Entry must be UTF-8 text'); } };

/** Filesystem-backed machine service. Every entry point shares the same cross-process lock. */
export class ArtifactStore {
  constructor(readonly options: StoreOptions) {
    if (!/^[a-f0-9]{64}$/.test(options.accountScope)) throw new ArtifactError('PERMISSION_DENIED', 'Invalid account scope');
  }
  private index() { return join(this.options.storage, 'catalog.json'); }
  private async load(): Promise<Database> {
    try { const db = JSON.parse(await readFile(this.index(), 'utf8')); if (db.schema !== 1 || !Array.isArray(db.workspaces)) throw new Error(); db.writers ??= []; return db; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 1, workspaces: [], writers: [] }; throw new ArtifactError('UNAVAILABLE', 'Version index is unavailable'); }
  }
  private persist(db: Database) { return atomicFile(this.index(), JSON.stringify(db)); }
  private locked<T>(body: (db: Database) => Promise<T>, options?: MachineLockOptions & { settleTerminals?: boolean }): Promise<T> {
    return withMachineLock(this.options.storage, async () => {
      const db = await this.load();
      if (options?.settleTerminals !== false) await this.settleTerminals(db);
      return body(db);
    }, { waitTimeoutMs: 5000, ...options });
  }
  private workspace(db: Database, workspaceId: string) {
    const ws = db.workspaces.find(w => w.id === workspaceId && w.accountScope === this.options.accountScope);
    if (!ws) throw new ArtifactError('NOT_FOUND', 'Workspace is not registered for this account');
    return ws;
  }
  private record(ws: Workspace, artifactId: string) {
    const record = ws.records.find(r => r.artifact.id === artifactId);
    if (!record) throw new ArtifactError('NOT_FOUND', 'Artifact is not registered');
    return record;
  }
  private objectPath(scope: string, hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ArtifactError('INCOMPLETE_VERSION', 'Invalid object digest');
    return join(this.options.storage, scope, 'objects', hash);
  }
  private async put(scope: string, bytes: Buffer) {
    const hash = digest(bytes), path = this.objectPath(scope, hash);
    try { const existing = await boundedRead(path, ARTIFACT_LIMITS.resourceBytes); if (digest(existing) !== hash) throw new ArtifactError('INCOMPLETE_VERSION', 'Stored resource digest mismatch'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await atomicFile(path, bytes); }
    return hash;
  }
  private async object(scope: string, file: ArtifactManifest['files'][number]) {
    try { const bytes = await boundedRead(this.objectPath(scope, file.sha256), ARTIFACT_LIMITS.resourceBytes); if (digest(bytes) !== file.sha256 || bytes.length !== file.size) throw new Error(); return bytes; }
    catch { throw new ArtifactError('INCOMPLETE_VERSION', 'Historical resource is missing or has a different digest'); }
  }
  private async capture(ws: Workspace, artifact: Artifact, requireEntry = true, validateText = true): Promise<ArtifactManifest> {
    const files: ArtifactManifest['files'] = [];
    let total = 0;
    for (const path of artifact.managedPaths) {
      try {
        const target = await ownedPath(ws.root, path);
        const bytes = await boundedRead(target, path === artifact.entryPath ? ARTIFACT_LIMITS.entryBytes : ARTIFACT_LIMITS.resourceBytes);
        const mode = (await lstat(target)).mode & 0o777;
        total += bytes.length;
        if (total > ARTIFACT_LIMITS.versionBytes) throw new ArtifactError('LIMIT_EXCEEDED', 'Managed set exceeds the version size limit');
        if (validateText && path === artifact.entryPath) decodeText(bytes);
        files.push({ path, sha256: await this.put(ws.accountScope, bytes), size: bytes.length, mode, mime: mime(path) });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (requireEntry && !files.some(f => f.path === artifact.entryPath)) throw new ArtifactError('NOT_FOUND', 'Entry was removed or moved outside its registered mapping');
    return manifest(artifact.entryPath, files);
  }
  private async stable(ws: Workspace, artifact: Artifact) {
    const before = await this.capture(ws, artifact), after = await this.capture(ws, artifact);
    if (!same(before, after)) throw new ArtifactError('READ_UNSTABLE', 'Managed files changed while freezing the read');
    return before;
  }
  private current(record: Record) { return record.versions.find(v => v.version.id === record.artifact.currentVersionId)!; }
  private pending(ws: Workspace) { return Object.entries(ws.operations).find(([, op]) => op.status === 'pending'); }
  private async inventory(root: string) {
    let workers: ArtifactWorker[];
    try { workers = await this.options.inventory(); } catch { throw new ArtifactError('UNAVAILABLE', 'Worker inventory is unavailable; managed writes are disabled'); }
    for (const worker of workers) {
      // Include idle legacy workers: a future input could otherwise bypass leases.
      if (!worker.directory) throw new ArtifactError('UNAVAILABLE', 'Worker write scope is unknown');
      let cwd: string; try { cwd = await realpath(worker.directory); } catch { throw new ArtifactError('UNAVAILABLE', 'Worker write scope cannot be verified'); }
      if (intersects(root, cwd) && worker.protocol !== ARTIFACT_PROTOCOL) throw new ArtifactError('UNAVAILABLE', 'An overlapping worker does not support managed version leases');
    }
  }
  private async leaseAlive(lease: Lease) {
    for (const owner of [lease.owner, ...(lease.writerOwners ?? [])]) if (await ownerAlive(owner)) return true;
    return false;
  }
  private async noWriter(ws: Workspace, allowPending = false) {
    await this.inventory(ws.root);
    if (ws.lease && await this.leaseAlive(ws.lease)) throw new ArtifactError('WRITER_ACTIVE', 'A managed agent turn is writing this workspace');
    if (ws.lease) delete ws.lease; // dead process, never a TTL assumption
    if (ws.captureFailure && !allowPending) throw new ArtifactError('COMMIT_PENDING', 'A terminal snapshot failed; inspect its recovery operation', ws.captureFailure.id);
    const pending = this.pending(ws);
    if (pending && !allowPending) throw new ArtifactError('COMMIT_PENDING', 'A previous commit requires recovery', pending[0]);
  }
  private version(record: Record, snapshot: ArtifactManifest, source: ArtifactVersion['source'], extra: Partial<ArtifactVersion> = {}): StoredVersion {
    return { manifest: snapshot, version: { id: randomUUID(), artifactId: record.artifact.id, sequence: record.versions.length + 1, createdAt: Date.now(), source, summary: source === 'restore' ? 'Restored historical content' : source === 'baseline' ? 'Registered baseline' : 'Updated managed files', parentVersionId: record.artifact.currentVersionId || undefined, manifestDigest: snapshot.digest, ...extra } };
  }
  private append(record: Record, version: StoredVersion) { record.versions.push(version); record.artifact.currentVersionId = version.version.id; }
  private changed(ws: Workspace, record: Record, revision: string, operationId?: string) {
    ws.changed = { workspaceId: ws.id, artifactId: record.artifact.id, currentVersionId: record.artifact.currentVersionId, workingRevision: revision, sequence: ++ws.sequence, ...(operationId ? { operationId } : {}) };
    ws.changes = [...(ws.changes ?? []).filter(c => c.artifactId !== record.artifact.id), ws.changed].slice(-64);
  }
  private async publish(ws: Workspace) { if (ws.changed) { try { await this.options.onChanged?.(ws.changed); } catch { /* invalidation is advisory; durable RPC remains authoritative */ } } }

  async invalidations() {
    // A catalog replacement can precede the end of a multi-artifact transaction.
    // Read-only checks do not create lock events or settle terminal receipts.
    const unlocked = async () => {
      try { await lstat(join(this.options.storage, 'machine.lock')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      throw new ArtifactError('WRITER_ACTIVE', 'Artifact invalidation awaits the writer release');
    };
    await unlocked(); const db = await this.load(); await unlocked();
    return db.workspaces.filter(w => w.accountScope === this.options.accountScope).flatMap(w => w.changes ?? (w.changed ? [w.changed] : []));
  }
  async catalog(workspaceId?: string) { return this.locked(async db => db.workspaces.filter(w => w.accountScope === this.options.accountScope && (!workspaceId || w.id === workspaceId)).map(w => ({ workspaceId: w.id, root: w.root, artifacts: w.records.map(r => r.artifact), changed: w.changed })), { settleTerminals: false }); }
  async register(input: Register): Promise<Artifact> {
    const data = ArtifactRequests.artifactRegister.parse(input);
    return this.locked(async db => {
      const root = await realpath(resolve(data.root));
      if (inside(root, this.options.storage) || inside(this.options.storage, root)) throw new ArtifactError('PATH_OUT_OF_BOUNDS', 'Version storage cannot be managed as an artifact');
      await this.inventory(root);
      let ws = db.workspaces.find(w => w.root === root && w.accountScope === this.options.accountScope);
      if (db.workspaces.some(w => w !== ws && intersects(w.root, root))) throw new ArtifactError('CONFLICT', 'This filesystem scope is already owned by another managed workspace');
      const signature = digest(JSON.stringify(data));
      if (ws?.registrations[data.operationId]) { const saved = ws.registrations[data.operationId]; if (saved.signature !== signature) throw new ArtifactError('CONFLICT', 'Operation ID was reused with different input'); return this.record(ws, saved.artifactId).artifact; }
      if (!ws) { ws = { id: randomUUID(), root, accountScope: this.options.accountScope, records: [], operations: {}, registrations: {}, runs: {}, sequence: 0 }; db.workspaces.push(ws); }
      await this.noWriter(ws);
      for (const writer of db.writers) if (!writer.status && intersects(root, writer.directory) && await this.leaseAlive(writer)) throw new ArtifactError('WRITER_ACTIVE', 'An existing managed turn overlaps this directory');
      const entryPath = normalized(data.entryPath), paths = [...new Set(data.managedPaths.map(normalized))].sort();
      if (!paths.includes(entryPath)) throw new ArtifactError('PATH_OUT_OF_BOUNDS', 'Managed set must contain the entry');
      if (ws.records.some(r => r.artifact.managedPaths.some(path => paths.includes(path)))) throw new ArtifactError('CONFLICT', 'A managed path is already owned by another editable artifact');
      const kind = /\.html?$/i.test(entryPath) ? 'html' : /\.(md|markdown)$/i.test(entryPath) ? 'markdown' : null;
      if (!kind) throw new ArtifactError('UNSUPPORTED_PREVIEW', 'Only HTML and Markdown entries are supported');
      const artifact: Artifact = { id: randomUUID(), workspaceId: ws.id, name: data.name ?? basename(entryPath), kind, entryPath, managedPaths: paths, currentVersionId: '' };
      const record: Record = { artifact, versions: [], reads: [] };
      const frozen = await this.stable(ws, artifact);
      this.append(record, this.version(record, frozen, 'baseline'));
      ws.records.push(record); ws.registrations[data.operationId] = { signature, artifactId: artifact.id };
      this.changed(ws, record, frozen.digest, data.operationId);
      await this.persist(db); await this.publish(ws); return artifact;
    });
  }
  async read(input: ArtifactRef & { versionId?: string }): Promise<ArtifactReadResult> {
    const data = ArtifactRequests.artifactRead.parse(input);
    return this.locked(async db => {
      const ws = this.workspace(db, data.workspaceId), record = this.record(ws, data.artifactId);
      let selected: StoredVersion | undefined, workingState: ArtifactReadResult['workingState'] = 'clean', readRef: ArtifactReadRef;
      if (data.versionId) selected = record.versions.find(v => v.version.id === data.versionId);
      else {
        selected = this.current(record);
        if (this.pending(ws) || ws.captureFailure) workingState = 'recovery-required';
        else if (ws.lease && await this.leaseAlive(ws.lease)) workingState = 'writing';
        else {
          const current = await this.stable(ws, record.artifact);
          if (!same(current, selected.manifest)) {
            workingState = 'dirty'; const readId = randomUUID();
            record.reads = record.reads.filter(r => r.expires > Date.now());
            record.reads.push({ id: readId, expires: Date.now() + 15 * 60 * 1000, manifest: current });
            selected = { version: selected.version, manifest: current };
            await this.persist(db);
            readRef = { kind: 'working', readId };
          }
        }
      }
      if (!selected) throw new ArtifactError('NOT_FOUND', 'Version not found');
      readRef ??= { kind: 'version', versionId: selected.version.id };
      const entry = selected.manifest.files.find(f => f.path === selected.manifest.entryPath);
      if (!entry) throw new ArtifactError('INCOMPLETE_VERSION', 'Historical entry is missing');
      // Verify the entire selected set; never fill historical gaps from working files.
      for (const file of selected.manifest.files) await this.object(ws.accountScope, file);
      return { artifact: record.artifact, manifest: selected.manifest, readRef, workingRevision: selected.manifest.digest, workingState, pendingOperationId: data.versionId ? undefined : (ws.captureFailure?.id ?? this.pending(ws)?.[0]), entryContent: decodeText(await this.object(ws.accountScope, entry)) };
    }, { settleTerminals: !data.versionId });
  }
  async resource(input: ArtifactRef & { readRef: ArtifactReadRef; path: string; offset: number; length: number }) {
    const data = ArtifactRequests.artifactResourceRead.parse(input);
    return this.locked(async db => {
      const ws = this.workspace(db, data.workspaceId), record = this.record(ws, data.artifactId);
      const ref = data.readRef;
      const snapshot = ref.kind === 'version' ? record.versions.find(v => v.version.id === ref.versionId)?.manifest : record.reads.find(r => r.id === ref.readId && r.expires > Date.now())?.manifest;
      const file = snapshot?.files.find(f => f.path === data.path);
      if (!file) throw new ArtifactError('NOT_FOUND', 'Resource or frozen read has expired or is not registered');
      const bytes = await this.object(ws.accountScope, file);
      return { content: bytes.subarray(data.offset, data.offset + data.length).toString('base64'), totalSize: bytes.length, sha256: file.sha256, offset: data.offset };
    }, { settleTerminals: false });
  }
  async versions(input: ArtifactRef & { cursor?: string }) {
    const data = ArtifactRequests.artifactVersions.parse(input);
    return this.locked(async db => {
      const record = this.record(this.workspace(db, data.workspaceId), data.artifactId);
      const reversed = [...record.versions].reverse();
      const offset = data.cursor ? reversed.findIndex(v => v.version.id === data.cursor) + 1 : 0;
      if (data.cursor && offset === 0) throw new ArtifactError('NOT_FOUND', 'Invalid history cursor');
      const page = reversed.slice(offset, offset + ARTIFACT_LIMITS.page);
      return { versions: page.map(v => v.version), currentVersionId: record.artifact.currentVersionId, nextCursor: reversed.length > offset + page.length ? page.at(-1)!.version.id : undefined };
    }, { settleTerminals: false });
  }
  private async checkpoint(db: Database, ws: Workspace, record: Record, before: ArtifactManifest) {
    if (!same(before, this.current(record).manifest)) { this.append(record, this.version(record, before, 'external')); this.changed(ws, record, before.digest); await this.persist(db); }
  }
  private checkedDuplicate(ws: Workspace, id: string, signature: string) {
    const op = ws.operations[id];
    if (!op) return undefined;
    if (op.signature !== signature) throw new ArtifactError('CONFLICT', 'Operation ID was reused with different input');
    if (op.status === 'pending') throw new ArtifactError('COMMIT_PENDING', 'Commit requires recovery', id);
    if (op.status === 'failed') throw new ArtifactError('CONFLICT', 'This operation was rolled back', id);
    return op.result!;
  }
  private async mutate<T extends { workspaceId: string; artifactId: string; operationId: string; expectedRevision: string }>(data: T, source: ArtifactVersion['source'], target: (ws: Workspace, record: Record, before: ArtifactManifest) => Promise<{ after: ArtifactManifest; artifact?: Artifact; extra?: Partial<ArtifactVersion> }>): Promise<ArtifactMutationResult> {
    return this.locked(db => this.mutateLocked(db, data, source, target));
  }
  private async mutateLocked<T extends { workspaceId: string; artifactId: string; operationId: string; expectedRevision: string }>(db: Database, data: T, source: ArtifactVersion['source'], target: (ws: Workspace, record: Record, before: ArtifactManifest) => Promise<{ after: ArtifactManifest; artifact?: Artifact; extra?: Partial<ArtifactVersion> }>): Promise<ArtifactMutationResult> {
      const ws = this.workspace(db, data.workspaceId), record = this.record(ws, data.artifactId), signature = digest(JSON.stringify({ source, data }));
      const duplicate = this.checkedDuplicate(ws, data.operationId, signature); if (duplicate) return duplicate;
      await this.noWriter(ws);
      const before = await this.stable(ws, record.artifact);
      if (before.digest !== data.expectedRevision) throw new ArtifactError('CONFLICT', 'Managed files changed; refresh before writing', undefined, before.digest);
      const next = await target(ws, record, before);
      await this.checkpoint(db, ws, record, before);
      if (same(before, next.after) && source !== 'restore' && !next.artifact) {
        const result = { version: this.current(record).version, workingRevision: before.digest, unchanged: true };
        ws.operations[data.operationId] = { signature, artifactId: record.artifact.id, status: 'committed', before, after: before, nextArtifact: record.artifact, version: result.version, result };
        await this.persist(db); return result;
      }
      const stored = this.version(record, next.after, source, next.extra);
      const op: Operation = { signature, artifactId: record.artifact.id, status: 'pending', before, after: next.after, nextArtifact: next.artifact ?? { ...record.artifact }, version: stored.version };
      ws.operations[data.operationId] = op;
      // Objects and intent are durable BEFORE the first working file is replaced.
      await this.persist(db);
      try { return await this.commit(db, ws, record, data.operationId, op); }
      catch (error) { if (error instanceof ArtifactError && error.code === 'CONFLICT') throw error; throw new ArtifactError('PARTIAL_COMMIT', 'Commit is incomplete; inspect the operation before retrying', data.operationId); }
  }
  private async validateSnapshot(ws: Workspace, snapshot: ArtifactManifest) {
    if (snapshot.files.length > ARTIFACT_LIMITS.files || snapshot.files.reduce((n, f) => n + f.size, 0) > ARTIFACT_LIMITS.versionBytes) throw new ArtifactError('LIMIT_EXCEEDED', 'Version exceeds supported limits');
    const entry = snapshot.files.find(f => f.path === snapshot.entryPath);
    if (!entry || entry.size > ARTIFACT_LIMITS.entryBytes) throw new ArtifactError('INCOMPLETE_VERSION', 'Invalid entry');
    for (const file of snapshot.files) await this.object(ws.accountScope, file);
  }
  async save(input: Save) {
    const data = ArtifactRequests.artifactSave.parse(input);
    return this.mutate(data, 'manual', (ws, record, before) => this.manualTarget(ws, record, before, data));
  }
  private async manualTarget(ws: Workspace, record: Record, before: ArtifactManifest, data: Save) {
      const files = [...before.files];
      const changes = [...(data.changes ?? []), { path: record.artifact.entryPath, content: Buffer.from(data.entryContent, 'utf8').toString('base64') }];
      for (const change of changes) {
        if (!record.artifact.managedPaths.includes(change.path)) throw new ArtifactError('PATH_OUT_OF_BOUNDS', 'Resource is not owned by this artifact');
        const i = files.findIndex(f => f.path === change.path), old = files[i];
        if (i !== -1) files.splice(i, 1);
        if (change.content !== null) {
          const bytes = Buffer.from(change.content, 'base64'), limit = change.path === record.artifact.entryPath ? ARTIFACT_LIMITS.entryBytes : ARTIFACT_LIMITS.resourceBytes;
          if (bytes.length > limit) throw new ArtifactError('LIMIT_EXCEEDED', 'File exceeds supported size');
          files.push({ path: change.path, sha256: await this.put(ws.accountScope, bytes), size: bytes.length, mode: old?.mode ?? 0o600, mime: mime(change.path) });
        }
      }
      const after = manifest(record.artifact.entryPath, files); await this.validateSnapshot(ws, after);
      return { after, extra: { prompt: data.prompt } };
  }
  async restore(input: Restore) {
    const data = ArtifactRequests.artifactRestore.parse(input);
    return this.mutate(data, 'restore', async (ws, record) => {
      const historical = record.versions.find(v => v.version.id === data.versionId);
      if (!historical) throw new ArtifactError('NOT_FOUND', 'Version not found');
      // Old names are mapped to the registered current entry after an explicit rename.
      const files = historical.manifest.files.map(f => f.path === historical.manifest.entryPath ? { ...f, path: record.artifact.entryPath } : f);
      if (files.some(f => !record.artifact.managedPaths.includes(f.path))) throw new ArtifactError('CONFLICT', 'Historical ownership differs from the current registered set');
      const after = manifest(record.artifact.entryPath, files); await this.validateSnapshot(ws, after);
      return { after, extra: { restoreFromVersionId: data.versionId } };
    });
  }
  private async observed(ws: Workspace, op: Operation) {
    const paths = [...new Set([...op.before.files, ...op.after.files].map(f => f.path))].sort();
    const states: { path: string; hash: string | null; known: boolean }[] = [];
    for (const path of paths) {
      let hash: string | null = null;
      try { hash = digest(await boundedRead(await ownedPath(ws.root, path), ARTIFACT_LIMITS.resourceBytes)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      states.push({ path, hash, known: [op.before.files.find(f => f.path === path)?.sha256 ?? null, op.after.files.find(f => f.path === path)?.sha256 ?? null].includes(hash) });
    }
    return { states, observedRevision: digest(JSON.stringify(states.map(({ path, hash }) => ({ path, hash })))) };
  }
  private async apply(ws: Workspace, op: Operation, snapshot: ArtifactManifest) {
    await this.validateSnapshot(ws, snapshot);
    const observed = await this.observed(ws, op);
    if (observed.states.some(s => !s.known)) throw new ArtifactError('CONFLICT', 'Unrecorded external changes prevent recovery');
    for (const state of observed.states) {
      const file = snapshot.files.find(f => f.path === state.path), wanted = file?.sha256 ?? null;
      if (wanted === state.hash) continue;
      const current = (await this.observed(ws, op)).states.find(s => s.path === state.path)!;
      if (current.hash !== state.hash) throw new ArtifactError('CONFLICT', 'Files changed during commit');
      const path = await ownedPath(ws.root, state.path);
      if (file) { await mkdir(dirname(path), { recursive: true }); await ownedPath(ws.root, state.path); await atomicFile(path, await this.object(ws.accountScope, file), file.mode, async () => {
        await ownedPath(ws.root, state.path);
        const latest = (await this.observed(ws, op)).states.find(s => s.path === state.path)!;
        if (latest.hash !== state.hash) throw new ArtifactError('CONFLICT', 'Files changed while staging the commit');
      }); }
      else { await unlink(path); await syncDirectory(dirname(path)); }
    }
  }
  private async commit(db: Database, ws: Workspace, record: Record, id: string, op: Operation) {
    await this.apply(ws, op, op.after);
    // Validate the entire postimage before making a complete version visible.
    const captured = await this.capture(ws, op.nextArtifact);
    if (!same(captured, op.after)) throw new ArtifactError('CONFLICT', 'Files changed before version commit');
    record.artifact = { ...op.nextArtifact };
    this.append(record, { version: op.version, manifest: op.after });
    const result = { version: op.version, workingRevision: op.after.digest, unchanged: false };
    op.status = 'committed'; op.result = result;
    this.changed(ws, record, result.workingRevision, id);
    await this.persist(db); await this.publish(ws); return result;
  }
  async operation(workspaceId: string, operationId: string) {
    return this.locked(async db => {
      const ws = this.workspace(db, workspaceId), op = ws.operations[operationId];
      if (!op) {
        if (ws.captureFailure?.id === operationId) {
          const observed = await this.captureObserved(ws, ws.captureFailure);
          return { status: 'pending' as const, kind: 'terminal-capture', ...observed, actions: observed.states.every(s => s.known) ? ['resume', 'rollback'] : ['resume'] };
        }
        if (ws.captureHistory?.[operationId]) return { status: 'committed' as const, observedRevision: digest(operationId), states: [], actions: [] };
        const writer = db.writers.find(w => w.runId === operationId && w.accountScope === this.options.accountScope && intersects(ws.root, w.directory));
        if (writer) {
          const pendingOperationId = ws.captureFailure?.runId === operationId ? ws.captureFailure.id : undefined;
          return { kind: 'terminal', status: pendingOperationId || !writer.status ? 'pending' as const : writer.status === 'completed' ? 'committed' as const : 'failed' as const, pendingOperationId, observedRevision: digest(JSON.stringify({ runId: operationId, status: writer.status })), states: [], actions: [] };
        }
        throw new ArtifactError('NOT_FOUND', 'Operation not found');
      }
      const observed = await this.observed(ws, op);
      return { status: op.status, result: op.result, ...observed, actions: op.status === 'pending' && observed.states.every(s => s.known) ? ['resume', 'rollback'] : [] };
    });
  }
  async resolveOperation(input: import('zod').infer<typeof ArtifactRequests.artifactResolveOperation>) {
    const data = ArtifactRequests.artifactResolveOperation.parse(input);
    return this.locked(async db => {
      const ws = this.workspace(db, data.workspaceId), op = ws.operations[data.operationId];
      if (!op) {
        const previous = ws.captureHistory?.[data.operationId];
        if (previous) {
          if (previous.resolutionId !== data.resolutionId || previous.action !== data.action) throw new ArtifactError('CONFLICT', 'Capture recovery has already been resolved');
          return { status: 'committed' as const };
        }
        if (ws.captureFailure?.id === data.operationId) return this.resolveCapture(db, ws, ws.captureFailure, data);
        throw new ArtifactError('NOT_FOUND', 'Operation not found');
      }
      if (op.resolution?.id === data.resolutionId && op.resolution.action !== data.action) throw new ArtifactError('CONFLICT', 'Resolution ID was reused');
      if (op.status !== 'pending') { if (op.resolution?.id === data.resolutionId) return { status: op.status, result: op.result }; throw new ArtifactError('CONFLICT', 'Operation is already resolved'); }
      await this.noWriter(ws, true);
      const observed = await this.observed(ws, op);
      if (observed.observedRevision !== data.expectedObservedRevision || observed.states.some(s => !s.known)) throw new ArtifactError('CONFLICT', 'Recovery baseline changed');
      op.resolution = { id: data.resolutionId, action: data.action }; await this.persist(db);
      const record = this.record(ws, op.artifactId);
      if (data.action === 'resume') return { status: 'committed', result: await this.commit(db, ws, record, data.operationId, op) };
      await this.apply(ws, op, op.before); op.status = 'failed';
      this.changed(ws, record, op.before.digest, data.operationId); await this.persist(db); await this.publish(ws);
      return { status: 'failed' };
    });
  }
  async rename(input: Rename) {
    const data = ArtifactRequests.artifactRename.parse(input);
    return this.mutate(data, 'manual', async (ws, record, before) => {
      const nextEntryPath = normalized(data.nextEntryPath ?? record.artifact.entryPath);
      if (dirname(nextEntryPath) !== dirname(record.artifact.entryPath)) throw new ArtifactError('UNSUPPORTED_PREVIEW', 'Moving the entry between directories requires an explicit resource migration');
      const nextKind = /\.html?$/i.test(nextEntryPath) ? 'html' : /\.(md|markdown)$/i.test(nextEntryPath) ? 'markdown' : undefined;
      if (nextKind !== record.artifact.kind) throw new ArtifactError('UNSUPPORTED_PREVIEW', 'Renaming cannot change the artifact format');
      if (nextEntryPath !== record.artifact.entryPath) {
        if (ws.records.some(r => r.artifact.managedPaths.includes(nextEntryPath))) throw new ArtifactError('CONFLICT', 'Rename target is already owned');
        try { await lstat(await ownedPath(ws.root, nextEntryPath)); throw new ArtifactError('CONFLICT', 'Rename target already exists'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      const artifact = { ...record.artifact, name: data.nextName, entryPath: nextEntryPath, managedPaths: record.artifact.managedPaths.map(p => p === record.artifact.entryPath ? nextEntryPath : p) };
      const after = manifest(nextEntryPath, before.files.map(f => f.path === record.artifact.entryPath ? { ...f, path: nextEntryPath } : f));
      return { after, artifact };
    });
  }
  /** Existing Task 2 saves and legacy file writes share registration, journal and writer exclusion. */
  async workspaceWrite<T>(directory: string, input: { path: string; content: string; expectedHash?: string | null; operationId?: string }, fallback: (target: string) => Promise<T>): Promise<T | { success: true; hash: string; operationId: string; versionId: string }> {
    return this.locked(async db => {
      const cwd = await realpath(directory), lexical = resolve(cwd, input.path);
      const target = await canonicalWriteTarget(lexical);
      const ws = db.workspaces.find(w => inside(w.root, target));
      if (!ws) return fallback(target); // still inside the machine lock: registration cannot race this write
      if (ws.accountScope !== this.options.accountScope) throw new ArtifactError('PERMISSION_DENIED', 'Another account owns the managed workspace');
      await this.noWriter(ws);
      const path = relative(ws.root, target).split('\\').join('/');
      const record = ws.records.find(r => r.artifact.managedPaths.includes(path));
      if (!record) return fallback(target);
      if (!inside(cwd, target)) throw new ArtifactError('PATH_OUT_OF_BOUNDS', 'File is outside this session directory');
      const before = await this.stable(ws, record.artifact), file = before.files.find(f => f.path === path);
      if (!input.expectedHash || file?.sha256 !== input.expectedHash) throw new ArtifactError('CONFLICT', 'File hash mismatch; refresh before saving');
      const bytes = Buffer.from(input.content, 'base64');
      const entry = before.files.find(f => f.path === record.artifact.entryPath)!;
      const data: Save = { workspaceId: ws.id, artifactId: record.artifact.id, operationId: input.operationId ?? randomUUID(), expectedRevision: before.digest, entryContent: path === record.artifact.entryPath ? decodeText(bytes) : decodeText(await this.object(ws.accountScope, entry)), changes: path === record.artifact.entryPath ? [] : [{ path, content: input.content }] };
      const result = await this.mutateLocked(db, data, 'manual', (w, r, b) => this.manualTarget(w, r, b, data));
      return { success: true, hash: digest(bytes), operationId: data.operationId, versionId: result.version.id };
    });
  }
  async assertUnmanagedRunner(directory: string) {
    return this.locked(async db => {
      const cwd = await realpath(directory);
      if (db.workspaces.some(ws => intersects(ws.root, cwd))) throw new ArtifactError('UNAVAILABLE', 'This agent does not yet support automatic artifact versions; use Codex or an unmanaged directory');
      // This marker also protects a registration that races an offline/initializing runner.
      const runId = `unsupported-${process.pid}`;
      if (!db.writers.some(w => w.runId === runId && !w.status)) {
        db.writers.push({ runId, directory: cwd, accountScope: this.options.accountScope, owner: await processOwner(), sessionId: runId, prompt: '' });
        await this.persist(db);
      }
    });
  }
  async beginTurn(data: { directory: string; sessionId: string; runId: string; prompt: string; writerPids?: number[]; reference?: { path: string; hash: string }; expected?: ArtifactRef & { expectedRevision: string } }) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(data.runId)) throw new ArtifactError('LIMIT_EXCEEDED', 'Invalid run identity');
    return this.locked(async db => {
      const directory = await realpath(data.directory);
      if (data.reference) {
        const target = await realpath(resolve(directory, data.reference.path));
        if (!inside(directory, target)) throw new ArtifactError('PATH_OUT_OF_BOUNDS', 'Referenced file is outside the declared write scope');
        const path = normalized(relative(directory, target).split('\\').join('/'));
        const actualHash = digest(await boundedRead(await ownedPath(directory, path), ARTIFACT_LIMITS.entryBytes));
        if (actualHash !== data.reference.hash) throw new ArtifactError('CONFLICT', 'Referenced file changed; refresh and reference it again');
      }
      const existing = db.writers.find(w => w.runId === data.runId && w.accountScope === this.options.accountScope);
      if (existing) throw new ArtifactError('CONFLICT', 'Run ID has already been accepted');
      const affected = db.workspaces.filter(ws => intersects(ws.root, directory));
      if (affected.length && data.prompt.length > 65536) throw new ArtifactError('LIMIT_EXCEEDED', 'Managed version prompt exceeds supported size');
      for (const writer of db.writers) if (!writer.status && affected.some(ws => intersects(ws.root, writer.directory)) && await this.leaseAlive(writer)) throw new ArtifactError('WRITER_ACTIVE', 'Another managed turn overlaps this scope');
      for (const ws of affected) {
        if (ws.accountScope !== this.options.accountScope) throw new ArtifactError('PERMISSION_DENIED', 'A different account owns the managed scope');
        await this.noWriter(ws);
        for (const record of ws.records) {
          const before = await this.stable(ws, record.artifact);
          if (data.expected?.workspaceId === ws.id && data.expected.artifactId === record.artifact.id && before.digest !== data.expected.expectedRevision) throw new ArtifactError('CONFLICT', 'Artifact context is stale', undefined, before.digest);
          await this.checkpoint(db, ws, record, before);
        }
      }
      if (data.expected && !affected.some(ws => ws.id === data.expected!.workspaceId && ws.records.some(r => r.artifact.id === data.expected!.artifactId))) throw new ArtifactError('NOT_FOUND', 'Bound artifact is outside this run scope');
      const writerOwners = await Promise.all((data.writerPids ?? []).map(pid => processOwner(pid)));
      const lease: Writer = { directory, writerOwners, owner: await processOwner(), accountScope: this.options.accountScope, sessionId: data.sessionId, runId: data.runId, prompt: affected.length ? data.prompt : '' };
      for (const ws of affected) ws.lease = lease;
      db.writers.push(lease); await this.persist(db);
    }, { waitTimeoutMs: 5000 });
  }
  async trackWriterProcess(runId: string, pid: number) {
    return this.locked(async db => {
      const writer = db.writers.find(w => w.runId === runId && w.accountScope === this.options.accountScope && !w.status);
      const owner = await processOwner();
      if (!writer || writer.owner.pid !== owner.pid || writer.owner.birth !== owner.birth) throw new ArtifactError('PERMISSION_DENIED', 'The run does not belong to this worker');
      const native = await processOwner(pid);
      if (writer.writerOwners?.some(p => p.pid === native.pid && p.birth === native.birth)) return;
      (writer.writerOwners ??= []).push(native);
      for (const ws of db.workspaces) if (ws.lease?.runId === runId && ws.accountScope === this.options.accountScope) ws.lease.writerOwners = writer.writerOwners;
      await this.persist(db);
    }, { waitTimeoutMs: 5000 });
  }

  private terminalPath(runId: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw new ArtifactError('NOT_FOUND', 'Invalid run identity');
    return join(this.options.storage, this.options.accountScope, 'terminals', runId + '.json');
  }
  private async terminalReceipt(writer: Writer): Promise<TerminalReceipt | undefined> {
    try {
      const value = JSON.parse((await boundedRead(this.terminalPath(writer.runId), 4096)).toString('utf8')) as TerminalReceipt;
      if (value.runId !== writer.runId || value.owner?.pid !== writer.owner.pid || value.owner.birth !== writer.owner.birth || !['completed', 'failed', 'cancelled'].includes(value.status)) throw new ArtifactError('UNAVAILABLE', 'Terminal receipt ownership is invalid');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async settleTerminals(db: Database) {
    for (const writer of db.writers.filter(w => w.accountScope === this.options.accountScope && !w.status)) {
      const receipt = await this.terminalReceipt(writer);
      if (!receipt) continue;
      try { await this.completeTurnLocked(db, writer, receipt.status); }
      catch (error) {
        // A durable capture-recovery marker is a readable outcome, not a live writer.
        if (!(error instanceof ArtifactError) || error.code !== 'COMMIT_PENDING') throw error;
      }
    }
  }
  async finishTurn(runId: string, status: 'completed' | 'failed' | 'cancelled') {
    // Handoff is independent of the catalog lock. Losing a release event or timing
    // out cannot lose the real terminal state; the next explicit request drains it.
    const snapshot = await this.load(), writer = snapshot.writers.find(w => w.runId === runId && w.accountScope === this.options.accountScope);
    if (!writer) throw new ArtifactError('NOT_FOUND', 'Run was not registered');
    const owner = await processOwner();
    if (writer.owner.pid !== owner.pid || writer.owner.birth !== owner.birth) throw new ArtifactError('PERMISSION_DENIED', 'Only the original writer can finish its run');
    if (!writer.status) await atomicCreateFile(this.terminalPath(runId), JSON.stringify({ runId, owner, status } satisfies TerminalReceipt));
    try {
      await this.locked(async db => {
        const failure = db.workspaces.find(ws => ws.accountScope === this.options.accountScope && ws.captureFailure?.runId === runId)?.captureFailure;
        if (failure) throw new ArtifactError('COMMIT_PENDING', 'The turn ended but capture requires recovery', failure.id);
      }, { waitTimeoutMs: 5000 });
    } catch (error) {
      if (error instanceof ArtifactError && error.code === 'COMMIT_PENDING') throw error;
      throw new ArtifactError('COMMIT_PENDING', 'Terminal result is durable; inspect its operation when the active request is available', runId);
    }
  }
  private async completeTurnLocked(db: Database, writer: Writer, status: TerminalReceipt['status']) {
    const runId = writer.runId;
    const affected = db.workspaces.filter(ws => ws.lease?.runId === runId && ws.accountScope === this.options.accountScope);
    for (const ws of affected) {
      if (status === 'completed') {
        let snapshots: { record: Record; after: ArtifactManifest }[];
        try { snapshots = await Promise.all(ws.records.map(async record => ({ record, after: await this.stable(ws, record.artifact) }))); }
        catch {
          const failure: CaptureFailure = { id: `capture-${runId.length > 80 ? digest(runId) : runId}`, runId, prompt: writer.prompt, snapshots: [] };
          for (const record of ws.records) {
            let snapshot: ArtifactManifest | undefined;
            try { snapshot = await this.capture(ws, record.artifact, false, false); } catch {}
            failure.snapshots.push({ artifactId: record.artifact.id, base: this.current(record), snapshot });
          }
          ws.captureFailure = failure;
          for (const affectedWorkspace of affected) { delete affectedWorkspace.lease; affectedWorkspace.runs[runId] = 'failed'; }
          writer.status = 'failed'; writer.prompt = '';
          await this.persist(db);
          throw new ArtifactError('COMMIT_PENDING', 'The turn ended but its snapshot could not be completed; inspect the capture operation', failure.id);
        }
        for (const { record, after } of snapshots) if (!same(after, this.current(record).manifest)) {
          this.append(record, this.version(record, after, 'ai', { prompt: writer.prompt, runId }));
          this.changed(ws, record, after.digest);
        }
      }
      // Failed/cancelled runs preserve their preimage. Modified bytes remain dirty.
      delete ws.lease; ws.runs[runId] = status;
    }
    writer.status = status; writer.prompt = ''; await this.persist(db);
    for (const ws of affected) await this.publish(ws);
  }
  private async captureObserved(ws: Workspace, failure: CaptureFailure) {
    const states: { path: string; hash: string | null; known: boolean }[] = [];
    for (const item of failure.snapshots) {
      const record = this.record(ws, item.artifactId), current = await this.capture(ws, record.artifact, false, false);
      for (const path of record.artifact.managedPaths) {
        const hash = current.files.find(f => f.path === path)?.sha256 ?? null;
        const saved = item.snapshot?.files.find(f => f.path === path)?.sha256 ?? null;
        const base = item.base.manifest.files.find(f => f.path === path)?.sha256 ?? null;
        states.push({ path, hash, known: hash === base || (!!item.snapshot && hash === saved) });
      }
    }
    states.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return { states, observedRevision: digest(JSON.stringify(states.map(({ path, hash }) => ({ path, hash })))) };
  }
  private async resolveCapture(db: Database, ws: Workspace, failure: CaptureFailure, data: import('zod').infer<typeof ArtifactRequests.artifactResolveOperation>) {
    await this.noWriter(ws, true);
    const previous = failure.resolution;
    if (previous?.id === data.resolutionId && previous.action !== data.action) throw new ArtifactError('CONFLICT', 'Resolution ID was reused');
    const hasRollbackJournal = Object.keys(ws.operations).some(id => id.startsWith(failure.id + '-'));
    // Capture retry never replaces working bytes. A failed retry (including an
    // older pinned resume) may be replaced; an actual rollback journal must finish.
    if (previous && (previous.id !== data.resolutionId || previous.action !== data.action) && previous.action === 'rollback' && hasRollbackJournal) throw new ArtifactError('CONFLICT', 'A capture rollback is already in progress');
    const observed = await this.captureObserved(ws, failure);
    if (observed.observedRevision !== data.expectedObservedRevision) throw new ArtifactError('CONFLICT', 'Capture recovery baseline changed');
    const matchesObserved = (record: Record, snapshot: ArtifactManifest) => record.artifact.managedPaths.every(path => (snapshot.files.find(f => f.path === path)?.sha256 ?? null) === observed.states.find(state => state.path === path)?.hash);
    if (data.action === 'resume') {
      const snapshots = await Promise.all(ws.records.map(async record => ({ record, after: await this.stable(ws, record.artifact) })));
      if (snapshots.some(({ record, after }) => !matchesObserved(record, after))) throw new ArtifactError('CONFLICT', 'Files changed before capture retry');
      failure.resolution = { id: data.resolutionId, action: data.action }; await this.persist(db);
      for (const { record, after } of snapshots) if (!same(after, this.current(record).manifest)) {
        this.append(record, this.version(record, after, 'external', { prompt: failure.prompt, runId: failure.runId }));
        this.changed(ws, record, after.digest, failure.id);
      }
    } else {
      if (observed.states.some(state => !state.known)) throw new ArtifactError('CONFLICT', 'Unrecorded external changes prevent capture rollback');
      // Freeze the user-confirmed preimages BEFORE persisting the choice. Never
      // redefine a later external write as a legitimate journal preimage.
      const plans = [];
      for (const item of failure.snapshots) {
        const record = this.record(ws, item.artifactId), id = `${failure.id}-${record.artifact.id}`;
        const before = await this.capture(ws, record.artifact, false, false);
        if (!matchesObserved(record, before)) throw new ArtifactError('CONFLICT', 'Files changed before capture rollback');
        plans.push({ item, record, id, before });
      }
      failure.resolution = { id: data.resolutionId, action: data.action }; await this.persist(db);
      for (const { item, record, id, before } of plans) {
        let op = ws.operations[id];
        if (op?.status === 'committed') continue;
        if (!op) {
          const after = item.base.manifest;
          op = { signature: digest(id), artifactId: record.artifact.id, status: 'pending', before, after, nextArtifact: { ...record.artifact }, version: this.version(record, after, 'restore', { restoreFromVersionId: item.base.version.id }).version };
          ws.operations[id] = op; await this.persist(db);
        }
        await this.commit(db, ws, record, id, op);
      }
    }
    (ws.captureHistory ??= {})[failure.id] = { ...failure, resolutionId: data.resolutionId, action: data.action };
    delete ws.captureFailure; await this.persist(db); await this.publish(ws);
    return { status: 'committed' as const };
  }

  /** Called once when a runtime service starts. Unknown processes or third images stay pending. */
  async recover() {
    return this.locked(async db => {
      for (const ws of db.workspaces.filter(w => w.accountScope === this.options.accountScope)) {
        if (ws.captureFailure) continue; // capture recovery requires an explicit user decision
        const pending = this.pending(ws); if (!pending) continue;
        const [id, op] = pending;
        try {
          await this.noWriter(ws, true);
          if ((await this.observed(ws, op)).states.some(s => !s.known)) continue;
          if (op.resolution?.action === 'rollback') {
            await this.apply(ws, op, op.before); op.status = 'failed';
            this.changed(ws, this.record(ws, op.artifactId), op.before.digest, id);
            await this.persist(db); await this.publish(ws);
          } else await this.commit(db, ws, this.record(ws, op.artifactId), id, op);
        } catch { /* Keep durable intent and last complete history available for explicit recovery. */ }
      }
    }, { waitTimeoutMs: undefined });
  }

}
