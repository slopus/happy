import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type { AgentMessage } from '@/agent/core';

function turnOptions(turnId: string | null, time: number): CreateEnvelopeOptions {
  return turnId ? { turn: turnId, time } : { time };
}

function buildToolTitle(toolName: string): string {
  return toolName;
}

function buildToolDescription(toolName: string): string {
  return `Running ${toolName}`;
}

/**
 * Map ACP tool names to Claude-compatible names so the app's knownTools renders them properly.
 * Copilot sends "execute" for terminal, "edit_file"/"write" for file edits, etc.
 * The app expects "Bash", "Edit", "Write", "Read", etc.
 */
function mapToolName(toolName: string): string {
  switch (toolName) {
    case 'execute':
    case 'shell':
    case 'terminal':
    case 'run_command':
      return 'Bash';
    case 'edit_file':
    case 'edit':
      return 'Edit';
    case 'write_file':
    case 'write':
    case 'create_file':
      return 'Write';
    case 'read_file':
    case 'read':
    case 'view':
      return 'Read';
    case 'search':
    case 'grep':
    case 'find':
      return 'Search';
    case 'web_search':
    case 'web_fetch':
      return 'WebSearch';
    case 'task':
    case 'delegate':
      return 'Task';
    default:
      return toolName;
  }
}

/**
 * Build args compatible with what the app's knownTools expects.
 * E.g., Bash expects {command: "..."}, Edit expects {file_path: "...", old_string, new_string}
 */
function buildMappedArgs(
  mappedName: string,
  originalArgs: Record<string, unknown>,
  rawInput?: Record<string, unknown>,
): Record<string, unknown> {
  if (mappedName === 'Bash' && rawInput?.command) {
    return { command: rawInput.command, ...originalArgs };
  }
  if ((mappedName === 'Edit' || mappedName === 'Write') && rawInput?.file_path) {
    return { file_path: rawInput.file_path, ...originalArgs };
  }
  if (rawInput) {
    return { ...rawInput, ...originalArgs };
  }
  return originalArgs;
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

  /** Monotonic clock: max(lastTime + 1, Date.now()) */
  private lastTime = 0;

  /** Pending text waiting to be flushed when the stream type changes */
  private pendingText = '';
  private pendingType: 'thinking' | 'output' | null = null;

  private nextTime(): number {
    this.lastTime = Math.max(this.lastTime + 1, Date.now());
    return this.lastTime;
  }

  private ensureSessionCallId(acpCallId: string): string {
    const existing = this.acpCallToSessionCall.get(acpCallId);
    if (existing) {
      return existing;
    }

    const created = createId();
    this.acpCallToSessionCall.set(acpCallId, created);
    return created;
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

  startTurn(): SessionEnvelope[] {
    if (this.currentTurnId) {
      return [];
    }

    this.currentTurnId = createId();
    this.acpCallToSessionCall.clear();
    return [
      createEnvelope('agent', { t: 'turn-start' }, { turn: this.currentTurnId, time: this.nextTime() }),
    ];
  }

  endTurn(status: 'completed' | 'failed' | 'cancelled'): SessionEnvelope[] {
    const flushed = this.flush();
    if (!this.currentTurnId) {
      return flushed;
    }

    const turnId = this.currentTurnId;
    this.currentTurnId = null;
    this.acpCallToSessionCall.clear();
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
      const call = this.ensureSessionCallId(msg.callId);
      const rawInput = msg.args.rawInput as Record<string, unknown> | undefined;
      const title = (msg.args.title as string) ?? rawInput?.description as string ?? buildToolTitle(msg.toolName);
      const description = rawInput?.command as string ?? buildToolDescription(msg.toolName);

      // Map tool names to Claude-compatible names for the app's knownTools
      const mappedName = mapToolName(msg.toolName);
      const mappedArgs = buildMappedArgs(mappedName, msg.args, rawInput);

      return [
        ...flushed,
        createEnvelope('agent', {
          t: 'tool-call-start',
          call,
          name: mappedName,
          title,
          description,
          args: mappedArgs,
        }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    if (msg.type === 'tool-result') {
      const flushed = this.flush();
      const call = this.ensureSessionCallId(msg.callId);
      return [
        ...flushed,
        createEnvelope('agent', { t: 'tool-call-end', call }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    if (msg.type === 'terminal-output') {
      const text = msg.data?.replace(/^\n+|\n+$/g, '');
      if (text) {
        return [
          createEnvelope('agent', { t: 'text', text }, turnOptions(this.currentTurnId, this.nextTime())),
        ];
      }
      return [];
    }

    return [];
  }
}
