import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9._-]+$/);
const targetSchema = z.object({ platform: z.literal('win32'), arch: z.enum(['x64', 'arm64']), provider: z.enum(['codex', 'claude']), mode: z.literal('standard') }).strict();
const beginSchema = z.object({ requestId: id, expectedInstanceId: id, reason: z.enum(['app-quit', 'update', 'mode-switch']) }).strict();
const snapshotSchema = z.object({ launchIds: z.array(id).max(256), unresolved: z.boolean() }).strict();
const referenceSchema = z.object({ expectedInstanceId: id, operationId: id }).strict();
type Begin = z.infer<typeof beginSchema>;
type Evidence = { stored: boolean; runtimeExited: boolean; jobEmpty: boolean };
type Launch = { launchId: string; state: 'pending' | 'exited' | 'unknown' | 'failed' };
type Operation = {
  operationId: string; state: 'draining' | 'blocked' | 'completed'; error: string | null;
  launches: Launch[]; pending: boolean; committed: boolean;
};
class DrainError extends Error {
  constructor(readonly code: string, readonly statusCode = 409) { super(code); }
}

/** Internal backend contract, not a capability inferred from a platform name or CLI version. */
type Backend = {
  instanceId: string;
  targets: readonly z.infer<typeof targetSchema>[];
  /** Idempotently close ALL launch/input gates before the first await; then await in-flight launches. */
  freeze: (signal: AbortSignal, budget: { remainingMs(): number }) => Promise<{ launchIds: readonly string[]; unresolved: boolean }>;
  /** Only true after last-output storage ACK, clean runtime exit, and fenced Job accounting=0. */
  drain: (launchId: string, signal: AbortSignal, budget: { remainingMs(): number }) => Promise<Evidence>;
  canTerminate?: (launchId: string) => boolean;
  terminate?: (launchId: string) => Promise<void>;
  timeoutMs?: number;
};

