import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MessageSubscription, SendMessageInput, SpawnSessionResult } from '@wangjs-jacky/paws-agent';
import {
  ROLE_IDS,
  type AgentMessagesResponse,
  type FollowUpSnapshot,
  type FollowUpStatus,
  type FollowUpInput,
  type ImageRef,
  type RoleId,
  type RoleSnapshot,
  type RunSnapshot,
  type StartInput,
  type TurnProvenance,
} from '../contracts.js';
import { AssetStore } from './assets.js';
import { rolePrompt } from './market.js';
import type { DecodedPartyMessage, PartyBus } from './party.js';
import { DurableTurnDecoder, type TurnTerminal } from './protocol.js';
import { safeError, type PawsSdkBoundary } from './sdk.js';

type StoredRun = { snapshot: RunSnapshot; input: StartInput; cursors: Partial<Record<RoleId, number>> };
type RunsFile = { runs: StoredRun[]; requestIds: Record<string, string>; followupIds?: string[] };

export class RunError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class RunService {
  private readonly runs = new Map<string, StoredRun>();
  private readonly requestIds = new Map<string, string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly executionTasks = new Map<string, Promise<void>>();
  private readonly followupControllers = new Map<string, Set<AbortController>>();
  private readonly followupTasks = new Map<string, Set<Promise<void>>>();
  private readonly pendingSpawns = new Map<string, Promise<SpawnSessionResult>>();
  private readonly followupIds = new Set<string>();
  private readonly startInFlight = new Map<string, Promise<RunSnapshot>>();
  private readonly followupInFlight = new Map<string, Promise<void>>();
  private readonly roleQueues = new Map<string, Promise<void>>();
  private persistQueue: Promise<void> = Promise.resolve();
  private closing = false;

  private constructor(
    private readonly path: string,
    private readonly sdk: PawsSdkBoundary,
    private readonly assets: AssetStore,
    private readonly party: PartyBus,
    private readonly turnTimeoutMs: number,
    file: RunsFile,
  ) {
    for (const run of file.runs) {
      run.snapshot.followUps ??= [];
      run.snapshot.turns ??= [];
      if (run.snapshot.status === 'running') {
        run.snapshot.status = 'interrupted';
        run.snapshot.phase = 'interrupted-after-restart';
        run.snapshot.error = 'Service restarted during this run; it was not replayed.';
      }
      for (const followUp of run.snapshot.followUps) {
        if (!hasActiveFollowUpRole(followUp)) continue;
        const error = 'Service restarted during this follow-up; it was not replayed.';
        for (const [roleId, role] of Object.entries(followUp.roles)) {
          if (role && (role.status === 'queued' || role.status === 'running')) {
            role.status = 'interrupted';
            role.error = error;
            run.snapshot.roles[roleId as RoleId].status = 'interrupted';
            run.snapshot.roles[roleId as RoleId].error = error;
          }
        }
        refreshFollowUp(followUp);
      }
      this.runs.set(run.snapshot.id, run);
    }
    for (const [requestId, id] of Object.entries(file.requestIds)) this.requestIds.set(requestId, id);
    for (const id of file.followupIds ?? []) this.followupIds.add(id);
  }

