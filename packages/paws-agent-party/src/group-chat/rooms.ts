import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MessageSubscription, SendMessageInput, SpawnSessionResult } from '@wangjs-jacky/paws-agent';
import type { AgentMessagesResponse, ImageRef, TurnProvenance } from '../contracts.js';
import { AssetStore } from '../server/assets.js';
import { DurableTurnDecoder, type TurnTerminal } from '../server/protocol.js';
import { RunError } from '../server/runs.js';
import { safeError, type PawsSdkBoundary } from '../server/sdk.js';
import type { PartyBus } from '../server/party.js';
import { normalizeProfileInput, type AgentProfile, type AgentProfileInput, type ProfileService } from './profiles.js';
import { resolveMentionTargets, type RoomMember } from './routing.js';
import { debateTurn, validateMaxRounds, validateDebateMembers, type DebateSnapshot } from './debate.js';
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_EFFORT, type CodexEffort } from './codex-profile.js';

export type RoomAgentSnapshot = RoomMember & { engine: 'codex'; model: string; effort: CodexEffort; avatarId: number; machineId?: string; directory?: string; temporary?: boolean; status: 'idle' | 'spawning' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'; sessionId?: string; error?: string };
export type GroupRoomSnapshot = {
  id: string; partyId: string; title: string; machineId: string; directory: string; autoReply: boolean; createdAt: number; updatedAt: number;
  autoDebate: boolean; maxRounds: number; debate?: DebateSnapshot;
  members: RoomAgentSnapshot[]; turns: GroupTurn[]; error?: string;
};
export type GroupTurn = TurnProvenance & { debateId?: string; round?: number; phase?: 'opening' | 'rebuttal'; live?: { text: string; status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'; createdAt: number; error?: string } };
export type CreateGroupRoomInput = { requestId: string; title: string; memberIds: string[]; machineId: string; directory: string; autoReply?: boolean; autoDebate?: boolean; maxRounds?: number };
export type GroupMessageInput = { requestId: string; text: string; images: ImageRef[] };
type StoredRoom = { snapshot: GroupRoomSnapshot; cursors: Record<string, number>; deliveries?: Record<string, { sessionId: string; cursor: string }> };
type RoomDeletion = { roomId: string; partyId: string };
type RoomsFile = { rooms: StoredRoom[]; requestIds: Record<string, string>; messageRequestIds: string[]; memberRequestIds?: string[]; deletions?: RoomDeletion[] };

export class GroupRoomService {
  private readonly rooms = new Map<string, StoredRoom>();
  private readonly createRequests = new Map<string, string>();
  private readonly messageRequests = new Set<string>();
  private readonly memberRequests = new Set<string>();
  private readonly deletions = new Map<string, string>();
  private readonly durableDeletions = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly pendingSpawns = new Map<string, Promise<SpawnSessionResult>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly admissions = new Map<string, Promise<unknown>>();
  private readonly debateJobs = new Map<string, Promise<void>>();
  private readonly epochs = new Map<string, number>();
  private persistQueue: Promise<void> = Promise.resolve();
  private closing = false;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly deletionListeners = new Map<string, Set<() => void>>();

  subscribe(id: string, listener: () => void): () => void {
    this.require(id);
    const listeners = this.listeners.get(id) ?? new Set(); listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  subscribeDeletion(id: string, listener: () => void): () => void {
    this.require(id);
    const listeners = this.deletionListeners.get(id) ?? new Set(); listeners.add(listener); this.deletionListeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.deletionListeners.delete(id); };
  }
  private changed(room: StoredRoom): void {
    room.snapshot.updatedAt = Math.max(Date.now(), room.snapshot.updatedAt + 1);
    for (const listener of this.listeners.get(room.snapshot.id) ?? []) listener();
  }

  private constructor(private readonly path: string, private readonly sdk: PawsSdkBoundary, private readonly assets: AssetStore, private readonly party: PartyBus, private readonly profiles: ProfileService, private readonly timeoutMs: number, file: RoomsFile) {
    for (const deletion of file.deletions ?? []) { this.deletions.set(deletion.roomId, deletion.partyId); this.durableDeletions.add(deletion.roomId); }
    for (const room of file.rooms ?? []) {
      if (this.deletions.has(room.snapshot.id)) continue;
      for (const turn of room.snapshot.turns) if (turn.live?.status === 'running') { turn.live.status = 'interrupted'; turn.live.error = '服务已重启，本次回复未自动重放。'; }
      room.snapshot.autoDebate ??= false; room.snapshot.maxRounds ??= 10;
      if (room.snapshot.debate?.status === 'running') { room.snapshot.debate.status = 'interrupted'; room.snapshot.debate.nextMemberId = null; room.snapshot.debate.stopReason = 'Service restarted; debate was not replayed. Remote work may continue.'; }
      for (const member of room.snapshot.members) {
        if (member.status === 'spawning' || member.status === 'running') { member.status = 'interrupted'; member.error = 'Service restarted; this turn was not replayed.'; }
        // Legacy sessions may have a different engine or unknown effective model.
        // Preserve their provenance, but create a fresh session on the next task.
        if (member.engine !== 'codex' || member.model === undefined || member.effort === undefined) {
          delete member.sessionId; delete room.cursors[member.id];
        }
        member.engine = 'codex'; member.model ??= DEFAULT_CODEX_MODEL; member.effort ??= DEFAULT_CODEX_EFFORT;
        member.avatarId ??= 0;
      }
      this.rooms.set(room.snapshot.id, room);
    }
    for (const [requestId, id] of Object.entries(file.requestIds ?? {})) this.createRequests.set(requestId, id);
    for (const id of file.messageRequestIds ?? []) this.messageRequests.add(id);
    for (const id of file.memberRequestIds ?? []) this.memberRequests.add(id);
  }

  static async create(options: { dataDir: string; sdk: PawsSdkBoundary; assets: AssetStore; party: PartyBus; profiles: ProfileService; turnTimeoutMs?: number }): Promise<GroupRoomService> {
    const path = join(options.dataDir, 'group-chat-rooms.json'); let file: RoomsFile = { rooms: [], requestIds: {}, messageRequestIds: [] };
    try { file = JSON.parse(await readFile(path, 'utf8')) as RoomsFile; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const service = new GroupRoomService(path, options.sdk, options.assets, options.party, options.profiles, options.turnTimeoutMs ?? 10 * 60_000, file);
    await service.persist();
    for (const [roomId, partyId] of [...service.deletions]) {
      try { await service.party.delete(partyId); service.deletions.delete(roomId); service.durableDeletions.delete(roomId); await service.persist(); }
      catch { /* Keep the durable tombstone for the next explicit retry or restart. */ }
    }
    for (const room of service.rooms.values()) {
      const debate = room.snapshot.debate;
      if (debate && debate.status !== 'running' && !debate.terminalMessageId) await service.publishDebateEnd(room, debate);
    }
    return service;
  }
  list(): GroupRoomSnapshot[] { return [...this.rooms.values()].map(room => clone(room.snapshot)).sort((a, b) => b.updatedAt - a.updatedAt); }
  get(id: string): GroupRoomSnapshot { return clone(this.require(id).snapshot); }
  hasActiveWork(): boolean { return this.controllers.size > 0 || this.queues.size > 0 || this.debateJobs.size > 0 || this.admissions.size > 0 || [...this.rooms.values()].some(room => room.snapshot.debate?.status === 'running' || room.snapshot.members.some(member => member.status === 'spawning' || member.status === 'running')); }

  async create(input: CreateGroupRoomInput): Promise<GroupRoomSnapshot> {
    if (this.createRequests.has(input.requestId)) return this.get(this.createRequests.get(input.requestId)!);
    if (this.sdk.status().state !== 'ready') throw new RunError(409, 'Link a Paws account before creating a group.');
    if (!input.requestId?.trim() || !input.title?.trim() || input.title.length > 100 || !input.machineId?.trim() || !input.directory?.trim()) throw new RunError(400, 'A group needs a title, machine, and working directory.');
    if (!isAbsoluteDirectory(input.directory.trim())) throw new RunError(400, 'Enter an absolute working directory already approved in Paws, for example /home/node.');
    validateMaxRounds(input.maxRounds ?? 10);
    if (input.autoReply !== undefined && typeof input.autoReply !== 'boolean') throw new RunError(400, 'autoReply must be boolean.');
    if (input.autoDebate !== undefined && typeof input.autoDebate !== 'boolean') throw new RunError(400, 'autoDebate must be boolean.');
    const profiles = this.profiles.members(input.memberIds);
    const partyId = await this.party.createGroup({ title: input.title.trim(), participants: profiles.map(profile => ({ id: profile.id, description: profile.instructions })) });
    const now = Date.now(); const snapshot: GroupRoomSnapshot = { id: randomUUID(), partyId, title: input.title.trim(), machineId: input.machineId, directory: input.directory, autoReply: input.autoReply ?? true, autoDebate: input.autoDebate ?? false, maxRounds: input.maxRounds ?? 10, createdAt: now, updatedAt: now, members: profiles.map(toMember), turns: [] };
    this.rooms.set(snapshot.id, { snapshot, cursors: {} }); this.createRequests.set(input.requestId, snapshot.id); await this.persist(); return clone(snapshot);
  }

  async setAutoReply(id: string, autoReply: boolean): Promise<GroupRoomSnapshot> { const room = this.require(id); room.snapshot.autoReply = Boolean(autoReply); room.snapshot.updatedAt = Date.now(); await this.persist(); return clone(room.snapshot); }

  async addMembers(id: string, input: { requestId: string; memberIds?: string[]; temporary?: AgentProfileInput[] }): Promise<GroupRoomSnapshot> {
    return this.serialize(id, async () => {
      const room = this.require(id); const key = `${id}:${input?.requestId}`;
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.requestId !== 'string' || !input.requestId.trim()) throw new RunError(400, 'A member invitation needs a request id.');
      if (this.memberRequests.has(key)) return clone(room.snapshot);
      const memberIds = input.memberIds ?? []; const temporary = input.temporary ?? [];
      if (!Array.isArray(memberIds) || !Array.isArray(temporary) || memberIds.some(value => typeof value !== 'string')) throw new RunError(400, 'Invalid member invitation.');
      const existingIds = new Set(room.snapshot.members.map(member => member.id));
      const profiles = [...new Set(memberIds)].filter(profileId => !existingIds.has(profileId)).map(profileId => this.profiles.get(profileId));
      const temporaryProfiles = temporary.map(value => normalizeProfileInput(value));
      const names = [...room.snapshot.members.map(member => member.name), ...profiles.map(profile => profile.name), ...temporaryProfiles.map(profile => profile.name)];
      if (new Set(names).size !== names.length) throw new RunError(409, 'Agent display names must be unique in a room.');
      if (profiles.length + temporaryProfiles.length === 0) { this.memberRequests.add(key); await this.persist(); return clone(room.snapshot); }
      const additions: RoomAgentSnapshot[] = [
        ...profiles.map(toMember),
        ...temporaryProfiles.map(profile => ({ id: `agent-${randomUUID().replaceAll('-', '').slice(0, 16)}`, ...profile, temporary: true, status: 'idle' as const })),
      ];
      for (const member of additions) await this.party.join(room.snapshot.partyId, { id: member.id, description: member.instructions });
      room.snapshot.members.push(...additions); this.memberRequests.add(key); await this.persist(); return clone(room.snapshot);
    });
  }

  async delete(id: string): Promise<void> {
    return this.serialize(id, async () => {
      const pendingPartyId = this.deletions.get(id);
      if (pendingPartyId) {
        if (!this.durableDeletions.has(id)) { await this.persist(); this.durableDeletions.add(id); }
        await this.party.delete(pendingPartyId); this.deletions.delete(id); this.durableDeletions.delete(id); await this.persist(); return;
      }
      const room = this.require(id);
      if (room.snapshot.debate?.status === 'running' || this.debateJobs.has(id) || room.snapshot.members.some(member => member.status === 'spawning' || member.status === 'running') || [...this.queues.keys()].some(key => key.startsWith(`${id}:`)) || [...this.controllers.keys()].some(key => key.startsWith(`${id}:`))) throw new RunError(409, 'Stop active group work before deleting this room.');
      this.deletions.set(id, room.snapshot.partyId);
      this.rooms.delete(id); this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
      for (const [requestId, roomId] of this.createRequests) if (roomId === id) this.createRequests.delete(requestId);
      for (const key of this.messageRequests) if (key.startsWith(`${id}:`)) this.messageRequests.delete(key);
      for (const key of this.memberRequests) if (key.startsWith(`${id}:`)) this.memberRequests.delete(key);
      for (const listener of this.deletionListeners.get(id) ?? []) listener();
      this.listeners.delete(id); this.deletionListeners.delete(id);
      await this.persist();
      this.durableDeletions.add(id);
      await this.party.delete(room.snapshot.partyId);
      this.deletions.delete(id); this.durableDeletions.delete(id); await this.persist();
    });
  }

  async configure(id: string, input: { autoReply?: boolean; autoDebate?: boolean; maxRounds?: number }): Promise<GroupRoomSnapshot> {
    return this.serialize(id, async () => {
      const room = this.require(id);
      if (!input || typeof input !== 'object' || Array.isArray(input) || !['autoReply', 'autoDebate', 'maxRounds'].some(key => key in input)) throw new RunError(400, 'Provide a group setting.');
      for (const key of ['autoReply', 'autoDebate'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new RunError(400, `${key} must be boolean.`);
      if (input.maxRounds !== undefined) validateMaxRounds(input.maxRounds);
      if (room.snapshot.debate?.status === 'running' && input.maxRounds !== undefined && input.maxRounds !== room.snapshot.maxRounds) throw new RunError(409, 'Stop the active debate before changing its round limit.');
      if (input.autoReply !== undefined) room.snapshot.autoReply = input.autoReply;
      if (input.autoDebate !== undefined) room.snapshot.autoDebate = input.autoDebate;
      if (input.maxRounds !== undefined) room.snapshot.maxRounds = input.maxRounds;
      if (input.autoDebate === false) await this.stopDebate(id);
      room.snapshot.updatedAt = Date.now(); await this.persist(); return clone(room.snapshot);
    });
  }

  async message(id: string, input: GroupMessageInput): Promise<{ route: ReturnType<typeof resolveMentionTargets>; room: GroupRoomSnapshot }> {
    return this.serialize(id, () => this.acceptMessage(id, input));
  }

  private async acceptMessage(id: string, input: GroupMessageInput): Promise<{ route: ReturnType<typeof resolveMentionTargets>; room: GroupRoomSnapshot }> {
    if (this.closing) throw new RunError(409, 'Service is closing.');
    const room = this.require(id); const key = `${id}:${input.requestId}`;
    if (!input.requestId?.trim() || typeof input.text !== 'string' || !Array.isArray(input.images) || (!input.text.trim() && input.images.length === 0) || input.text.length > 20_000) throw new RunError(400, 'Provide bounded text or images with a request id.');
    const route = resolveMentionTargets(input.text, room.snapshot.members, room.snapshot.autoReply);
    if (route.mode === 'invalid') throw new RunError(400, `These @ agents are not in this group: ${route.unknown.join('、')}`);
    if (this.messageRequests.has(key)) return { route, room: clone(room.snapshot) };
    if (room.snapshot.debate?.status === 'running' || this.debateJobs.has(id)) throw new RunError(409, 'A debate is already active. Stop it before sending another task.');
    const startsDebate = room.snapshot.autoDebate && route.mode === 'mention' && route.ids.length >= 2;
    if (startsDebate && [...this.queues.keys()].some(key => key.startsWith(`${id}:`))) throw new RunError(409, 'Wait for current group replies before starting a debate.');
    await this.assets.resolveMany(input.images);
    const publicMessage = await this.party.send({ partyId: room.snapshot.partyId, from: 'host', to: '*', text: input.text, images: input.images });
    this.messageRequests.add(key); room.snapshot.updatedAt = Date.now();
    if (startsDebate) await this.startDebate(room, route.ids, publicMessage.id, input);
    else { await this.persist(); for (const agentId of route.ids) void this.enqueue(room, agentId, publicMessage.id, input).catch(() => undefined); }
    return { route, room: clone(room.snapshot) };
  }

  private async startDebate(room: StoredRoom, members: string[], sourceMessageId: string, input: GroupMessageInput): Promise<void> {
    validateMaxRounds(room.snapshot.maxRounds);
    validateDebateMembers(members);
    const debate: DebateSnapshot = { id: randomUUID(), status: 'running', members, maxRounds: room.snapshot.maxRounds, completedRounds: 0, completedTurns: 0, currentTurn: 1, nextMemberId: members[0]!, sourceMessageId };
    room.snapshot.debate = debate;
    await this.persist();
    if (debate.status !== 'running' || this.closing) return;
    const job = this.runDebate(room, debate, input); this.debateJobs.set(room.snapshot.id, job);
    void job.finally(() => { if (this.debateJobs.get(room.snapshot.id) === job) this.debateJobs.delete(room.snapshot.id); }).catch(() => undefined);
  }

  private async runDebate(room: StoredRoom, debate: DebateSnapshot, input: GroupMessageInput): Promise<void> {
    try {
      while (debate.status === 'running' && !this.closing) {
        const next = debateTurn(debate); debate.currentTurn = debate.completedTurns + 1; debate.nextMemberId = next.memberId;
        await this.persist();
        if (debate.status !== 'running' || this.closing) break;
        const ok = await this.runTurn(room, next.memberId, debate.sourceMessageId, input, { debateId: debate.id, round: next.round, phase: next.phase });
        if (debate.status !== 'running' || this.closing) break;
        if (!ok) { debate.status = 'failed'; debate.stopReason = `${displayName(room.snapshot.members, next.memberId)}: ${room.snapshot.members.find(member => member.id === next.memberId)?.error ?? 'Turn failed.'}`; break; }
        debate.completedTurns++; debate.completedRounds = Math.floor(debate.completedTurns / debate.members.length);
        if (debate.completedTurns === debate.maxRounds * debate.members.length) { debate.status = 'completed'; break; }
        debate.nextMemberId = debate.members[debate.completedTurns % debate.members.length]!; await this.persist();
      }
    } catch (error) { if (debate.status === 'running') { debate.status = 'failed'; debate.stopReason = safeError(error); } }
    if (debate.status !== 'running') { debate.nextMemberId = null; await this.persist(); if (!this.closing) await this.publishDebateEnd(room, debate); }
  }

  async stopDebate(id: string): Promise<GroupRoomSnapshot> {
    const room = this.require(id); const debate = room.snapshot.debate;
    if (debate?.status === 'running') {
      debate.status = 'stopped'; debate.nextMemberId = null; debate.stopReason = '已停止，未再派发新回合。远端已接受的任务可能继续。';
      this.abortRoom(id, 'Debate stopped'); room.snapshot.updatedAt = Date.now(); await this.persist();
      await this.debateJobs.get(id); await this.publishDebateEnd(room, debate);
    }
    return clone(room.snapshot);
  }

  private async publishDebateEnd(room: StoredRoom, debate: DebateSnapshot): Promise<void> {
    if (debate.terminalMessageId) return;
    const label = debate.status === 'completed' ? `辩论已在第 ${debate.completedRounds} / ${debate.maxRounds} 轮结束` : `辩论${debate.status === 'stopped' ? '已停止' : debate.status === 'interrupted' ? '已中断' : '失败'}：${debate.stopReason ?? ''}`;
    try {
      const message = await this.party.send({ partyId: room.snapshot.partyId, from: 'host', to: '*', text: label, replyTo: debate.sourceMessageId });
      debate.terminalMessageId = message.id;
      room.snapshot.error = undefined;
    } catch (error) {
      // The durable terminal state remains authoritative. A later service start
      // retries any state that has no terminal public message yet.
      room.snapshot.error = `Unable to publish debate end: ${safeError(error)}`;
    }
    await this.persist();
  }

  async agentMessages(id: string, agentId: string, afterSeq: number): Promise<AgentMessagesResponse> {
    const member = this.require(id).snapshot.members.find(value => value.id === agentId); if (!member) throw new RunError(404, 'Agent is not in this group.');
    if (!member.sessionId) return { messages: [], hasMore: false, requests: [], status: member.status };
    const [page, requests] = await Promise.all([this.sdk.historyPage(member.sessionId, { afterSeq, limit: 200 }), this.sdk.requests(member.sessionId)]);
    return { sessionId: member.sessionId, messages: page.messages, hasMore: page.hasMore, requests, status: member.status };
  }
  async stop(id: string): Promise<GroupRoomSnapshot> { const room = this.require(id); await this.stopDebate(id); this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1); this.abortRoom(id, 'Group execution stopped'); for (const member of room.snapshot.members) if (member.status === 'spawning' || member.status === 'running') { member.status = 'stopped'; member.error = 'Group execution stopped. Accepted remote work may continue.'; } await this.persist(); return clone(room.snapshot); }
  async close(): Promise<void> {
    this.closing = true;
    for (const room of this.rooms.values()) if (room.snapshot.debate?.status === 'running') { room.snapshot.debate.status = 'interrupted'; room.snapshot.debate.nextMemberId = null; room.snapshot.debate.stopReason = 'Service stopped; debate was not replayed. Remote work may continue.'; }
    for (const controller of this.controllers.values()) controller.abort(new DOMException('Service closing', 'AbortError'));
    await Promise.allSettled([...this.admissions.values(), ...this.queues.values(), ...this.debateJobs.values()]);
    await this.persist().catch(() => undefined); await this.persistQueue.catch(() => undefined);
  }

  private abortRoom(id: string, reason: string): void { for (const [key, controller] of this.controllers) if (key.startsWith(`${id}:`)) controller.abort(new DOMException(reason, 'AbortError')); }
  private async serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.admissions.get(id) ?? Promise.resolve(); const next = prior.catch(() => undefined).then(operation); this.admissions.set(id, next);
    try { return await next; } finally { if (this.admissions.get(id) === next) this.admissions.delete(id); }
  }

  private async enqueue(room: StoredRoom, agentId: string, replyTo: string, input: GroupMessageInput): Promise<void> {
    const key = `${room.snapshot.id}:${agentId}`; const prior = this.queues.get(key) ?? Promise.resolve();
    const epoch = this.epochs.get(room.snapshot.id) ?? 0;
    const next = prior.catch(() => undefined).then(async () => { if (!this.closing && epoch === (this.epochs.get(room.snapshot.id) ?? 0)) await this.runTurn(room, agentId, replyTo, input); }); this.queues.set(key, next);
    try { await next; } finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }
  private async runTurn(room: StoredRoom, agentId: string, replyTo: string, input: GroupMessageInput, debate?: Pick<GroupTurn, 'debateId' | 'round' | 'phase'>): Promise<boolean> {
    const member = room.snapshot.members.find(value => value.id === agentId); if (!member || this.closing) return false;
    const controller = new AbortController(); this.controllers.set(`${room.snapshot.id}:${agentId}`, controller);
    let turn: GroupTurn | undefined;
    try {
      member.error = undefined;
      const direction = debate ? `辩论第 ${debate.round} 轮 · ${debate.phase === 'opening' ? '立论：先阐述你的立场及理由。' : `交锋 ${debate.round}：直接回应对方最近的观点，指出分歧或修正自己的判断。`}请以你的角色发言。` : '请以你的角色回应刚才的群聊消息。';
      const task = await this.party.send({ partyId: room.snapshot.partyId, from: 'host', to: [agentId], text: `${direction}不要展示工具过程、凭据或隐藏推理；直接给出面向群聊的简洁结论。`, replyTo });
      turn = { runId: room.snapshot.id, partyId: room.snapshot.partyId, participant: agentId as never, taskMessageId: task.id, ...debate, live: { text: '', status: 'running', createdAt: Date.now() } }; room.snapshot.turns.push(turn);
      const previous = room.deliveries?.[agentId];
      const delivery = previous?.sessionId === member.sessionId ? previous : undefined;
      const history = await this.party.read(room.snapshot.partyId, delivery ? { since: delivery.cursor } : undefined);
      // Skip only this session's own generated replies. A replacement session
      // must receive older replies too. Internal scheduling tasks are not chat.
      const ownReplies = new Set(room.snapshot.turns.filter(value => value.sessionId === member.sessionId && value.participant === agentId).map(value => value.publicMessageId));
      const unread = history.filter(message => message.to === '*' && !ownReplies.has(message.id));
      const context = unread.map(message => `[${message.id}] ${displayName(room.snapshot.members, message.from)}: ${message.text}`).join('\n');
      // Never silently discard unseen messages and then advance past them.
      if (context.length > 100_000) throw new RunError(413, 'Unread group context exceeds the delivery budget; no messages were marked read.');
      const prompt = `你是 AgentParty 群聊成员「${member.name}」。\n\n你的角色：${member.instructions}\n\n以下是尚未投递给你的群聊消息；结合本会话已有上下文回答，不要复述历史。不要臆造事实，也不要暴露工具调用、凭据或隐藏推理。\n\n${context}\n\n本次指派：${direction}\n回应群消息 ID：${replyTo}`;
      // Preserve the existing per-task attachment contract (SDK maximum: four).
      // Replaying attachments from every historical message can wedge a member.
      const result = await this.remote(room, member, prompt, await this.loadImages(input.images), controller.signal, turn);
      controller.signal.throwIfAborted();
      const published = await this.party.send({ partyId: room.snapshot.partyId, from: member.id, to: '*', text: result, replyTo: task.id }); turn.publicMessageId = published.id;
      turn.live = { ...turn.live!, text: result, status: 'completed' };
      // Commit the read snapshot, NOT the new reply's cursor: other members or
      // the user may have posted while this remote turn was running.
      const cursor = history.at(-1)?.cursor;
      if (cursor && member.sessionId) (room.deliveries ??= {})[agentId] = { sessionId: member.sessionId, cursor };
      return true;
    } catch (error) { member.status = this.closing ? 'interrupted' : controller.signal.aborted ? 'stopped' : 'failed'; member.error = safeError(error); if (turn?.live) { turn.live.status = member.status; turn.live.error = member.error; } return false; }
    finally { this.controllers.delete(`${room.snapshot.id}:${agentId}`); await this.persist(); }
  }
  private async remote(room: StoredRoom, member: RoomAgentSnapshot, prompt: string, images: SendMessageInput['images'], signal: AbortSignal, turn: GroupTurn): Promise<string> {
    signal.throwIfAborted(); member.status = member.sessionId ? 'running' : 'spawning'; await this.persist(); signal.throwIfAborted(); const deadline = timeout(signal, this.timeoutMs); let subscription: MessageSubscription | undefined;
    let unsubscribeText: (() => void) | undefined;
    try {
      const sessionId = await this.session(room, member, deadline.signal); const localId = randomUUID(); Object.assign(turn, { sessionId, localId });
      const decoder = new DurableTurnDecoder(localId); const terminal = deferred<TurnTerminal>(); terminal.promise.catch(() => undefined);
      // Cumulative item snapshots replace, never append, overlapping chunks.
      // Durable echo + root-turn-start remain the authority for accepting text.
      const streamed = new Map<string, { turnId: string; itemId: string; text: string }>();
      const updateText = () => {
        if (deadline.signal.aborted || !turn.live || !decoder.provenance.rootTurnId) return;
        const items = new Map<string, string>();
        for (const item of streamed.values()) if (item.turnId === decoder.provenance.rootTurnId) items.set(item.itemId, item.text);
        for (const [id, text] of decoder.publicItems) items.set(id, text);
        const text = [...items.values()].join('\n\n').slice(0, 100_000);
        if (text !== turn.live.text) { turn.live.text = text; this.changed(room); }
      };
      unsubscribeText = this.sdk.subscribeText?.(event => {
        if (deadline.signal.aborted || decoder.finished || event.sessionId !== sessionId || (decoder.provenance.rootTurnId && event.turnId !== decoder.provenance.rootTurnId)) return;
        const key = `${event.turnId}:${event.itemId}`;
        if (!streamed.has(key) && streamed.size >= 32) return;
        if (event.text.length > 100_000) return;
        streamed.set(key, { turnId: event.turnId, itemId: event.itemId, text: event.text }); updateText();
      });
      const pending = this.sdk.watch(sessionId, { afterSeq: room.cursors[member.id] ?? 0, signal: deadline.signal, onMessage: message => { if (deadline.signal.aborted) return; room.cursors[member.id] = Math.max(room.cursors[member.id] ?? 0, message.seq); const outcome = decoder.accept(message); Object.assign(turn, decoder.provenance); updateText(); if (outcome) terminal.resolve(outcome); }, onError: error => terminal.reject(error) });
      void pending.then(value => { if (deadline.signal.aborted) value.unsubscribe(); }, () => undefined);
      subscription = await abortable(pending, deadline.signal); member.status = 'running'; await this.persist(); deadline.signal.throwIfAborted();
      const [, outcome] = await abortable(Promise.all([this.sdk.send({ sessionId, text: prompt, localId, images, meta: { model: member.model, effort: member.effort }, signal: deadline.signal }), terminal.promise]), deadline.signal);
      if (outcome.type === 'failed') throw new Error(`Remote ${member.name} turn ${outcome.status}.`); member.status = 'completed'; return outcome.text;
    } finally { unsubscribeText?.(); subscription?.unsubscribe(); deadline.dispose(); }
  }
  private async session(room: StoredRoom, member: RoomAgentSnapshot, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted(); if (member.sessionId) return member.sessionId; const key = `${room.snapshot.id}:${member.id}`; let pending = this.pendingSpawns.get(key);
    if (!pending) { pending = this.sdk.spawn({ role: member.id, machineId: member.machineId ?? room.snapshot.machineId, directory: member.directory ?? room.snapshot.directory, approvedNewDirectoryCreation: false, agent: 'codex', model: member.model, effort: member.effort }); this.pendingSpawns.set(key, pending); void pending.finally(() => this.pendingSpawns.delete(key)).catch(() => undefined); }
    const result = await abortable(pending, signal); if (result.type === 'requestToApproveDirectoryCreation') throw new Error(`Directory approval required for ${result.directory}; approve it in Paws before retrying.`); if (result.type === 'error') throw new Error(result.errorMessage); member.sessionId = result.sessionId; await this.persist(); return result.sessionId;
  }
  private async loadImages(images: ImageRef[]): Promise<SendMessageInput['images']> { return (await this.assets.resolveMany(images)).map(({ ref, bytes }) => ({ name: ref.name, mimeType: ref.mimeType, bytes })); }
  private require(id: string): StoredRoom { const room = this.rooms.get(id); if (!room) throw new RunError(404, 'Group not found.'); return room; }
  private persist(): Promise<void> { for (const room of this.rooms.values()) this.changed(room); const payload = JSON.stringify({ rooms: [...this.rooms.values()], requestIds: Object.fromEntries(this.createRequests), messageRequestIds: [...this.messageRequests], memberRequestIds: [...this.memberRequests], deletions: [...this.deletions].map(([roomId, partyId]) => ({ roomId, partyId })) } satisfies RoomsFile); this.persistQueue = this.persistQueue.catch(() => undefined).then(async () => { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); const temp = `${this.path}.${randomUUID()}.tmp`; await writeFile(temp, payload, { flag: 'wx', mode: 0o600 }); await rename(temp, this.path); await chmod(this.path, 0o600); }); return this.persistQueue; }
}

function toMember(profile: AgentProfile): RoomAgentSnapshot { return { id: profile.id, name: profile.name, instructions: profile.instructions, engine: 'codex', model: profile.model, effort: profile.effort, avatarId: profile.avatarId, ...(profile.machineId && profile.directory ? { machineId: profile.machineId, directory: profile.directory } : {}), status: 'idle' }; }
function displayName(members: RoomAgentSnapshot[], id: string): string { return id === 'host' ? '我' : members.find(member => member.id === id)?.name ?? id; }
function clone<T>(value: T): T { return structuredClone(value); }
function isAbsoluteDirectory(value: string): boolean { return value.startsWith('/') && !value.includes('\0'); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> { if (signal.aborted) return Promise.reject(signal.reason); return new Promise((resolve, reject) => { const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); }); }); }
function timeout(parent: AbortSignal, ms: number) { const controller = new AbortController(); const onAbort = () => controller.abort(parent.reason); parent.addEventListener('abort', onAbort, { once: true }); if (parent.aborted) onAbort(); const timer = setTimeout(() => controller.abort(new Error('Remote turn deadline exceeded.')), ms); return { signal: controller.signal, dispose: () => { clearTimeout(timer); parent.removeEventListener('abort', onAbort); } }; }
