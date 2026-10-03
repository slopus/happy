import { randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import type { Socket } from 'node:net';
import { SessionDrain, type DrainReceipt, type DrainProvider } from './sessionDrain';
import type { RuntimeProducerGate } from './runtimeProducerGate';
import { launchAuthProof, equalLaunchProof, launchAuthenticationSchema, launchBootstrapSchema, launchCommandSchema, type StandaloneLaunchBootstrap } from '../daemon/standaloneLaunchProtocol';

/** One child dials its reserving daemon. This channel never supplies OS/Job evidence. */
export class SessionLaunchControl {
  private readonly socket: WebSocket;
  private drain: SessionDrain | undefined;
  private runtime: RuntimeProducerGate | undefined;
  private readonly launchId: string;
  private readonly connected: Promise<void>;
  private current: { nonce: string; receipt?: DrainReceipt; controller: AbortController; intent: boolean } | null = null;
    private closed = false;
    private transport: Socket | undefined;
  static async connect(bootstrap: StandaloneLaunchBootstrap): Promise<SessionLaunchControl> {
    const control = new SessionLaunchControl(bootstrap);
    try { await control.ready(); return control; }
    catch (error) { control.close(); throw error; }
  }
  constructor(bootstrap: StandaloneLaunchBootstrap, provider?: DrainProvider,
    storage?: ConstructorParameters<typeof SessionDrain>[2], runtime?: RuntimeProducerGate) {
    const config = launchBootstrapSchema.parse(bootstrap);
    this.launchId = config.launchId;
    if (provider || storage || runtime) {
      if (!provider || !storage || !runtime) throw new Error('Incomplete standalone launch binding');
      this.runtime = runtime;
      this.drain = new SessionDrain(config.launchId, provider, storage, async () => {}, runtime);
    }
    const clientNonce = randomBytes(32).toString('hex');
    let authenticated = false;
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    this.socket = new WebSocket(`ws://127.0.0.1:${config.port}/launch-control/v1`, { maxPayload: 4096,
      handshakeTimeout: 5000, followRedirects: false, headers: { 'x-launch-proof': launchAuthProof(config, 'client', clientNonce), 'x-launch-nonce': clientNonce,
        'x-launch-id': config.launchId, 'x-instance-id': config.instanceId } });
    // Keep authentication/binding alive; otherwise a new parent can exit before readiness.
    // Once bound, the provider/runtime owns liveness. Failed startup closes this channel.
    this.socket.once('upgrade', response => { this.transport = response.socket; });
    this.connected = new Promise((resolve, reject) => {
      readyResolve = resolve; readyReject = reject;
      this.socket.once('error', () => reject(new Error('Standalone launch control unavailable')));
      this.socket.once('close', () => reject(new Error('Standalone launch control closed')));
    });
    void this.connected.catch(() => {});
    const authenticationTimer = setTimeout(() => {
      readyReject(new Error('Standalone launch control authentication timed out'));
      this.lost(); this.socket.terminate();
    }, 5000);
    authenticationTimer.unref?.();
    this.socket.once('close', () => clearTimeout(authenticationTimer));
    this.socket.on('error', () => this.lost());
    this.socket.on('close', () => this.lost());
    this.socket.on('message', (raw, binary) => {
      try {
        if (binary) throw new Error();
        if (!authenticated) {
          const answer = launchAuthenticationSchema.parse(JSON.parse(raw.toString()));
          if (answer.nonce !== clientNonce || !equalLaunchProof(answer.proof, launchAuthProof(config, 'server', clientNonce))) throw new Error();
          authenticated = true; clearTimeout(authenticationTimer);
          this.socket.send(JSON.stringify({ type: 'ready', instanceId: config.instanceId, launchId: config.launchId }), error => {
            if (error) readyReject(new Error('Standalone launch control unavailable')); else readyResolve();
          });
          return;
        }
        const command = launchCommandSchema.parse(JSON.parse(raw.toString()));
        if (command.type === 'drain') {
          if (!this.drain) {
            this.send({ type: 'receipt', nonce: command.nonce, launchId: config.launchId,
              stored: false, ownership: 'none', reason: 'launch-not-bound' });
            return;
          }
          if (this.current) {
            if (this.current.nonce !== command.nonce) throw new Error();
            return;
          }
          const current = { nonce: command.nonce, controller: new AbortController(), intent: false };
          this.current = current;
          void this.begin(current, command.sessionBudgetMs, command.releaseBudgetMs);
          return;
        }
        const current = this.current;
        if (command.type === 'abandon') {
          if (current?.nonce === command.nonce) this.lost();
          return;
        }
        if (!current || current.nonce !== command.nonce || !current.receipt) throw new Error();
        if (command.type === 'release') {
          if (!this.drain!.isCurrent(current.receipt)) { this.lost(); return; }
          current.intent = true;
          this.send({ type: 'intent', nonce: current.nonce, launchId: config.launchId });
        } else {
          if (!current.intent) throw new Error();
          // The daemon received the intent. Revalidate after that ACK before
          // releasing the sole runtime decision; a lost ACK remains blocked.
          this.drain!.releaseRuntime(current.receipt);
        }
      } catch { readyReject(new Error('Standalone launch control invalid')); this.lost(); this.socket.close(1008, 'Invalid launch control'); }
    });
  }
  bind(provider: DrainProvider, storage: ConstructorParameters<typeof SessionDrain>[2], runtime: RuntimeProducerGate): void {
    if (this.drain || this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error('Standalone launch binding unavailable');
    this.runtime = runtime;
        this.drain = new SessionDrain(this.launchId, provider, storage, async () => {}, runtime);
        this.transport?.unref();
  }
  ready(): Promise<void> { return this.connected; }
  private async begin(current: NonNullable<SessionLaunchControl['current']>, budgetMs: number, releaseBudgetMs: number) {
    const drain = this.drain!;
    try {
      const receipt = await drain.drain(budgetMs, current.controller.signal, releaseBudgetMs);
      current.receipt = receipt;
      this.send({ type: 'receipt', nonce: current.nonce, launchId: receipt.launchId,
        stored: receipt.stored, ownership: receipt.ownership, reason: receipt.reason });
      const decision = await drain.outcome(receipt);
      this.send({ type: 'outcome', nonce: current.nonce, launchId: receipt.launchId, decision });
      if (receipt.ownership === 'none') this.current = null;
    } catch {
      this.lost();
      this.send({ type: 'receipt', nonce: current.nonce, launchId: drain.launchId,
        stored: false, ownership: 'unknown', reason: 'drain-start-failed' });
      this.current = null;
    }
  }
  private send(message: object): void {
    if (this.socket.readyState !== WebSocket.OPEN) { this.lost(); return; }
    this.socket.send(JSON.stringify(message), error => { if (error) this.lost(); });
  }
  private lost(): void {
    this.current?.controller.abort();
    if (this.runtime?.isFrozen()) {
      try { this.runtime.blockShutdownStorage(); } catch { /* A received ACK may already have confirmed the decision. */ }
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lost();
    this.socket.close();
    const timer = setTimeout(() => this.socket.terminate(), 1000); timer.unref?.();
    this.socket.once('close', () => clearTimeout(timer));
  }
}
