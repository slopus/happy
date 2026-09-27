import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { StandaloneLaunchJournal } from './standaloneLaunchJournal';
import type { StandaloneLaunchControl } from './standaloneLaunchControl';
import { STANDALONE_LAUNCH_ENV } from './standaloneLaunchProtocol';

type Budget = { remainingMs(): number };
export type NativeReceipt = { launchId: string; instanceId: string; launched: boolean; resumed: boolean;
  rootExit: number | null; jobEmpty: boolean; forced: boolean; nativeError: number; ownerTerminated: boolean };
type Prepared = { pid: number; childProcess: ChildProcess; resume(): void | Promise<void>; cancelBeforeResume?(): void; terminate?(): Promise<void>; exit: Promise<NativeReceipt> };
type LaunchInput = { args: string[]; cwd: string; env: NodeJS.ProcessEnv };
type Proof = { stored: boolean; releaseAcknowledged: boolean };
type Evidence = { stored: boolean; runtimeExited: boolean; jobEmpty: boolean };
const blocked: Evidence = { stored: false, runtimeExited: false, jobEmpty: false };
type Dependencies = {
  instanceId: string;
  journal: Pick<StandaloneLaunchJournal, 'reserve' | 'snapshot' | 'complete' | 'end' | 'notLaunched' | 'rollback' | 'terminate' | 'pendingRecords'>;
  control: Pick<StandaloneLaunchControl, 'reserve' | 'drain' | 'forget' | 'close'>;
  /** Must verify the native artifact and return only durable, identity-checked native receipts. */
  launch(input: LaunchInput & { launchId: string; instanceId: string }): Promise<Prepared>;
  hasUnboundChildren(ownedRootPids: ReadonlySet<number>): boolean;
  /** Only the native adapter can establish that no process was created. */
  isNoProcessError?(error: unknown): boolean;
  onRetired?(pid: number, launchId: string): void;
  readReceipt?(intent: { instanceId: string; launchId: string }): Promise<NativeReceipt | null>;
};
type Entry = { id: string; prepared: Promise<Prepared>; preparedValue?: Prepared; pid?: number; attempt?: Promise<Proof>; lastProof?: Proof;
  final: Promise<Evidence>; retired: boolean; recoverable?: boolean };

type Outcome = { kind: 'not-launched' } | { kind: 'ended' | 'rolled-back' | 'owner-terminated'; rootExit: number };
/** Both live and restart observations use the same non-storage terminal classification. */
export function classifyNativeReceipt(receipt: NativeReceipt): Outcome | null {
  if (!Number.isInteger(receipt.nativeError)) return null;
  if (!receipt.launched) return !receipt.resumed && !receipt.forced && !receipt.ownerTerminated
    && receipt.rootExit === null ? { kind: 'not-launched' } : null;
  if (!receipt.jobEmpty || receipt.rootExit === null || !Number.isInteger(receipt.rootExit)
    || receipt.rootExit < 0 || receipt.rootExit > 0xffffffff || (receipt.resumed && receipt.forced)) return null;
  if (receipt.ownerTerminated) return receipt.resumed && !receipt.forced
    ? { kind: 'owner-terminated', rootExit: receipt.rootExit } : null;
  return { kind: receipt.forced ? 'rolled-back' : 'ended', rootExit: receipt.rootExit };
}

/** A failed readiness handshake can still carry authoritative pre-resume rollback evidence. */
export class StandaloneLaunchFailure extends Error {
  constructor(readonly receipt: NativeReceipt) { super('Native launch failed before readiness'); }
}

