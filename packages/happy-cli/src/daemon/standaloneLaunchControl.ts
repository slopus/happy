import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { launchAuthProof, equalLaunchProof, launchBootstrapSchema, launchReplySchema, type StandaloneLaunchBootstrap } from './standaloneLaunchProtocol';

type Proof = { stored: boolean; releaseAcknowledged: boolean };
const nativeExitAndJournalReserveMs = 5500;
const blocked: Proof = { stored: false, releaseAcknowledged: false };
type Entry = { bootstrap: StandaloneLaunchBootstrap; claimed: boolean; socket?: WebSocket;
  retryable?: boolean; retiredNonce?: string; retiredFailed?: boolean; operationNonce?: string; ready: Promise<boolean>; markReady: (value: boolean) => void; operation?: Promise<Proof> };

/** Per-launch transport only. Journal reservation, runtime exit and Job accounting belong to the launch owner. */
export class StandaloneLaunchControl {
  private readonly entries = new Map<string, Entry>();
  private server!: WebSocketServer;
  private port = 0;
  private closing: Promise<void> | null = null;
  private constructor(private readonly instanceId: string) {}
  static async open(instanceId: string): Promise<StandaloneLaunchControl> {
    const control = new StandaloneLaunchControl(instanceId);
    // Validate identity before opening any listener.
    launchBootstrapSchema.parse({ version: 1, instanceId, launchId: 'validation', port: 1, secret: '0'.repeat(64) });
    control.server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/launch-control/v1', maxPayload: 4096,
      perMessageDeflate: false, verifyClient: ({ req }, accept) => {
        const id = req.headers['x-launch-id'];
        const entry = typeof id === 'string' ? control.entries.get(id) : undefined;
        const auth = req.headers['x-launch-proof'];
        const nonce = req.headers['x-launch-nonce'];
        if (!entry || entry.claimed || req.headers['x-instance-id'] !== instanceId || typeof nonce !== 'string'
          || !/^[a-f0-9]{64}$/.test(nonce) || !equalLaunchProof(auth, launchAuthProof(entry.bootstrap, 'client', nonce))) {
          accept(false, 401, 'Unauthorized'); return;
        }
        // No reconnect/adoption after channel loss: the launch remains unresolved.
        entry.claimed = true; accept(true);
      } });
    control.server.on('connection', (socket, request) => {
      const entry = control.entries.get(request.headers['x-launch-id'] as string)!;
      entry.socket = socket;
      socket.send(JSON.stringify({ type: 'authenticated', nonce: request.headers['x-launch-nonce'],
        proof: launchAuthProof(entry.bootstrap, 'server', request.headers['x-launch-nonce'] as string) }), () => {});
      const timer = setTimeout(() => socket.terminate(), 5000); timer.unref?.();
      socket.on('error', () => {});
      socket.once('close', () => { clearTimeout(timer); entry.markReady(false); });
      socket.on('message', (raw, binary) => {
        try {
          if (binary) throw new Error();
          const reply = launchReplySchema.parse(JSON.parse(raw.toString()));
          if (reply.launchId !== entry.bootstrap.launchId) throw new Error();
          if (reply.type === 'ready') {
            if (reply.instanceId !== instanceId) throw new Error();
            clearTimeout(timer); entry.markReady(true);
          } else if (reply.type === 'receipt' && reply.ownership === 'none' && entry.retiredFailed
            && reply.nonce === entry.retiredNonce && reply.nonce === entry.operationNonce) {
            // A delayed mutation-free refusal may arrive after the request timer/abort retired it.
            // Its nonce must still own the cached operation; it cannot clear a newer attempt.
            entry.retryable = true; entry.operation = undefined;
          }
        } catch { socket.close(1008, 'Invalid launch reply'); }
      });
    });
    await new Promise<void>((resolve, reject) => { control.server.once('listening', resolve); control.server.once('error', reject); });
    control.port = (control.server.address() as AddressInfo).port;
    return control;
  }
  /** Caller must durably reserve the same ID before spawning with this bootstrap. */
  reserve(launchId: string): StandaloneLaunchBootstrap {
    if (this.closing || this.entries.has(launchId) || this.entries.size >= 256) throw new Error('Launch reservation unavailable');
    const bootstrap = launchBootstrapSchema.parse({ version: 1, instanceId: this.instanceId, launchId, port: this.port,
      secret: randomBytes(32).toString('hex') });
    let markReady!: (value: boolean) => void;
    const ready = new Promise<boolean>(resolve => { markReady = resolve; });
    this.entries.set(launchId, { bootstrap, claimed: false, ready, markReady });
    return { ...bootstrap };
  }
  drain(launchId: string, signal: AbortSignal, budget: { remainingMs(): number }): Promise<Proof> {
    const entry = this.entries.get(launchId);
    if (!entry || this.closing || signal.aborted) return Promise.resolve({ ...blocked });
    if (entry.operation) return entry.operation;
    entry.retryable = true;
    const operation = this.observe(entry, signal, budget).then(proof => {
      if (entry.retryable && entry.operation === operation) entry.operation = undefined;
      return proof;
    });
    entry.operation = operation;
    return operation;
  }
  private async observe(entry: Entry, signal: AbortSignal, budget: { remainingMs(): number }): Promise<Proof> {
    const initial = budget.remainingMs();
    if (!Number.isFinite(initial) || initial <= nativeExitAndJournalReserveMs || initial > 30000) return { ...blocked };
    return new Promise<Proof>(resolve => {
      let finished = false; let receiptStored = false; let releasing = false; let ackSent = false; let socket: WebSocket | undefined;
      const nonce = randomUUID(); entry.operationNonce = nonce;
      const done = (proof: Proof) => {
        if (finished) return; finished = true; entry.retiredNonce = nonce;
        entry.retiredFailed = !proof.stored || !proof.releaseAcknowledged;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        socket?.removeListener('message', message); socket?.removeListener('close', closed);
        resolve(proof);
      };
      const abandon = () => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'abandon', nonce }), () => {}); };
      const abort = () => { abandon(); done({ ...blocked }); };
      const closed = () => done({ ...blocked });
      const message = (raw: Buffer, binary: boolean) => {
        try {
          if (binary) throw new Error();
          const reply = launchReplySchema.parse(JSON.parse(raw.toString()));
          if (reply.type === 'ready' || reply.nonce === entry.retiredNonce) return;
          if (reply.launchId !== entry.bootstrap.launchId || reply.nonce !== nonce) throw new Error();
          if (reply.type === 'receipt') {
            if (releasing || !reply.stored || reply.ownership !== 'held') {
              entry.retryable = reply.ownership === 'none';
              if (!entry.retryable) abandon();
              done({ ...blocked }); return;
            }
            receiptStored = true; releasing = true;
            socket!.send(JSON.stringify({ type: 'release', nonce }), error => { if (error) done({ ...blocked }); });
          } else if (reply.type === 'intent') {
            if (!receiptStored || !releasing) throw new Error();
            ackSent = true;
            socket!.send(JSON.stringify({ type: 'ack', nonce }), error => { if (error) done({ ...blocked }); });
          } else {
            // Final child confirmation still is NOT OS exit or Job evidence.
            done(reply.decision === 'confirmed' && receiptStored && ackSent
              ? { stored: true, releaseAcknowledged: true } : { ...blocked });
          }
        } catch { abandon(); done({ ...blocked }); }
      };
      const timer = setTimeout(abort, initial - nativeExitAndJournalReserveMs); timer.unref?.();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void entry.ready.then(ready => {
        if (finished) return;
        socket = entry.socket;
        const releaseBudgetMs = 10000;
        // Leave 4s for runtime/Job exit and 1.5s for the journal's ACL+fsync.
        const sessionBudgetMs = Math.min(15000, budget.remainingMs() - releaseBudgetMs - nativeExitAndJournalReserveMs);
        if (!ready || socket?.readyState !== WebSocket.OPEN || sessionBudgetMs < 2000) {
          entry.retryable = ready && socket?.readyState === WebSocket.OPEN && sessionBudgetMs < 2000;
          done({ ...blocked }); return;
        }
        entry.retryable = false;
        socket.on('message', message); socket.once('close', closed);
        socket.send(JSON.stringify({ type: 'drain', nonce, sessionBudgetMs, releaseBudgetMs }), error => { if (error) done({ ...blocked }); });
      }).catch(() => done({ ...blocked }));
    });
  }
  /** Only the launch owner may call this after recording the durable outcome. */
  forget(launchId: string): void {
    const entry = this.entries.get(launchId);
    if (!entry) return;
    entry.markReady(false); entry.socket?.terminate(); this.entries.delete(launchId);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = new Promise(resolve => {
      for (const entry of this.entries.values()) { entry.markReady(false); entry.socket?.terminate(); }
      this.server.close(() => resolve());
    });
    return this.closing;
  }
}
