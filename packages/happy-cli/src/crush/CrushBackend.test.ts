import { describe, expect, it } from 'vitest';
import { CrushBackend } from './CrushBackend';

describe('CrushBackend.mapEvent', () => {
  it('maps agent_message_chunk with text', () => {
    const result = CrushBackend.mapEvent({ type: 'agent_message_chunk', text: 'hello' });
    expect(result).toEqual({ type: 'model-output', textDelta: 'hello' });
  });

  it('maps agent_message_chunk with delta fallback', () => {
    const result = CrushBackend.mapEvent({ type: 'agent_message_chunk', delta: 'world' });
    expect(result).toEqual({ type: 'model-output', textDelta: 'world' });
  });

  it('returns null for empty agent_message_chunk', () => {
    expect(CrushBackend.mapEvent({ type: 'agent_message_chunk' })).toBeNull();
  });

  it('maps agent_message with text', () => {
    const result = CrushBackend.mapEvent({ type: 'agent_message', text: 'full response' });
    expect(result).toEqual({ type: 'model-output', fullText: 'full response' });
  });

  it('maps agent_message with content fallback', () => {
    const result = CrushBackend.mapEvent({ type: 'agent_message', content: 'content body' });
    expect(result).toEqual({ type: 'model-output', fullText: 'content body' });
  });

  it('maps tool_call with all fields', () => {
    const result = CrushBackend.mapEvent({ type: 'tool_call', name: 'bash', id: 'tc-1', input: { command: 'ls' } });
    expect(result).toEqual({ type: 'tool-call', toolName: 'bash', callId: 'tc-1', args: { command: 'ls' } });
  });

  it('defaults toolName to unknown', () => {
    const result = CrushBackend.mapEvent({ type: 'tool_call' });
    expect(result).toMatchObject({ type: 'tool-call', toolName: 'unknown' });
  });

  it('defaults args to empty object', () => {
    const result = CrushBackend.mapEvent({ type: 'tool_call', name: 'x', id: 'y' });
    expect(result).toMatchObject({ args: {} });
  });

  it('maps tool_result with output', () => {
    const result = CrushBackend.mapEvent({ type: 'tool_result', name: 'bash', id: 'tr-1', output: 'file.txt' });
    expect(result).toEqual({ type: 'tool-result', toolName: 'bash', callId: 'tr-1', result: 'file.txt' });
  });

  it('maps agent_started to running', () => {
    expect(CrushBackend.mapEvent({ type: 'agent_started' })).toEqual({ type: 'status', status: 'running' });
  });

  it('maps agent_busy to running', () => {
    expect(CrushBackend.mapEvent({ type: 'agent_busy' })).toEqual({ type: 'status', status: 'running' });
  });

  it('maps agent_idle to idle', () => {
    expect(CrushBackend.mapEvent({ type: 'agent_idle' })).toEqual({ type: 'status', status: 'idle' });
  });

  it('maps agent_finished to idle', () => {
    expect(CrushBackend.mapEvent({ type: 'agent_finished' })).toEqual({ type: 'status', status: 'idle' });
  });

  it('maps agent_error with detail', () => {
    const result = CrushBackend.mapEvent({ type: 'agent_error', error: 'Rate limited' });
    expect(result).toEqual({ type: 'status', status: 'error', detail: 'Rate limited' });
  });

  it('maps agent_error with default message', () => {
    const result = CrushBackend.mapEvent({ type: 'agent_error' });
    expect(result).toEqual({ type: 'status', status: 'error', detail: 'Unknown error' });
  });

  it('maps permission_request', () => {
    const result = CrushBackend.mapEvent({ type: 'permission_request', id: 'p1', reason: 'need bash' });
    expect(result?.type).toBe('permission-request');
    expect(result).toMatchObject({ id: 'p1', reason: 'need bash' });
  });

  it('maps file_edit', () => {
    const result = CrushBackend.mapEvent({ type: 'file_edit', description: 'Updated file', diff: '@@ -1 +1 @@', path: '/a.ts' });
    expect(result).toEqual({ type: 'fs-edit', description: 'Updated file', diff: '@@ -1 +1 @@', path: '/a.ts' });
  });

  it('maps patch_applied with default description', () => {
    const result = CrushBackend.mapEvent({ type: 'patch_applied' });
    expect(result).toEqual({ type: 'fs-edit', description: 'File edited', diff: undefined, path: undefined });
  });

  it('returns null for unknown event type', () => {
    expect(CrushBackend.mapEvent({ type: 'something_random' })).toBeNull();
  });
});
