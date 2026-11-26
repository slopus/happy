import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, selectToolFailure, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type { AgentMessage } from '@/agent/core';
import { boundedRoleSaveInput, isHappyRoleTool, roleFromSaveReceipt, roleSaveReceipt, type RoleSaveInput } from '@/delegation/roleSaveReceipt';

function turnOptions(turnId: string | null, time: number): CreateEnvelopeOptions {
  return turnId ? { turn: turnId, time } : { time };
}

function buildToolTitle(toolName: string): string {
  return toolName;
}

function buildToolDescription(toolName: string): string {
  return `Running ${toolName}`;
}

function parseThinkingPayload(payload: unknown): { text: string; streaming: boolean } {
  if (typeof payload === 'string') {
    return { text: payload, streaming: false };
  }
  if (!payload || typeof payload !== 'object') {
    return { text: '', streaming: false };
  }
  const text = typeof (payload as { text?: unknown }).text === 'string'
    ? (payload as { text: string }).text
    : '';
  const streaming = (payload as { streaming?: unknown }).streaming === true;
  return { text, streaming };
}

export class AcpSessionManager {
  private currentTurnId: string | null = null;
  private readonly acpCallToSessionCall = new Map<string, string>();
  private readonly roleCalls = new Map<string, RoleSaveInput>();
  private readonly savedRoleReceipts = new Set<string>();
  private roleSaveEpoch = 0;
  private roleReceiptsAllowed = true;

  /** Monotonic clock: max(lastTime + 1, Date.now()) */
  private lastTime = 0;

  /** Pending text waiting to be flushed when the stream type changes */
  private pendingText = '';
  private pendingType: 'thinking' | 'output' | null = null;

  private nextTime(): number {
    this.lastTime = Math.max(this.lastTime + 1, Date.now());
    return this.lastTime;
  }

  getSessionCallId(acpCallId: string): string {
    const existing = this.acpCallToSessionCall.get(acpCallId);
    if (existing) {
      return existing;
    }

    const created = createId();
    this.acpCallToSessionCall.set(acpCallId, created);
    return created;
  }

  private acceptRoleReceipt(receipt: ReturnType<typeof roleSaveReceipt>) {
    const role = roleFromSaveReceipt(receipt);
    if (!role || this.savedRoleReceipts.size >= 128) return false;
    const key = `${role.id}:${role.updatedAt}`;
    if (this.savedRoleReceipts.has(key)) return false;
    this.savedRoleReceipts.add(key);
    return true;
  }

  invalidateRoleSaveObservations() {
    this.roleSaveEpoch++;
    this.roleReceiptsAllowed = false;
    this.roleCalls.clear();
  }

  /** Independent confirmation of a real MCP save when ACP omits its output.
   * The caller additionally fences session/worker/cancellation ownership. */
  observeRoleSave(input: unknown) {
    const request = boundedRoleSaveInput(input);
    const turn = this.currentTurnId;
    const epoch = this.roleSaveEpoch;
    if (!request || !turn || !this.roleReceiptsAllowed) return undefined;
    return (role: unknown): SessionEnvelope[] => {
      if (this.currentTurnId !== turn || epoch !== this.roleSaveEpoch || !this.roleReceiptsAllowed) return [];
      const receipt = roleSaveReceipt('happy', 'agent_roles', request, { success: true, role });
      if (!receipt || !this.acceptRoleReceipt(receipt)) return [];
      const call = createId();
      return [
        ...this.flush(),
        createEnvelope('agent', { t: 'tool-call-start', call, name: 'mcp__happy__agent_roles',
          title: 'happy.agent_roles', description: 'happy.agent_roles', args: request }, { turn, time: this.nextTime() }),
        createEnvelope('agent', { t: 'tool-call-end', call, status: 'completed', mcpAppResult: receipt }, { turn, time: this.nextTime() }),
      ];
    };
  }

  private flush(): SessionEnvelope[] {
    if (!this.pendingText || !this.pendingType) {
      return [];
    }
    const text = this.pendingText.replace(/^\n+|\n+$/g, '');
    const type = this.pendingType;
    this.pendingText = '';
    this.pendingType = null;

    if (!text) {
      return [];
    }
    if (type === 'thinking') {
      return [createEnvelope('agent', { t: 'text', text, thinking: true }, turnOptions(this.currentTurnId, this.nextTime()))];
    }
    return [createEnvelope('agent', { t: 'text', text }, turnOptions(this.currentTurnId, this.nextTime()))];
  }