  static async create(options: {
    dataDir: string;
    sdk: PawsSdkBoundary;
    assets: AssetStore;
    party: PartyBus;
    turnTimeoutMs?: number;
  }): Promise<RunService> {
    const path = join(options.dataDir, 'runs.json');
    let file: RunsFile = { runs: [], requestIds: {} };
    try { file = JSON.parse(await readFile(path, 'utf8')) as RunsFile; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const service = new RunService(path, options.sdk, options.assets, options.party, options.turnTimeoutMs ?? 10 * 60_000, file);
    await service.persist();
    return service;
  }

  list(): RunSnapshot[] {
    return [...this.runs.values()].map(run => clone(run.snapshot)).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): RunSnapshot { return clone(this.requireRun(id).snapshot); }
  hasActiveWork(): boolean {
    return this.startInFlight.size > 0
      || this.followupInFlight.size > 0
      || this.controllers.size > 0
      || [...this.followupControllers.values()].some(controllers => controllers.size > 0)
      || [...this.runs.values()].some(run => run.snapshot.status === 'running');
  }

  async start(input: StartInput): Promise<RunSnapshot> {
    validateStartInput(input);
    const existingId = this.requestIds.get(input.requestId);
    if (existingId) return this.get(existingId);
    const existingStart = this.startInFlight.get(input.requestId);
    if (existingStart) return clone(await existingStart);
    const pending = this.startNew(input);
    this.startInFlight.set(input.requestId, pending);
    try { return clone(await pending); }
    finally { if (this.startInFlight.get(input.requestId) === pending) this.startInFlight.delete(input.requestId); }
  }

  private async startNew(input: StartInput): Promise<RunSnapshot> {
    if (this.sdk.status().state !== 'ready') throw new RunError(409, 'Link a Paws account before starting a consultation.');
    await this.assets.resolveMany(input.images);
    const partyId = await this.party.create(`Synthetic consultation: ${input.stock}`);
    const roles = Object.fromEntries(ROLE_IDS.map(role => [role, {
      role,
      status: input.mode === 'single' && role !== 'moderator' ? 'not-selected' : 'pending',
    } satisfies RoleSnapshot])) as Record<RoleId, RoleSnapshot>;
    const snapshot: RunSnapshot = {
      id: randomUUID(), partyId, stock: input.stock, mode: input.mode,
      status: 'running', phase: 'queued', createdAt: Date.now(), roles, followUps: [], turns: [],
    };
    const stored: StoredRun = { snapshot, input: clone(input), cursors: {} };
    this.runs.set(snapshot.id, stored);
    this.requestIds.set(input.requestId, snapshot.id);
    const controller = new AbortController();
    this.controllers.set(snapshot.id, controller);
    await this.persist();
    const execution = this.execute(stored, controller);
    this.executionTasks.set(snapshot.id, execution);
    void execution.finally(() => {
      if (this.executionTasks.get(snapshot.id) === execution) this.executionTasks.delete(snapshot.id);
    }).catch(() => undefined);
    return clone(snapshot);
  }

  async stop(id: string): Promise<RunSnapshot> {
    const run = this.requireRun(id);
    let changed = false;
    if (run.snapshot.status === 'running') {
      run.snapshot.status = 'stopped';
      run.snapshot.phase = 'coordination-stopped';
      run.snapshot.error = 'Coordination stopped. Already accepted remote work may continue.';
      this.controllers.get(id)?.abort(new DOMException('Coordination stopped', 'AbortError'));
      changed = true;
    }
    const activeFollowUps = run.snapshot.followUps.filter(hasActiveFollowUpRole);
    if (activeFollowUps.length > 0) {
      for (const followUp of activeFollowUps) markFollowUpTerminal(followUp, 'stopped', 'Follow-up coordination stopped. Already accepted remote work may continue.');
      run.snapshot.phase = 'follow-up-stopped';
      for (const controller of this.followupControllers.get(id) ?? []) {
        controller.abort(new DOMException('Follow-up coordination stopped', 'AbortError'));
      }
      changed = true;
    }
    if (changed) await this.persist();
    if (run.snapshot.status === 'stopped') {
      const execution = this.executionTasks.get(id);
      if (execution) await Promise.allSettled([execution]);
    }
    if (activeFollowUps.length > 0) await Promise.allSettled([...(this.followupTasks.get(id) ?? [])]);
    return clone(run.snapshot);
  }

  async agentMessages(id: string, role: RoleId, afterSeq: number): Promise<AgentMessagesResponse> {
    const run = this.requireRun(id);
    const sessionId = run.snapshot.roles[role].sessionId;
    if (!sessionId) return { messages: [], hasMore: false, requests: [], status: run.snapshot.roles[role].status };
    const [page, requests] = await Promise.all([
      this.sdk.historyPage(sessionId, { afterSeq, limit: 200 }),
      this.sdk.requests(sessionId),
    ]);
    return { sessionId, messages: page.messages, hasMore: page.hasMore, requests, status: run.snapshot.roles[role].status };
  }

  async followUp(id: string, input: FollowUpInput): Promise<void> {
    const run = this.requireRun(id);
    if (run.snapshot.status === 'running') throw new RunError(409, 'Follow-ups are accepted only after the initial run is terminal.');
    if (!isRecord(input) || typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 128) {
      throw new RunError(400, 'requestId is required.');
    }
    if (typeof input.text !== 'string' || !Array.isArray(input.images) || !input.images.every(isImageRef)
      || !Array.isArray(input.to) || !input.to.every(role => typeof role === 'string')) {
      throw new RunError(400, 'Malformed follow-up input.');
    }
    if ((!input.text.trim() && input.images.length === 0) || input.text.length > 20_000) {
      throw new RunError(400, 'Provide bounded text, images, or both.');
    }
    const roles = input.to.length === 0 ? ['moderator'] satisfies RoleId[] : [...new Set(input.to)];
    if (roles.some(role => !ROLE_IDS.includes(role))) throw new RunError(400, 'Unknown follow-up recipient.');
    const dedupeKey = `${id}:${input.requestId}`;
    if (this.followupIds.has(dedupeKey)) return;
    const existingFollowUp = this.followupInFlight.get(dedupeKey);
    if (existingFollowUp) return existingFollowUp;
    const pending = this.queueFollowUp(run, input, roles, dedupeKey);
    this.followupInFlight.set(dedupeKey, pending);
    try { await pending; }
    finally { if (this.followupInFlight.get(dedupeKey) === pending) this.followupInFlight.delete(dedupeKey); }
  }

  private async queueFollowUp(run: StoredRun, input: FollowUpInput, roles: RoleId[], dedupeKey: string): Promise<void> {
    await this.assets.resolveMany(input.images);
    const followUp: FollowUpSnapshot = {
      requestId: input.requestId,
      to: roles,
      status: 'queued',
      roles: Object.fromEntries(roles.map(role => [role, { status: 'queued' as const }])),
      createdAt: Date.now(),
    };
    run.snapshot.followUps.push(followUp);
    this.followupIds.add(dedupeKey);
    await this.persist();
    for (const role of roles) {
      const key = `${run.snapshot.id}:${role}`;
      const previous = this.roleQueues.get(key) ?? Promise.resolve();
      const controller = new AbortController();
      mapSet(this.followupControllers, run.snapshot.id).add(controller);
      const queued = previous.catch(() => undefined).then(async () => {
        throwIfAborted(controller.signal);
        followUp.roles[role] = { status: 'running' };
        refreshFollowUp(followUp);
        await this.persist();
        try {
          const images = await this.loadImages(input.images);
          await this.taskTurn(run, role, input.text, input.images, images, controller.signal);
          followUp.roles[role] = { status: 'completed' };
        } catch (error) {
          const roleStatus = followUp.roles[role]?.status;
          if (roleStatus !== 'stopped' && roleStatus !== 'interrupted') {
            const message = safeError(error);
            followUp.roles[role] = { status: 'failed', error: message };
            run.snapshot.roles[role].status = 'failed';
            run.snapshot.roles[role].error = message;
          }
        }
        refreshFollowUp(followUp);
        await this.persist();
      }).catch(async error => {
        const roleStatus = followUp.roles[role]?.status;
        if (roleStatus !== 'stopped' && roleStatus !== 'interrupted') {
          const message = safeError(error);
          followUp.roles[role] = { status: 'failed', error: message };
          run.snapshot.roles[role].status = 'failed';
          run.snapshot.roles[role].error = message;
          refreshFollowUp(followUp);
          await this.persist();
        }
      }).finally(() => {
        this.followupControllers.get(run.snapshot.id)?.delete(controller);
        this.followupTasks.get(run.snapshot.id)?.delete(queued);
      });
      this.roleQueues.set(key, queued);
      mapSet(this.followupTasks, run.snapshot.id).add(queued);
      void queued.catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort(new DOMException('Service closing', 'AbortError'));
    for (const run of this.runs.values()) {
      for (const followUp of run.snapshot.followUps) {
        if (hasActiveFollowUpRole(followUp)) {
          markFollowUpTerminal(followUp, 'interrupted', 'Service closed during this follow-up; it was not replayed.');
        }
      }
    }
    for (const controllers of this.followupControllers.values()) {
      for (const controller of controllers) controller.abort(new DOMException('Service closing', 'AbortError'));
    }
    await this.persist().catch(() => undefined);
    await Promise.allSettled([...this.executionTasks.values(), ...[...this.followupTasks.values()].flatMap(tasks => [...tasks])]);
    await this.persistQueue.catch(() => undefined);
  }

  private async execute(run: StoredRun, controller: AbortController): Promise<void> {
    try {
      const images = await this.loadImages(run.input.images);
      if (run.input.mode === 'single') {
        await this.phase(run, 'moderator');
        await this.taskTurn(run, 'moderator', run.input.text, run.input.images, images, controller.signal);
      } else {
        await this.phase(run, 'moderator-opening');
        await this.taskTurn(run, 'moderator', `Open the consultation, frame the question, and assign the three specialist perspectives. User request: ${run.input.text}`, run.input.images, images, controller.signal);
        await this.phase(run, 'specialist-analysis');
        await Promise.all((['trend30', 'structure10', 'timing1'] satisfies RoleId[]).map(role =>
          this.taskTurn(run, role, `Initial specialist analysis. User request: ${run.input.text}`, run.input.images, images, controller.signal)));
        await this.phase(run, 'specialist-cross-examination');
        await Promise.all((['trend30', 'structure10', 'timing1'] satisfies RoleId[]).map(role =>
          this.taskTurn(run, role, 'Cross-examine the other specialists using the complete party discussion, then publish one revised conclusion.', run.input.images, images, controller.signal)));
        await this.phase(run, 'moderator-summary');
        await this.taskTurn(run, 'moderator', 'Publish the final synthesis from the complete party history.', run.input.images, images, controller.signal);
      }
      if (run.snapshot.status === 'running') {
        run.snapshot.status = 'completed';
        run.snapshot.phase = 'completed';
        await this.persist();
      }
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      if (!this.closing && run.snapshot.status === 'running') {
        run.snapshot.status = 'failed';
        run.snapshot.phase = 'failed';
        run.snapshot.error = safeError(error);
        await this.persist();
      }
    } finally {
      this.controllers.delete(run.snapshot.id);
    }
  }

  private async phase(run: StoredRun, phase: string): Promise<void> { run.snapshot.phase = phase; await this.persist(); }

  private async taskTurn(
    run: StoredRun,
    role: RoleId,
    task: string,
    imageRefs: ImageRef[],
    images: SendMessageInput['images'],
    signal: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    const taskMessage = await this.party.send({ partyId: run.snapshot.partyId, from: 'host', to: [role], text: task, images: imageRefs });
    const turn: TurnProvenance = { runId: run.snapshot.id, partyId: run.snapshot.partyId, participant: role, taskMessageId: taskMessage.id };
    run.snapshot.turns.push(turn);
    await this.persist();
    const history = await this.party.read(run.snapshot.partyId);
    const delivered = history.find(message => message.id === taskMessage.id);
    if (!delivered) throw new Error('Party task delivery was not durably readable.');
    const result = await this.runRemoteTurn(
      run, role, rolePrompt(role, run.input.stock, delivered.text, boundedCompleteContext(history)), images, signal, turn,
    );
    const published = await this.party.send({ partyId: run.snapshot.partyId, from: role, to: '*', text: result, replyTo: taskMessage.id });
    turn.publicMessageId = published.id;
    await this.persist();
    return result;
  }

  private async runRemoteTurn(
    run: StoredRun,
    role: RoleId,
    prompt: string,
    images: SendMessageInput['images'],
    signal: AbortSignal,
    turn: TurnProvenance,
  ): Promise<string> {
    const roleState = run.snapshot.roles[role];
    const deadline = deadlineSignal(signal, this.turnTimeoutMs);
    const runSignal = deadline.signal;
    roleState.status = roleState.sessionId ? 'running' : 'spawning';
    await this.persist();
    let subscription: MessageSubscription | undefined;
    try {
      const sessionId = await this.ensureSession(run, role, runSignal);
      const localId = randomUUID();
      Object.assign(turn, { sessionId, localId });
      await this.persist();
      const decoder = new DurableTurnDecoder(localId);
      const terminal = deferred<TurnTerminal>();
      terminal.promise.catch(() => undefined);
      const pendingWatch = this.sdk.watch(sessionId, {
        afterSeq: run.cursors[role] ?? 0,
        signal: runSignal,
        onMessage: message => {
          run.cursors[role] = Math.max(run.cursors[role] ?? 0, message.seq);
          const result = decoder.accept(message);
          Object.assign(turn, decoder.provenance);
          void this.persist().catch(error => terminal.reject(error));
          if (result) terminal.resolve(result);
        },
        onError: error => terminal.reject(error),
      });
      pendingWatch.then(value => { if (runSignal.aborted) value.unsubscribe(); }).catch(() => undefined);
      subscription = await raceAbort(pendingWatch, runSignal);
      roleState.status = 'running';
      await this.persist();
      const send = raceAbort(this.sdk.send({ sessionId, text: prompt, localId, images, signal: runSignal }), runSignal);
      const [, result] = await raceAbort(Promise.all([send, terminal.promise]), runSignal);
      if (result.type === 'failed') throw new Error(`Remote ${role} turn ${result.status}.`);
      roleState.status = 'completed';
      await this.persist();
      return result.text;
    } catch (error) {
      roleState.status = this.closing ? 'interrupted' : signal.aborted ? 'stopped' : 'failed';
      roleState.error = safeError(error);
      await this.persist();
      throw error;
    } finally {
      subscription?.unsubscribe();
      deadline.dispose();
    }
  }

  private async ensureSession(run: StoredRun, role: RoleId, signal: AbortSignal): Promise<string> {
    const existing = run.snapshot.roles[role].sessionId;
    if (existing) return existing;
    const key = `${run.snapshot.id}:${role}`;
    let pending = this.pendingSpawns.get(key);
    if (!pending) {
      const spawned = this.sdk.spawn({
        role, machineId: run.input.machineId, directory: run.input.directory,
        approvedNewDirectoryCreation: false, agent: run.input.agents[role],
      });
      pending = spawned.then(async result => {
        if (result.type === 'success' && !this.closing) {
          run.snapshot.roles[role].sessionId = result.sessionId;
          await this.persist();
        }
        return result;
      });
      this.pendingSpawns.set(key, pending);
      const tracked = pending;
      void tracked.finally(() => {
        if (this.pendingSpawns.get(key) === tracked) this.pendingSpawns.delete(key);
      }).catch(() => undefined);
    }
    const result = await raceAbort(pending, signal);
    if (result.type === 'requestToApproveDirectoryCreation') {
      throw new Error(`Directory approval required for ${result.directory}; approve it in Paws before retrying.`);
    }
    if (result.type === 'error') throw new Error(result.errorMessage);
    if (!run.snapshot.roles[role].sessionId && !this.closing) {
      run.snapshot.roles[role].sessionId = result.sessionId;
      await this.persist();
    }
    return result.sessionId;
  }

  private async loadImages(refs: ImageRef[]): Promise<SendMessageInput['images']> {
    return (await this.assets.resolveMany(refs)).map(({ ref, bytes }) => ({ name: ref.name, mimeType: ref.mimeType, bytes }));
  }

  private requireRun(id: string): StoredRun {
    const run = this.runs.get(id);
    if (!run) throw new RunError(404, 'Consultation not found.');
    return run;
  }

  private persist(): Promise<void> {
    const file: RunsFile = {
      runs: [...this.runs.values()], requestIds: Object.fromEntries(this.requestIds), followupIds: [...this.followupIds],
    };
    this.persistQueue = this.persistQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(file), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    });
    return this.persistQueue;
  }
}

