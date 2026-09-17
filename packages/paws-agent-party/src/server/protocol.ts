import type { Message } from '@wangjs-jacky/paws-agent';

export type DurableMessage = Message;

type SessionEnvelope = {
  role: 'agent' | 'user';
  turn?: string;
  subagent?: string;
  ev:
    | { t: 'turn-start' }
    | { t: 'turn-end'; status: 'completed' | 'failed' | 'cancelled' }
    | { t: 'text'; text: string; thinking?: boolean }
    | { t: string; [key: string]: unknown };
};

export type TurnTerminal =
  | { type: 'completed'; text: string }
  | { type: 'failed'; status: 'failed' | 'cancelled' | 'empty' };

export function decodeSessionEnvelope(content: unknown): SessionEnvelope | null {
  if (!isRecord(content) || content.role !== 'session' || !isRecord(content.content)) return null;
  // The CLI encrypts { role: 'session', content: envelope, meta }, and the SDK
  // returns that payload unchanged. Session events have no type/data wrapper.
  const envelope = content.content;
  if (
    (envelope.role !== 'agent' && envelope.role !== 'user')
    || !isRecord(envelope.ev)
    || typeof envelope.ev.t !== 'string'
  ) return null;
  return envelope as SessionEnvelope;
}

/** Matches only the durable root turn that follows this submission's echo. */
export class DurableTurnDecoder {
  readonly trace: DurableMessage[] = [];
  cursor = 0;

  private readonly seen = new Set<number>();
  private submissionEchoed = false;
  private turnId: string | null = null;
  private terminalMessageId: string | undefined;
  get provenance(): { rootTurnId?: string; sourceMessageId?: string } {
    return { ...(this.turnId ? { rootTurnId: this.turnId } : {}), ...(this.terminalMessageId ? { sourceMessageId: this.terminalMessageId } : {}) };
  }
  private readonly text: string[] = [];

  constructor(private readonly submittedLocalId: string) {}

  accept(message: DurableMessage): TurnTerminal | null {
    if (this.seen.has(message.seq)) return null;
    this.seen.add(message.seq);
    this.cursor = Math.max(this.cursor, message.seq);
    this.trace.push(message);

    if (message.localId === this.submittedLocalId) this.submissionEchoed = true;
    const envelope = decodeSessionEnvelope(message.content);
    if (!envelope || !this.submissionEchoed || envelope.role !== 'agent' || envelope.subagent) return null;

    if (envelope.ev.t === 'turn-start' && typeof envelope.turn === 'string' && !this.turnId) {
      this.turnId = envelope.turn;
      return null;
    }
    if (!this.turnId || envelope.turn !== this.turnId) return null;
    if (envelope.ev.t === 'text' && !envelope.ev.thinking && typeof envelope.ev.text === 'string') {
      const value = envelope.ev.text.trim();
      if (value) this.text.push(value);
      return null;
    }
    if (envelope.ev.t !== 'turn-end' || !('status' in envelope.ev)) return null;
    if (['completed', 'failed', 'cancelled'].includes(String(envelope.ev.status))) this.terminalMessageId = message.id;
    if (envelope.ev.status === 'failed' || envelope.ev.status === 'cancelled') {
      return { type: 'failed', status: envelope.ev.status };
    }
    if (envelope.ev.status !== 'completed') return null;
    const text = this.text.join('\n\n').trim();
    return text ? { type: 'completed', text } : { type: 'failed', status: 'empty' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
