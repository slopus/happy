/**
 * Agy stream-json parser and protocol types
 *
 * agy CLI supports `--output-format stream-json`, which outputs newline-delimited JSON
 * (NDJSON) events during headless execution:
 *   - `init`: announces the conversation ID, tools, permission mode, and cwd.
 *   - `step_update`: stream events for responses, tool calls, tool results, thinking, and usage.
 *   - `result`: final turn summary with status ('SUCCESS' | 'ERROR' | 'CANCELED'), duration, and usage.
 *
 * This module provides a streaming NDJSON chunk parser that turns raw stdout bytes into
 * structured Happy AgentMessage events.
 */

import type { AgentMessage } from '@/agent/core/AgentBackend';

export interface AgyInitEvent {
  event: 'init';
  conversation_id: string;
  init?: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
    model?: string;
    [key: string]: unknown;
  };
}

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyStepUpdate {
  conversation_id?: string;
  step_index: number;
  state: 'ACTIVE' | 'DONE' | 'ERROR' | string;
  step_type:
    | 'user_input'
    | 'system_message'
    | 'checkpoint'
    | 'agent_response'
    | 'tool'
    | 'subagent'
    | 'reasoning'
    | 'process'
    | string;
  tool_name?: string;
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
    output?: unknown;
    [key: string]: unknown;
  };
  text_delta?: string;
  duration_seconds?: number;
  usage?: AgyUsage;
  [key: string]: unknown;
}

export interface AgyStepUpdateEvent {
  event: 'step_update';
  step_update: AgyStepUpdate;
}

export interface AgyResult {
  conversation_id?: string;
  status: 'SUCCESS' | 'ERROR' | 'CANCELED' | string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
  [key: string]: unknown;
}

export interface AgyResultEvent {
  event: 'result';
  result: AgyResult;
}

export type AgyStreamEvent =
  | AgyInitEvent
  | AgyStepUpdateEvent
  | AgyResultEvent
  | { event: string; [key: string]: unknown };

export interface StreamJsonParserOptions {
  onInit?: (event: AgyInitEvent) => void;
  onStepUpdate?: (event: AgyStepUpdateEvent) => void;
  onResult?: (event: AgyResultEvent) => void;
  onMessage?: (message: AgentMessage) => void;
  onRawLine?: (line: string) => void;
  log?: (msg: string) => void;
}

export class StreamJsonParser {
  private buffer = '';
  private readonly activeToolCalls = new Map<number, string>();

  constructor(private readonly options: StreamJsonParserOptions = {}) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The last element is either an incomplete line or an empty string after a trailing newline.
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      this.parseLine(line);
    }
  }

  flush(): void {
    if (this.buffer.trim().length > 0) {
      const line = this.buffer;
      this.buffer = '';
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    this.options.onRawLine?.(trimmed);

    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Non-JSON line from agy (e.g. debug log or banner before JSON begins)
      this.options.log?.(`non-json stdout: ${trimmed}`);
      return;
    }

    if (!parsed || typeof parsed !== 'object' || typeof parsed.event !== 'string') {
      return;
    }

    const event = parsed as AgyStreamEvent;

    switch (event.event) {
      case 'init': {
        const initEv = event as AgyInitEvent;
        this.options.onInit?.(initEv);
        break;
      }
      case 'step_update': {
        const stepEv = event as AgyStepUpdateEvent;
        this.options.onStepUpdate?.(stepEv);
        this.handleStepUpdate(stepEv.step_update);
        break;
      }
      case 'result': {
        const resultEv = event as AgyResultEvent;
        this.options.onResult?.(resultEv);
        this.handleResult(resultEv.result);
        break;
      }
      default: {
        this.options.log?.(`unknown stream-json event: ${event.event}`);
        break;
      }
    }
  }

  private handleStepUpdate(step: AgyStepUpdate): void {
    if (!step) return;

    if (step.usage) {
      this.options.onMessage?.({
        type: 'token-count',
        ...step.usage,
      });
    }

    const stepType = step.step_type;

    if (stepType === 'agent_response') {
      if (step.text_delta) {
        this.options.onMessage?.({
          type: 'model-output',
          textDelta: step.text_delta,
        });
      }
    } else if (stepType === 'reasoning' || stepType === 'process') {
      if (step.text_delta) {
        this.options.onMessage?.({
          type: 'event',
          name: 'thinking',
          payload: {
            text: step.text_delta,
            streaming: true,
          },
        });
      }
    } else if (stepType === 'tool') {
      const callId = `agy-step-${step.step_index}`;
      const toolName = step.tool_name || step.tool_info?.name || 'tool';

      if (step.state === 'ACTIVE') {
        this.activeToolCalls.set(step.step_index, toolName);
        this.options.onMessage?.({
          type: 'tool-call',
          callId,
          toolName,
          args: step.tool_info?.parameters || {},
        });
      } else if (step.state === 'DONE' || step.state === 'ERROR') {
        const name = this.activeToolCalls.get(step.step_index) || toolName;
        this.activeToolCalls.delete(step.step_index);
        this.options.onMessage?.({
          type: 'tool-result',
          callId,
          toolName: name,
          result: step.tool_info?.output ?? '',
        });
      }
    }
  }

  private handleResult(result: AgyResult): void {
    if (!result) return;

    if (result.usage) {
      this.options.onMessage?.({
        type: 'token-count',
        ...result.usage,
      });
    }

    if (result.status === 'ERROR') {
      const detail = result.error || result.response || 'agy turn failed';
      this.options.onMessage?.({
        type: 'status',
        status: 'error',
        detail,
      });
    }
  }
}
