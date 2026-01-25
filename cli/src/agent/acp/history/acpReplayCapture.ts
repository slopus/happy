import type { SessionUpdate } from '../sessionUpdateHandlers';
import { extractTextFromContentBlock } from '../sessionUpdateHandlers';

export type AcpReplayEvent =
  | { type: 'message'; role: 'user' | 'agent'; text: string }
  | {
      type: 'tool_call';
      toolCallId: string;
      title?: string;
      kind?: string;
      rawInput?: unknown;
    }
  | {
      type: 'tool_result';
      toolCallId: string;
      status?: string;
      rawOutput?: unknown;
      content?: unknown;
    };

export class AcpReplayCapture {
  private currentRole: 'user' | 'agent' | null = null;
  private currentText = '';
  private events: AcpReplayEvent[] = [];

  private flushMessage(): void {
    if (!this.currentRole) return;
    const role = this.currentRole;
    const text = this.currentText;
    this.currentRole = null;
    this.currentText = '';
    if (text.trim().length === 0) return;
    this.events.push({ type: 'message', role, text });
  }

  private pushMessage(role: 'user' | 'agent', textDelta: string): void {
    if (this.currentRole && this.currentRole !== role) {
      this.flushMessage();
    }
    if (!this.currentRole) {
      this.currentRole = role;
      this.currentText = '';
    }
    this.currentText += textDelta;
  }

  handleUpdate(update: SessionUpdate): void {
    const kind = String(update.sessionUpdate || '');
    if (kind === 'user_message_chunk') {
      const text = extractTextFromContentBlock(update.content);
      if (text) this.pushMessage('user', text);
      return;
    }
    if (kind === 'agent_message_chunk') {
      const text = extractTextFromContentBlock(update.content);
      if (text) this.pushMessage('agent', text);
      return;
    }

    if (kind === 'tool_call') {
      this.flushMessage();
      const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      if (!toolCallId) return;
      const title = typeof (update as any).title === 'string' ? (update as any).title : undefined;
      const toolKind = typeof (update as any).kind === 'string' ? (update as any).kind : undefined;
      const rawInput = (update as any).rawInput;
      this.events.push({
        type: 'tool_call',
        toolCallId,
        title,
        kind: toolKind,
        rawInput,
      });
      return;
    }

    if (kind === 'tool_call_update') {
      const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      if (!toolCallId) return;
      const status = typeof (update as any).status === 'string' ? (update as any).status : undefined;
      const rawOutput = (update as any).rawOutput;
      const content = (update as any).content;
      // Only record results when status indicates completion/error or when rawOutput is present.
      if (status && (status === 'completed' || status === 'error' || status === 'failed' || status === 'cancelled')) {
        this.flushMessage();
        this.events.push({ type: 'tool_result', toolCallId, status, rawOutput, content });
      } else if (rawOutput !== undefined) {
        this.flushMessage();
        this.events.push({ type: 'tool_result', toolCallId, status, rawOutput, content });
      }
      return;
    }
  }

  finalize(): AcpReplayEvent[] {
    this.flushMessage();
    return this.events.slice();
  }
}
