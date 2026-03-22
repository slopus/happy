import { describe, it, expect } from 'vitest';
import { handleCodexEvent, createV3CodexMapperState, flushV3CodexTurn } from './v3Mapper';

function makeState() {
  return createV3CodexMapperState({
    sessionID: 'ses_codex_test',
    agent: 'build',
    modelID: 'o3-mini',
    providerID: 'openai',
    cwd: '/test/project',
    root: '/test/project',
  });
}

describe('v3 Codex Mapper', () => {
  it('handles task_started + agent_message + task_complete', () => {
    const state = makeState();

    const r1 = handleCodexEvent({ type: 'task_started' }, state);
    expect(r1.messages).toHaveLength(0);
    expect(r1.currentAssistant).not.toBeNull();

    const r2 = handleCodexEvent({ type: 'agent_message', message: 'Hello!' }, state);
    expect(r2.currentAssistant).not.toBeNull();
    const textPart = r2.currentAssistant!.parts.find((p: any) => p.type === 'text');
    expect(textPart).toBeDefined();

    const r3 = handleCodexEvent({ type: 'task_complete' }, state);
    expect(r3.messages).toHaveLength(1);
    expect(r3.messages[0].info.role).toBe('assistant');
    if (r3.messages[0].info.role === 'assistant') {
      expect(r3.messages[0].info.finish).toBe('stop');
    }
  });

  it('handles reasoning events', () => {
    const state = makeState();
    handleCodexEvent({ type: 'task_started' }, state);
    handleCodexEvent({ type: 'agent_reasoning', text: 'Thinking...' }, state);

    const flushed = flushV3CodexTurn(state);
    expect(flushed).toHaveLength(1);
    const reasoning = flushed[0].parts.find((p: any) => p.type === 'reasoning');
    expect(reasoning).toBeDefined();
  });

  it('handles synthetic reasoning messages', () => {
    const state = makeState();
    handleCodexEvent({ type: 'task_started' }, state);
    handleCodexEvent({ type: 'reasoning', message: 'Coalesced reasoning' }, state);

    const flushed = flushV3CodexTurn(state);
    const reasoning = flushed[0].parts.find((p: any) => p.type === 'reasoning');
    expect(reasoning).toBeDefined();
    if (reasoning?.type === 'reasoning') {
      expect(reasoning.text).toBe('Coalesced reasoning');
    }
  });

  it('handles synthetic tool-call lifecycle', () => {
    const state = makeState();
    handleCodexEvent({ type: 'task_started' }, state);
    handleCodexEvent({
      type: 'tool-call',
      callId: 'reasoning-1',
      name: 'CodexReasoning',
      input: { title: 'Plan' },
    }, state);
    handleCodexEvent({
      type: 'tool-call-result',
      callId: 'reasoning-1',
      output: { content: 'Reasoned result', status: 'completed' },
    }, state);

    const flushed = flushV3CodexTurn(state);
    const tool = flushed[0].parts.find((p: any) => p.type === 'tool');
    expect(tool).toBeDefined();
    if (tool?.type === 'tool') {
      expect(tool.tool).toBe('CodexReasoning');
      expect(tool.state.status).toBe('completed');
      if (tool.state.status === 'completed') {
        expect(tool.state.output).toBe('Reasoned result');
      }
    }
  });

  it('handles exec_command lifecycle', () => {
    const state = makeState();
    handleCodexEvent({ type: 'task_started' }, state);

    handleCodexEvent({
      type: 'exec_command_begin',
      call_id: 'cmd_1',
      command: ['npm', 'test'],
    }, state);

    const r = handleCodexEvent({
      type: 'exec_command_end',
      call_id: 'cmd_1',
      exit_code: 0,
      stdout: 'All tests passed',
    }, state);

    const toolPart = r.currentAssistant!.parts.find((p: any) => p.type === 'tool');
    expect(toolPart).toBeDefined();
    if (toolPart?.type === 'tool') {
      expect(toolPart.state.status).toBe('completed');
      if (toolPart.state.status === 'completed') {
        expect(toolPart.state.output).toBe('All tests passed');
      }
    }
  });

  it('handles exec_command error', () => {
    const state = makeState();
    handleCodexEvent({ type: 'task_started' }, state);
    handleCodexEvent({ type: 'exec_command_begin', call_id: 'cmd_2', command: 'bad_cmd' }, state);
    handleCodexEvent({ type: 'exec_command_end', call_id: 'cmd_2', exit_code: 1, stderr: 'not found' }, state);

    const flushed = flushV3CodexTurn(state);
    const toolPart = flushed[0].parts.find((p: any) => p.type === 'tool');
    if (toolPart?.type === 'tool') {
      expect(toolPart.state.status).toBe('error');
    }
  });

  it('handles patch lifecycle', () => {
    const state = makeState();
    handleCodexEvent({ type: 'task_started' }, state);
    handleCodexEvent({
      type: 'patch_apply_begin',
      call_id: 'patch_1',
      changes: { 'src/app.ts': { type: 'update', unified_diff: '...' } },
    }, state);
    handleCodexEvent({ type: 'patch_apply_end', call_id: 'patch_1' }, state);

    const flushed = flushV3CodexTurn(state);
    const toolPart = flushed[0].parts.find((p: any) => p.type === 'tool');
    if (toolPart?.type === 'tool') {
      expect(toolPart.tool).toBe('apply_patch');
      expect(toolPart.state.status).toBe('completed');
    }
  });

  it('handles exec_approval_request → blocked tool', () => {
    const state = makeState();
    handleCodexEvent({ type: 'task_started' }, state);
    handleCodexEvent({ type: 'exec_command_begin', call_id: 'cmd_3', command: 'rm -rf /' }, state);

    handleCodexEvent({
      type: 'exec_approval_request',
      callId: 'cmd_3',
      command: ['rm', '-rf', '/'],
      reason: 'Destructive command',
    }, state);

    const r = state.currentAssistant;
    expect(r).not.toBeNull();
    const toolPart = r!.parts.find((p: any) => p.type === 'tool');
    if (toolPart?.type === 'tool') {
      expect(toolPart.state.status).toBe('blocked');
      if (toolPart.state.status === 'blocked') {
        expect(toolPart.state.block.type).toBe('permission');
      }
    }
  });

  it('handles apply_patch_approval → blocked tool', () => {
    const state = makeState();
    handleCodexEvent({ type: 'task_started' }, state);
    handleCodexEvent({
      type: 'patch_apply_begin',
      call_id: 'patch_2',
      changes: { 'secret.env': { type: 'update', unified_diff: '...' } },
    }, state);

    handleCodexEvent({
      type: 'apply_patch_approval',
      call_id: 'patch_2',
      file_changes: { 'secret.env': { type: 'update', unified_diff: '...' } },
    }, state);

    const toolPart = state.currentAssistant!.parts.find((p: any) => p.type === 'tool');
    if (toolPart?.type === 'tool') {
      expect(toolPart.state.status).toBe('blocked');
      if (toolPart.state.status === 'blocked') {
        expect(toolPart.state.block.type).toBe('permission');
        if (toolPart.state.block.type === 'permission') {
          expect(toolPart.state.block.patterns).toContain('secret.env');
        }
      }
    }
  });

  it('produces step-start and step-finish', () => {
    const state = makeState();
    handleCodexEvent({ type: 'task_started' }, state);
    handleCodexEvent({ type: 'agent_message', message: 'Done' }, state);

    const flushed = flushV3CodexTurn(state);
    const parts = flushed[0].parts;
    expect(parts[0].type).toBe('step-start');
    expect(parts[parts.length - 1].type).toBe('step-finish');
  });

  it('finishes with tool-calls when tools are present', () => {
    const state = makeState();
    handleCodexEvent({ type: 'task_started' }, state);
    handleCodexEvent({ type: 'exec_command_begin', call_id: 'c1', command: 'ls' }, state);
    handleCodexEvent({ type: 'exec_command_end', call_id: 'c1', exit_code: 0, stdout: '.' }, state);
    handleCodexEvent({ type: 'task_complete' }, state);

    // The finalized message from task_complete
    const state2 = makeState();
    handleCodexEvent({ type: 'task_started' }, state2);
    handleCodexEvent({ type: 'exec_command_begin', call_id: 'c2', command: 'ls' }, state2);
    handleCodexEvent({ type: 'exec_command_end', call_id: 'c2', exit_code: 0, stdout: '.' }, state2);
    const flushed = flushV3CodexTurn(state2);
    if (flushed[0].info.role === 'assistant') {
      expect(flushed[0].info.finish).toBe('tool-calls');
    }
  });
});