/** One drain at a time. Nothing reopens the launch gate, deletes a journal, or kills a PID here. */
export class StandaloneDrain {
  private readonly requests = new Map<string, { reason: Begin['reason']; operation: Operation }>();
  private current: Operation | null = null;
  private freezing = false;
  private readonly running = new Set<string>();
  private readonly timeoutMs: number;
  readonly instanceId: string;
  private readonly targets: z.infer<typeof targetSchema>[];
  capabilities() { return { supported: true, capability: 'standalone-session-drain-v1', instanceId: this.instanceId, targets: this.targets.map(target => ({ ...target })) }; }
  constructor(private readonly backend: Backend) {
    this.instanceId = id.parse(backend.instanceId);
    this.targets = z.array(targetSchema).min(1).max(8).parse(backend.targets);
    this.timeoutMs = backend.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 30_000) throw new Error('Invalid drain budget');
  }
  private checkInstance(instance: string) {
    if (instance !== this.instanceId) throw new DrainError('instance-mismatch');
  }
  private view(op: Operation) {
    return { version: 1 as const, instanceId: this.instanceId, operationId: op.operationId, state: op.state,
      error: op.error, retryable: op.state === 'blocked' && !op.pending && this.requests.size < 128
        && op.error !== 'invalid-launch-snapshot', launches: op.launches.map(entry => ({ ...entry,
          ...(op.state === 'blocked' && this.backend.canTerminate ? { canTerminate: this.backend.canTerminate(entry.launchId) } : {}),
        })) };
  }
  begin(raw: Begin) {
    const request = beginSchema.parse(raw);
    this.checkInstance(request.expectedInstanceId);
    const previous = this.requests.get(request.requestId);
    if (previous) {
      if (previous.reason !== request.reason) throw new DrainError('request-conflict');
      return this.view(previous.operation);
    }
    // A bounded per-instance replay registry; never forget a request and accidentally re-execute it.
    if (this.requests.size >= 128) throw new DrainError('request-capacity-exceeded', 429);
    if (this.current?.committed) throw new DrainError('daemon-stop-committed');
    if (this.current?.state === 'draining' || this.current?.state === 'completed') {
      this.requests.set(request.requestId, { reason: request.reason, operation: this.current });
      return this.view(this.current);
    }
    const operation: Operation = { operationId: request.requestId, state: 'draining', error: null, launches: [], pending: true, committed: false };
    this.current = operation;
    this.requests.set(request.requestId, { reason: request.reason, operation });
    void this.execute(operation);
    return this.view(operation);
  }
  status(instance: string, operationId: string) {
    this.checkInstance(instance);
    const operation = this.requests.get(operationId)?.operation;
    if (!operation) throw new DrainError('operation-not-found', 404);
    return this.view(operation);
  }
  commit(instance: string, operationId: string): boolean {
    this.checkInstance(instance);
    const operation = this.requests.get(operationId)?.operation;
    if (!operation) throw new DrainError('operation-not-found', 404);
    if (operation !== this.current || operation.state !== 'completed' || operation.pending) throw new DrainError('drain-not-completed');
    if (operation.committed) return false;
    operation.committed = true;
    return true;
  }
  async terminate(instance: string, operationId: string, launchId: string): Promise<void> {
    this.checkInstance(instance);
    const operation = this.requests.get(operationId)?.operation;
    if (!operation || operation !== this.current || operation.state !== 'blocked' || operation.pending
      || !operation.launches.some(entry => entry.launchId === launchId && entry.state !== 'exited')
      || !this.backend.canTerminate?.(launchId) || !this.backend.terminate) throw new DrainError('termination-not-available');
    // An explicit owner action; never commit or convert this request to a successful drain.
    await this.backend.terminate(launchId);
  }
  private async execute(operation: Operation) {
    const cancellation = new AbortController();
    const deadline = performance.now() + this.timeoutMs;
    const budget = { remainingMs: () => Math.max(0, deadline - performance.now()) };
    const block = (code: string) => { if (operation.state === 'draining') { operation.state = 'blocked'; operation.error = code; } };
    let stopObserving!: () => void;
    const timedOut = new Promise<void>(resolve => { stopObserving = resolve; });
    const expired = () => {
      block('deadline-exceeded');
      for (const entry of operation.launches) if (entry.state === 'pending') entry.state = 'unknown';
      cancellation.abort();
      stopObserving();
    };
    const withinBudget = () => { if (performance.now() >= deadline) expired(); return operation.state === 'draining'; };
    const timer = setTimeout(expired, this.timeoutMs);
    timer.unref?.();
    const work = async () => {
      if (this.freezing) { block('freeze-still-running'); return; }
      this.freezing = true;
      let rawSnapshot: unknown;
      try { rawSnapshot = await this.backend.freeze(cancellation.signal, budget); }
      finally { this.freezing = false; }
      if (!withinBudget()) return;
      const snapshot = snapshotSchema.safeParse(rawSnapshot);
      if (!snapshot.success) { block('invalid-launch-snapshot'); return; }
      const frozen = snapshot.data;
      if (new Set(frozen.launchIds).size !== frozen.launchIds.length) { block('invalid-launch-snapshot'); return; }
      // An incomplete new snapshot must not hide work that still owns a launch.
      const ids = new Set([...frozen.launchIds, ...this.running]);
      if (ids.size > 256) { block('invalid-launch-snapshot'); return; }
      operation.launches = [...ids].map(launchId => ({ launchId, state: 'pending' }));
      if (frozen.unresolved) {
        for (const entry of operation.launches) entry.state = 'unknown';
        block('ownership-unresolved'); return;
      }
      let next = 0;
      const worker = async () => {
        while (next < operation.launches.length && withinBudget()) {
          const entry = operation.launches[next++];
          // Keep actual backend accounting until settlement, independently of the operation deadline.
          if (this.running.has(entry.launchId) || this.running.size >= 4) { entry.state = 'unknown'; continue; }
          this.running.add(entry.launchId);
          try {
            // Freeze fanout and every evidence wave spend the same operation budget.
            const proof = await this.backend.drain(entry.launchId, cancellation.signal, budget);
            if (!withinBudget()) return;
            entry.state = proof.stored === true && proof.runtimeExited === true && proof.jobEmpty === true ? 'exited' : 'unknown';
          } catch { if (withinBudget()) entry.state = 'failed'; }
          finally { this.running.delete(entry.launchId); }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4 - this.running.size, operation.launches.length) }, worker));
      if (!withinBudget()) return;
      for (const entry of operation.launches) if (entry.state === 'pending') entry.state = 'unknown';
      if (operation.launches.some(entry => entry.state !== 'exited')) block('drain-unverified');
      else operation.state = 'completed';
    };
    try { await Promise.race([work(), timedOut]); }
    catch { block('drain-failed'); }
    finally { clearTimeout(timer); operation.pending = false; }
  }
}

/** Mounted behind the control server's existing bearer/managed-runtime onRequest hook. */
export function attachStandaloneDrain(app: FastifyInstance, control: StandaloneDrain | undefined, requestShutdown: () => void) {
  const requireControl = () => { if (!control) throw new DrainError('drain-unsupported', 503); return control; };
  const run = (action: (body: unknown) => unknown) => async (request: { body: unknown }, reply: { code: (status: number) => unknown }) => {
    try { return await action(request.body); }
    catch (error) {
      const status = error instanceof z.ZodError ? 400 : error instanceof DrainError ? error.statusCode : 500;
      reply.code(status);
      return { error: error instanceof z.ZodError ? 'invalid-request' : error instanceof DrainError ? error.code : 'drain-failed' };
    }
  };
  app.post('/standalone-drain/capabilities', run(() => control
    ? control.capabilities()
    : { supported: false }));
  app.post('/standalone-drain/begin', run(body => requireControl().begin(beginSchema.parse(body))));
  app.post('/standalone-drain/status', run(body => {
    const ref = referenceSchema.parse(body); return requireControl().status(ref.expectedInstanceId, ref.operationId);
  }));
  app.post('/standalone-drain/terminate', run(async body => {
    const ref = referenceSchema.extend({ launchId: id }).parse(body);
    await requireControl().terminate(ref.expectedInstanceId, ref.operationId, ref.launchId);
    return { accepted: true };
  }));
  app.post('/standalone-drain/commit', run(body => {
    const ref = referenceSchema.parse(body);
    if (requireControl().commit(ref.expectedInstanceId, ref.operationId)) setTimeout(requestShutdown, 50).unref();
    return { accepted: true };
  }));
}