function validateStartInput(input: StartInput): void {
  if (!isRecord(input)) throw new RunError(400, 'Invalid consultation input.');
  if (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 128) throw new RunError(400, 'requestId is required.');
  if (typeof input.stock !== 'string' || !input.stock.trim() || input.stock.length > 40) throw new RunError(400, 'stock is required.');
  if (typeof input.text !== 'string' || !Array.isArray(input.images) || !input.images.every(isImageRef)) {
    throw new RunError(400, 'Malformed text or image references.');
  }
  if ((!input.text.trim() && input.images.length === 0)) throw new RunError(400, 'Provide text, images, or both.');
  if (input.text.length > 20_000) throw new RunError(413, 'Consultation text is too large.');
  if (typeof input.machineId !== 'string' || !input.machineId.trim()
    || typeof input.directory !== 'string' || !input.directory.trim()) throw new RunError(400, 'machineId and directory are required.');
  if (input.mode !== 'single' && input.mode !== 'consultation') throw new RunError(400, 'Invalid consultation mode.');
  if (!isRecord(input.agents)) throw new RunError(400, 'agents are required.');
  for (const role of ROLE_IDS) {
    if (!['codex', 'claude', 'gemini', 'opencode'].includes(input.agents?.[role])) throw new RunError(400, `Invalid engine for ${role}.`);
  }
}

