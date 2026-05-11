import { createId } from '@paralleldrive/cuid2';
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type { AgentMessage } from '@/agent/core';
import {
  setActiveBashStreamCall,
  clearActiveBashStreamCall,
} from '@/claude/utils/bashStreamCallRegistry';
import { BASH_STREAM_AGENT_TOOL_NAME } from '@/claude/utils/startHappyServer';

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

  /**
   * chat-tool-output-streaming Phase 3 — tracks live tool calls keyed by
   * tool name (e.g. `mcp__happy__bash_stream`). The in-process MCP handler
   * for bash_stream calls `emitProgress(toolName, …)` to fan stdout/stderr
   * lines back out as `tool-call-progress` envelopes addressed to the same
   * call id that tool-call-start used. Last-in-wins on overlapping calls of
   * the same tool name; cleared on tool-result so post-completion progress
   * is silently dropped.
   */
  private readonly activeCallByName = new Map<string, string>();

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
      // Last-in-wins for overlapping calls of the same tool name. Claude
      // typically runs tool calls sequentially within a turn, but if a fresh
      // bash_stream starts before the previous one's tool-result arrives we
      // want progress to address the new call.
      this.activeCallByName.set(msg.toolName, call);
      // chat-tool-output-streaming Phase 3 — populate the cross-runner
      // registry so the in-process bash_stream MCP handler can resolve
      // the live call id when it flushes a progress batch.
      if (msg.toolName === BASH_STREAM_AGENT_TOOL_NAME) {
        setActiveBashStreamCall(call);
      }
      return [
        ...flushed,
        createEnvelope('agent', {
          t: 'tool-call-start',
          call,
          name: msg.toolName,
          title: buildToolTitle(msg.toolName),
          description: buildToolDescription(msg.toolName),
          args: msg.args,
        }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    if (msg.type === 'tool-result') {
      const flushed = this.flush();
      const call = this.ensureSessionCallId(msg.callId);
      // Only clear the per-name slot if the most recent active call for
      // this tool is the one being completed, so a stale result for an
      // older overlapping call doesn't yank ownership from a fresh one.
      if (this.activeCallByName.get(msg.toolName) === call) {
        this.activeCallByName.delete(msg.toolName);
      }
      if (msg.toolName === BASH_STREAM_AGENT_TOOL_NAME) {
        clearActiveBashStreamCall(call);
      }
      return [
        ...flushed,
        createEnvelope('agent', { t: 'tool-call-end', call }, turnOptions(this.currentTurnId, this.nextTime())),
      ];
    }

    return [];
  }

  /**
   * chat-tool-output-streaming Phase 3 — invoked by the in-process MCP
   * handler (bash_stream) to relay buffered stdout/stderr chunks as a
   * tool-call-progress envelope. Returns [] when no live call matches the
   * tool name or when there are no lines to flush, so the caller can
   * cheaply pre-flush even when nothing has accumulated yet.
   */
  emitProgress(toolName: string, stream: 'stdout' | 'stderr', lines: string[]): SessionEnvelope[] {
    if (lines.length === 0) {
      return [];
    }
    const call = this.activeCallByName.get(toolName);
    if (!call) {
      return [];
    }
    return [
      createEnvelope(
        'agent',
        { t: 'tool-call-progress', call, stream, lines },
        turnOptions(this.currentTurnId, this.nextTime()),
      ),
    ];
  }
}
