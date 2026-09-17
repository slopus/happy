import type {
  AgentRequest,
  Machine,
  Message,
  MessageSubscription,
  MessageWatchOptions,
  SendMessageInput,
  SendMessageReceipt,
  Session,
  SpawnSessionInput,
  SpawnSessionResult,
} from '@wangjs-jacky/paws-agent';
import type { ConnectionStatus, RoleId } from '../src/contracts.js';

type Watch = { options: MessageWatchOptions; active: boolean };

export class TestOnlySdk {
  readonly calls: Array<{ role: string; text: string; images: SendMessageInput['images'] }> = [];
  unsubscribeCount = 0;
  readonly sessionsStopped = 0;
  readonly maxConcurrentByRole = new Map<string, number>();
  private readonly watches = new Map<string, Set<Watch>>();
  private readonly messages = new Map<string, Message[]>();
  private readonly sequences = new Map<string, number>();
  private readonly activeByRole = new Map<string, number>();
  private readonly deliveryGates: Promise<void>[] = [];
  private readonly deliveryGatesByRole = new Map<string, Promise<void>[]>();

  constructor(private readonly options: {
    ready?: boolean;
    failRole?: RoleId;
    delayMs?: number;
    spawnDelayMs?: number;
    spawnGate?: Promise<void>;
    linkDelayMs?: number;
  } = {}) {}

  linkCalls = 0;
  readonly recoverCalls: Array<{ serverUrl: string; recoveryCode: string }> = [];
  spawnCalls = 0;
  spawnResolved = 0;
  status(): ConnectionStatus { return this.options.ready === false ? { state: 'disconnected' } : { state: 'ready' }; }
  async link(): Promise<ConnectionStatus> {
    this.linkCalls += 1;
    if (this.options.linkDelayMs) await new Promise(resolve => setTimeout(resolve, this.options.linkDelayMs));
    return this.status();
  }
  async recover(serverUrl: string, recoveryCode: string): Promise<ConnectionStatus> { this.recoverCalls.push({ serverUrl, recoveryCode }); return this.status(); }
  async disconnect(): Promise<void> {}
  async dispose(): Promise<void> {}
  async machines(): Promise<Machine[]> { return [machine('machine-1')]; }

  async spawn(input: SpawnSessionInput & { role?: string }): Promise<SpawnSessionResult> {
    if (!input.role) throw new Error('test SDK requires the role boundary field');
    this.spawnCalls += 1;
    if (this.options.spawnGate) await this.options.spawnGate;
    if (this.options.spawnDelayMs) await new Promise(resolve => setTimeout(resolve, this.options.spawnDelayMs));
    this.spawnResolved += 1;
    return { type: 'success', sessionId: `session-${input.role}` };
  }

  async watch(sessionId: string, options: MessageWatchOptions): Promise<MessageSubscription> {
    const watch: Watch = { options, active: true };
    const watches = this.watches.get(sessionId) ?? new Set<Watch>();
    watches.add(watch);
    this.watches.set(sessionId, watches);
    for (const message of this.messages.get(sessionId) ?? []) {
      if (message.seq > options.afterSeq) options.onMessage(message);
    }
    return {
      unsubscribe: () => {
        if (!watch.active) return;
        watch.active = false;
        watches.delete(watch);
        this.unsubscribeCount += 1;
      },
      sync: async () => undefined,
    };
  }

  async send(input: SendMessageInput): Promise<SendMessageReceipt> {
    const role = input.sessionId.replace('session-', '');
    const call = this.calls.filter(item => item.role === role).length + 1;
    this.calls.push({ role, text: input.text, images: input.images });
    const active = (this.activeByRole.get(role) ?? 0) + 1;
    this.activeByRole.set(role, active);
    this.maxConcurrentByRole.set(role, Math.max(this.maxConcurrentByRole.get(role) ?? 0, active));
    const localId = input.localId ?? crypto.randomUUID();
    const deliveryGate = this.deliveryGatesByRole.get(role)?.shift() ?? this.deliveryGates.shift();
    const deliver = async () => {
      if (deliveryGate) await deliveryGate;
      if (this.options.delayMs) await new Promise(resolve => setTimeout(resolve, this.options.delayMs));
      this.emit(input.sessionId, { role: 'user' }, localId);
      this.emit(input.sessionId, sessionEvent(`root-${call}`, { t: 'turn-start' }));
      this.emit(input.sessionId, sessionEvent(`root-${call}`, { t: 'tool', result: 'tool-secret' }));
      if (this.options.failRole === role) {
        this.emit(input.sessionId, sessionEvent(`root-${call}`, { t: 'turn-end', status: 'failed' }));
      } else {
        this.emit(input.sessionId, sessionEvent(`root-${call}`, { t: 'text', text: `public-${role}-${call}` }));
        this.emit(input.sessionId, sessionEvent(`root-${call}`, { t: 'turn-end', status: 'completed' }));
      }
      this.activeByRole.set(role, (this.activeByRole.get(role) ?? 1) - 1);
    };
    void deliver();
    return { sessionId: input.sessionId, localId };
  }

  async historyPage(sessionId: string, options: { afterSeq: number; limit: number }): Promise<{ messages: Message[]; hasMore: boolean }> {
    const messages = (this.messages.get(sessionId) ?? []).filter(message => message.seq > options.afterSeq).slice(0, options.limit);
    return { messages, hasMore: false };
  }

  async session(sessionId: string): Promise<Session> { return session(sessionId); }
  async requests(): Promise<AgentRequest[]> { return []; }

  callsFor(role: string): Array<{ role: string; text: string; images: SendMessageInput['images'] }> {
    return this.calls.filter(item => item.role === role);
  }

  holdNextDelivery(gate: Promise<void>): void { this.deliveryGates.push(gate); }
  holdNextDeliveryFor(role: string, gate: Promise<void>): void {
    const gates = this.deliveryGatesByRole.get(role) ?? [];
    gates.push(gate);
    this.deliveryGatesByRole.set(role, gates);
  }

  private emit(sessionId: string, content: unknown, localId: string | null = null): void {
    const seq = (this.sequences.get(sessionId) ?? 0) + 1;
    this.sequences.set(sessionId, seq);
    const message: Message = { id: `${sessionId}-${seq}`, seq, content, localId, createdAt: Date.now(), updatedAt: Date.now() };
    const history = this.messages.get(sessionId) ?? [];
    history.push(message);
    this.messages.set(sessionId, history);
    for (const watch of this.watches.get(sessionId) ?? []) if (watch.active) watch.options.onMessage(message);
  }
}

function sessionEvent(turn: string, ev: Record<string, unknown>): unknown {
  return { role: 'session', content: { id: crypto.randomUUID(), time: Date.now(), role: 'agent', turn, ev }, meta: { sentFrom: 'cli' } };
}

function machine(id: string): Machine {
  return { id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, metadata: {}, metadataVersion: 1, daemonState: {}, daemonStateVersion: 1 };
}

function session(id: string): Session {
  return { id, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, metadata: {}, metadataVersion: 1, agentState: { requests: {} }, agentStateVersion: 1 };
}