function boundedCompleteContext(history: DecodedPartyMessage[]): string {
  const text = history.map(message => `${message.from}: ${message.text}`).join('\n');
  if (text.length > 128_000) throw new RunError(413, 'Complete party history exceeds the follow-up context budget.');
  return text;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); reject(abortReason(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw abortReason(signal); }
function abortReason(signal: AbortSignal): Error { return signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'); }
function clone<T>(value: T): T { return structuredClone(value); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isImageRef(value: unknown): value is ImageRef {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.mimeType === 'string'
    && typeof value.size === 'number';
}

function markFollowUpTerminal(followUp: FollowUpSnapshot, status: Extract<FollowUpStatus, 'stopped' | 'interrupted'>, error: string): void {
  for (const role of Object.values(followUp.roles)) {
    if (role && (role.status === 'queued' || role.status === 'running')) {
      role.status = status;
      role.error = error;
    }
  }
  refreshFollowUp(followUp);
}

function refreshFollowUp(followUp: FollowUpSnapshot): void {
  const roles = Object.values(followUp.roles).filter(value => value !== undefined);
  const statuses = roles.map(role => role.status);
  if (statuses.includes('running')) followUp.status = 'running';
  else if (statuses.includes('queued')) followUp.status = 'queued';
  else if (statuses.includes('failed')) followUp.status = 'failed';
  else if (statuses.includes('interrupted')) followUp.status = 'interrupted';
  else if (statuses.includes('stopped')) followUp.status = 'stopped';
  else if (statuses.length > 0 && statuses.every(status => status === 'completed')) followUp.status = 'completed';
  else followUp.status = 'queued';
  const error = roles.find(role => role.error)?.error;
  if (error) followUp.error = error;
  else delete followUp.error;
}

function hasActiveFollowUpRole(followUp: FollowUpSnapshot): boolean {
  return Object.values(followUp.roles).some(role => role?.status === 'queued' || role?.status === 'running');
}

function mapSet<T>(map: Map<string, Set<T>>, key: string): Set<T> {
  const existing = map.get(key);
  if (existing) return existing;
  const created = new Set<T>();
  map.set(key, created);
  return created;
}

function deadlineSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortReason(parent));
  if (parent.aborted) onAbort();
  else parent.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Remote turn deadline exceeded.')), Math.max(0, timeoutMs));
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); parent.removeEventListener('abort', onAbort); },
  };
}