  startTurn(localIds?: string[]): SessionEnvelope[] {
    if (this.currentTurnId) {
      return [];
    }

    this.currentTurnId = createId();
    this.roleSaveEpoch++;
    this.roleReceiptsAllowed = true;
    this.acpCallToSessionCall.clear();
    this.roleCalls.clear();
    this.savedRoleReceipts.clear();
    return [
      createEnvelope('agent', { t: 'turn-start', ...(localIds?.length ? { localIds } : {}) }, { turn: this.currentTurnId, time: this.nextTime() }),
    ];
  }

  endTurn(status: 'completed' | 'failed' | 'cancelled'): SessionEnvelope[] {
    const flushed = this.flush();
    if (!this.currentTurnId) {
      return flushed;
    }

    const turnId = this.currentTurnId;
    this.currentTurnId = null;
    this.invalidateRoleSaveObservations();
    this.acpCallToSessionCall.clear();
    this.roleCalls.clear();
    this.savedRoleReceipts.clear();
    return [
      ...flushed,
      createEnvelope('agent', { t: 'turn-end', status }, { turn: turnId, time: this.nextTime() }),
    ];
  }

  mapMessage(msg: AgentMessage): SessionEnvelope[] {
    if (msg.type === 'event' && msg.name === 'thinking') {
      const { text, streaming } = parseThinkingPayload(msg.payload);
      if (!text) {
        return [];
      }

      if (streaming) {
        // Streaming thinking: accumulate, flush if switching from a different type
        const flushed = this.pendingType !== 'thinking' ? this.flush() : [];
        this.pendingType = 'thinking';
        this.pendingText += text;
        return flushed;
      }

      // Non-streaming thinking: flush pending, emit immediately
      const trimmed = text.replace(/^\n+|\n+$/g, '');
      if (!trimmed) {
        return this.flush();
      }
      return [
        ...this.flush(),
        createEnvelope('agent', { t: 'text', text: trimmed, thinking: true }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    if (msg.type === 'status') {
      return [];
    }

    if (msg.type === 'model-output') {
      const text = msg.textDelta ?? '';
      if (!text) {
        return [];
      }
      // Accumulate output, flush if switching from a different type
      const flushed = this.pendingType !== 'output' ? this.flush() : [];
      this.pendingType = 'output';
      this.pendingText += text;
      return flushed;
    }

    if (msg.type === 'tool-call') {
      const flushed = this.flush();
      const call = this.getSessionCallId(msg.callId);
      const roleTool = isHappyRoleTool(msg.toolName, msg.title);
      const roleInput = roleTool ? boundedRoleSaveInput(msg.args, true) : undefined;
      if (roleInput && this.roleReceiptsAllowed && this.roleCalls.size < 32) this.roleCalls.set(msg.callId, roleInput);
      return [
        ...flushed,
        createEnvelope('agent', {
          t: 'tool-call-start',
          call,
          name: roleTool ? 'mcp__happy__agent_roles' : msg.toolName,
          title: msg.title ?? buildToolTitle(msg.toolName),
          description: buildToolDescription(msg.toolName),
          args: msg.args,
        }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    if (msg.type === 'tool-result') {
      const flushed = this.flush();
      const call = this.getSessionCallId(msg.callId);
      const result = msg.result && typeof msg.result === 'object' ? msg.result as Record<string, unknown> : {};
      const status = result.status === 'cancelled' ? 'cancelled' : result.status === 'failed' || result.error ? 'failed' : undefined;
      const failure = status === 'failed' ? selectToolFailure([msg.result], 'Tool failed') : null;
      const roleInput = this.roleCalls.get(msg.callId);
      this.roleCalls.delete(msg.callId);
      const candidate = status === undefined && roleInput !== undefined
        ? roleSaveReceipt('happy', 'agent_roles', roleInput, msg.result) : undefined;
      const receipt = candidate && this.acceptRoleReceipt(candidate) ? candidate : undefined;
      return [
        ...flushed,
        createEnvelope('agent', { t: 'tool-call-end', call, ...(status ? { status } : {}),
          ...(failure?.summary ? { error: failure } : {}),
          ...(receipt ? { mcpAppResult: receipt } : {}) }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    return [];
  }
}