/** Owns journal identity and native evidence; no PID enumeration, adoption, or termination. */
export class StandaloneSessionOwner {
  private readonly entries = new Map<string, Entry>();
  private observing = new Map<string, Entry>();
  private frozen = false;
  private closed = false;
  private startupUnresolved = false;
  private untrackedPendingCount = 0;
  private recoveryDelayMs = 5000;
  private recoveryFingerprint: string | undefined;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private reconciliation?: Promise<{ records: { instanceId: string; launchId: string }[]; unresolved: boolean }>;
  readonly instanceId: string;
  private constructor(private readonly dependencies: Dependencies) { this.instanceId = dependencies.instanceId; }
  static async open(dependencies: Dependencies): Promise<StandaloneSessionOwner> {
    const owner = new StandaloneSessionOwner(dependencies);
    await owner.reconcilePending();
    return owner;
  }
  get unresolvedLaunchCount(): number { return this.entries.size + this.untrackedPendingCount; }
  get acceptingLaunches(): boolean { return !this.frozen && !this.closed && !this.startupUnresolved; }
  launchIdForRoot(pid: number): string | undefined { return [...this.entries.values()].find(entry => !entry.retired && entry.pid === pid)?.id; }
  ownsRoot(pid: number): boolean { return this.launchIdForRoot(pid) !== undefined; }
  prepare(input: LaunchInput): Promise<Prepared & { launchId: string }> {
    if (!this.acceptingLaunches) return Promise.reject(new Error('Standalone launch gate closed'));
    const id = randomUUID();
    // Register before any asynchronous reservation so freeze includes in-flight launches.
    let start!: () => void;
    const ready = new Promise<void>(resolve => { start = resolve; });
    const entry = { id, retired: false } as Entry;
    this.entries.set(id, entry);
    entry.prepared = ready.then(async () => {
      let reserved = false; let launchCalled = false;
      try {
        await this.dependencies.journal.reserve(this.instanceId, id); reserved = true;
        const bootstrap = this.dependencies.control.reserve(id);
        launchCalled = true;
        const prepared = await this.dependencies.launch({ ...input, instanceId: this.instanceId, launchId: id,
          env: { ...input.env, [STANDALONE_LAUNCH_ENV]: JSON.stringify(bootstrap) } });
        entry.pid = prepared.pid; entry.preparedValue = prepared;
        return prepared;
      } catch (error) {
        if (reserved && error instanceof StandaloneLaunchFailure) {
          await this.recordExit(entry, error.receipt);
        } else if (reserved && (!launchCalled || this.dependencies.isNoProcessError?.(error))) {
          await this.dependencies.journal.notLaunched(this.instanceId, id, { processCreated: false });
          this.retire(entry);
        } else if (!reserved) {
          // No launch was attempted. Any intent a failed write left behind stays unknown and
          // is recounted by reconciliation instead of wedging this in-memory entry forever.
          this.retire(entry);
          void this.reconcilePending().catch(() => {});
        }
        throw error;
      }
    });
    entry.final = entry.prepared.then(prepared => prepared.exit).then(receipt => this.recordExit(entry, receipt))
      .catch(() => ({ ...blocked })).then(evidence => {
        if (!entry.retired) { entry.recoverable = true; this.startupUnresolved = true; this.scheduleRecovery(); }
        return evidence;
      });
    start();
    return entry.prepared.then(prepared => ({ ...prepared, launchId: id }));
  }
  private retire(entry: Entry) {
    entry.retired = true;
    this.dependencies.control.forget(entry.id);
    this.entries.delete(entry.id);
    if (entry.pid !== undefined) {
      // Notifications cannot invalidate the already-durable native outcome.
      try { this.dependencies.onRetired?.(entry.pid, entry.id); } catch { /* Tracking remains conservatively unbound if its observer failed. */ }
    }
  }
  private async writeOutcome(instanceId: string, launchId: string, outcome: Outcome): Promise<void> {
    if (outcome.kind === 'not-launched') {
      await this.dependencies.journal.notLaunched(instanceId, launchId, { processCreated: false });
      return;
    }
    const evidence = { runtimeExited: true, jobEmpty: true, rootExit: outcome.rootExit };
    if (outcome.kind === 'rolled-back') await this.dependencies.journal.rollback(instanceId, launchId,
      { ...evidence, resumed: false, forced: true });
    else if (outcome.kind === 'owner-terminated') await this.dependencies.journal.terminate(instanceId, launchId,
      { ...evidence, ownerTerminated: true });
    else await this.dependencies.journal.end(instanceId, launchId, evidence);
  }
  private async recordExit(entry: Entry, receipt: NativeReceipt): Promise<Evidence> {
    if (receipt.instanceId !== this.instanceId || receipt.launchId !== entry.id) return { ...blocked };
    const outcome = classifyNativeReceipt(receipt);
    if (!outcome) return { ...blocked };
    // Pre-resume rollback cannot await an attempt that itself awaits prepared.
    // Native observation errors rule out storage proof, not a proven empty Job.
    const clean = outcome.kind === 'ended' && receipt.resumed && receipt.rootExit === 0 && receipt.nativeError === 0;
    const proof = clean && entry.attempt ? await entry.attempt : undefined;
    if (clean && proof?.stored && proof.releaseAcknowledged) {
      const evidence = { stored: true, runtimeExited: true, jobEmpty: true };
      await this.dependencies.journal.complete(this.instanceId, entry.id, evidence);
      this.retire(entry);
      return evidence;
    }
    await this.writeOutcome(this.instanceId, entry.id, outcome);
    this.retire(entry);
    return { stored: false, runtimeExited: true, jobEmpty: true };
  }
  private scheduleRecovery(): void {
    if (this.closed || this.recoveryTimer || !this.dependencies.readReceipt
      || (!this.startupUnresolved && ![...this.entries.values()].some(entry => entry.recoverable))) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.reconcilePending().catch(() => {}).finally(() => this.scheduleRecovery());
    }, this.recoveryDelayMs);
    this.recoveryTimer.unref?.();
  }
  private reconcilePending() {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.reconcileRecords().finally(() => {
      this.reconciliation = undefined;
      this.scheduleRecovery();
    });
    return this.reconciliation;
  }
  private async reconcileRecords() {
    const pending = await this.dependencies.journal.pendingRecords();
    let wrote = false;
    if (this.dependencies.readReceipt) for (const intent of pending.records) {
      const entry = intent.instanceId === this.instanceId ? this.entries.get(intent.launchId) : undefined;
      // A live observer may still produce a stored completion. Recovery never preempts it.
      if (entry && !entry.recoverable) continue;
      try {
        const receipt = await this.dependencies.readReceipt(intent);
        if (!receipt || receipt.instanceId !== intent.instanceId || receipt.launchId !== intent.launchId) continue;
        const outcome = classifyNativeReceipt(receipt);
        if (!outcome) continue;
        await this.writeOutcome(intent.instanceId, intent.launchId, outcome);
        wrote = true;
        if (entry) this.retire(entry);
      } catch { /* Keep missing, invalid, or unwritable evidence pending for the next observation. */ }
    }
    const current = wrote ? await this.dependencies.journal.pendingRecords() : pending;
    const fingerprint = JSON.stringify(current);
    this.recoveryDelayMs = !wrote && fingerprint === this.recoveryFingerprint
      ? Math.min(60000, this.recoveryDelayMs * 2) : 5000;
    this.recoveryFingerprint = fingerprint;
    this.untrackedPendingCount = Number(current.unresolved) + current.records.filter(record =>
      record.instanceId !== this.instanceId || !this.entries.has(record.launchId)).length;
    this.startupUnresolved = this.untrackedPendingCount > 0 || [...this.entries.values()].some(entry => entry.recoverable);
    return current;
  }
  private assignAttempt(entry: Entry, work: Promise<Proof>): void {
    entry.lastProof = undefined;
    const operation = work.catch(() => ({ stored: false, releaseAcknowledged: false })).then(proof => {
      if (entry.attempt === operation) entry.lastProof = proof;
      return proof;
    });
    entry.attempt = operation;
  }
  canDrainRoot(pid: number): boolean {
    const id = this.launchIdForRoot(pid);
    const entry = id === undefined ? undefined : this.entries.get(id);
    return Boolean(entry && !this.closed && !entry.recoverable && (!this.frozen || (entry.attempt
      && (!entry.lastProof || (entry.lastProof.stored && entry.lastProof.releaseAcknowledged)))));
  }
  async freeze(signal: AbortSignal, budget: Budget): Promise<{ launchIds: string[]; unresolved: boolean }> {
    this.frozen = true;
    const captured = [...this.entries.values()];
    this.observing = new Map(captured.map(entry => [entry.id, entry]));
    for (const entry of captured) {
      // Fan out before the first await; the outer controller's four workers only collect evidence.
      this.assignAttempt(entry, entry.pid === undefined
        ? entry.prepared.then(() => this.dependencies.control.drain(entry.id, signal, budget))
        : this.dependencies.control.drain(entry.id, signal, budget));
    }
    const settled = await within(Promise.allSettled(captured.map(entry => entry.prepared)), signal, budget);
    if (!settled) return { launchIds: captured.map(entry => entry.id), unresolved: true };
    const pending = await within(this.reconcilePending(), signal, budget);
    if (!pending) return { launchIds: captured.map(entry => entry.id), unresolved: true };
    const launchIds = pending.records.map(record => record.launchId);
    const owned = new Set([...this.entries.values()].flatMap(entry => entry.pid === undefined ? [] : [entry.pid]));
    return { launchIds: [...new Set([...launchIds, ...captured.map(entry => entry.id)])],
      unresolved: this.startupUnresolved || this.dependencies.hasUnboundChildren(owned) };
  }
  async drain(launchId: string, signal: AbortSignal, budget: Budget): Promise<Evidence> {
    const entry = this.observing.get(launchId);
    if (!this.frozen || !entry?.attempt) return { ...blocked };
    return await within(entry.final, signal, budget) ?? { ...blocked };
  }
  async stopRoot(pid: number): Promise<Evidence> {
    const id = this.launchIdForRoot(pid);
    const entry = id === undefined ? undefined : this.entries.get(id);
    if (!entry || !this.canDrainRoot(pid)) return { ...blocked };
    const cancellation = new AbortController();
    const deadline = performance.now() + 30000;
    const budget = { remainingMs: () => Math.max(0, deadline - performance.now()) };
    const timer = setTimeout(() => cancellation.abort(), 30000); timer.unref?.();
    try {
      // Session stop uses the same stored-output protocol; it never signals a PID
      // and does not close admission for unrelated sessions.
      if (!this.frozen) this.assignAttempt(entry, this.dependencies.control.drain(entry.id, cancellation.signal, budget));
      return await within(entry.final, cancellation.signal, budget) ?? { ...blocked };
    } finally { clearTimeout(timer); cancellation.abort(); }
  }
  canTerminate(launchId: string): boolean {
    const entry = this.entries.get(launchId);
    return this.frozen && !this.closed && Boolean(entry && !entry.retired && entry.preparedValue?.terminate);
  }
  async resolveTermination(launchId: string, budget: Budget = { remainingMs: () => 10000 }): Promise<void> {
    const entry = this.entries.get(launchId);
    if (!this.frozen || this.closed || !entry) throw new Error('Native termination unavailable');
    const signal = new AbortController().signal;
    const deadline = performance.now() + Math.min(10000, budget.remainingMs());
    const remaining = { remainingMs: () => Math.max(0, Math.min(budget.remainingMs(), deadline - performance.now())) };
    const prepared = await within(entry.prepared, signal, remaining);
    if (!prepared?.terminate) throw new Error('Native termination unavailable');
    const sent = await within(prepared.terminate().then(() => true), signal, remaining);
    if (!sent) throw new Error('Native termination delivery unverified');
    const evidence = await within(entry.final, signal, remaining);
    if (!evidence?.runtimeExited || !evidence.jobEmpty) throw new Error('Native termination remains unverified');
  }
  close(): Promise<void> {
    this.closed = true; this.frozen = true;
    clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined;
    return this.dependencies.control.close();
  }
}

function within<T>(work: Promise<T>, signal: AbortSignal, budget: Budget): Promise<T | undefined> {
  const remaining = budget.remainingMs();
  if (signal.aborted || !Number.isFinite(remaining) || remaining <= 0) return Promise.resolve(undefined);
  return new Promise(resolve => {
    let done = false;
    const finish = (value?: T) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(value); };
    const abort = () => finish();
    const timer = setTimeout(abort, remaining); timer.unref?.();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) finish();
    void work.then(finish, () => finish());
  });
}
