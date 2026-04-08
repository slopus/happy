import { createId } from '@paralleldrive/cuid2';
import {
  createEnvelope,
  type CreateEnvelopeOptions,
  type SessionEnvelope,
  type SessionTurnEndStatus,
} from '@slopus/happy-wire';

type PendingTextType = 'thinking' | 'output';

function turnOptions(turnId: string | null, time: number): CreateEnvelopeOptions {
  return turnId ? { turn: turnId, time } : { time };
}

function buildToolTitle(toolName: string): string {
  return toolName;
}

function buildToolDescription(toolName: string): string {
  return `Running ${toolName}`;
}

function normalizeToolArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {};
  }

  return args as Record<string, unknown>;
}

export class PiSessionMapper {
  private currentTurnId: string | null = null;

  /** Monotonic clock: max(lastTime + 1, Date.now()) */
  private lastTime = 0;

  /** Pending text waiting to be flushed when the stream type changes */
  private pendingText = '';
  private pendingType: PendingTextType | null = null;

  private readonly toolCallToSessionCall = new Map<string, string>();

  private nextTime(): number {
    this.lastTime = Math.max(this.lastTime + 1, Date.now());
    return this.lastTime;
  }

  private ensureSessionCallId(toolCallId: string): string {
    const existing = this.toolCallToSessionCall.get(toolCallId);
    if (existing) {
      return existing;
    }

    const created = createId();
    this.toolCallToSessionCall.set(toolCallId, created);
    return created;
  }

  startTurn(): SessionEnvelope[] {
    if (this.currentTurnId) {
      return [];
    }

    this.currentTurnId = createId();
    this.toolCallToSessionCall.clear();
    return [
      createEnvelope('agent', { t: 'turn-start' }, { turn: this.currentTurnId, time: this.nextTime() }),
    ];
  }

  endTurn(status: SessionTurnEndStatus = 'completed'): SessionEnvelope[] {
    const flushed = this.flush();
    if (!this.currentTurnId) {
      return flushed;
    }

    const turnId = this.currentTurnId;
    this.currentTurnId = null;
    this.toolCallToSessionCall.clear();

    return [
      ...flushed,
      createEnvelope('agent', { t: 'turn-end', status }, { turn: turnId, time: this.nextTime() }),
    ];
  }

  mapTextDelta(delta: string): SessionEnvelope[] {
    if (!delta) {
      return [];
    }

    const flushed = this.pendingType !== 'output' ? this.flush() : [];
    this.pendingType = 'output';
    this.pendingText += delta;
    return flushed;
  }

  mapThinkingDelta(delta: string): SessionEnvelope[] {
    if (!delta) {
      return [];
    }

    const flushed = this.pendingType !== 'thinking' ? this.flush() : [];
    this.pendingType = 'thinking';
    this.pendingText += delta;
    return flushed;
  }

  mapToolStart(toolCallId: string, toolName: string, args: unknown): SessionEnvelope[] {
    const flushed = this.flush();
    const call = this.ensureSessionCallId(toolCallId);

    return [
      ...flushed,
      createEnvelope('agent', {
        t: 'tool-call-start',
        call,
        name: toolName,
        title: buildToolTitle(toolName),
        description: buildToolDescription(toolName),
        args: normalizeToolArgs(args),
      }, turnOptions(this.currentTurnId, this.nextTime())),
    ];
  }

  mapToolEnd(toolCallId: string): SessionEnvelope[] {
    const flushed = this.flush();
    const call = this.toolCallToSessionCall.get(toolCallId);

    if (!call) {
      return flushed;
    }

    return [
      ...flushed,
      createEnvelope('agent', { t: 'tool-call-end', call }, turnOptions(this.currentTurnId, this.nextTime())),
    ];
  }

  flush(): SessionEnvelope[] {
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
      return [
        createEnvelope('agent', { t: 'text', text, thinking: true }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    return [
      createEnvelope('agent', { t: 'text', text }, turnOptions(this.currentTurnId, this.nextTime())),
    ];
  }
}
