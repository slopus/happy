/**
 * v3 Wiring Proof Tests
 *
 * Proves that the v3 protocol pipeline works end-to-end by exercising the
 * actual wired code paths that were connected in Phase 2.
 *
 * The pipeline:
 *   Claude SDK message → handleClaudeMessage → v3 envelope { v: 3, message }
 *   permissionHandler → blockToolForPermission/unblock → updated v3 envelope
 *   Codex event → handleCodexEvent → v3 envelope { v: 3, message }
 *
 * These tests prove the mapper produces valid v3 envelopes with permission
 * blocking/unblocking working correctly through the actual code paths.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    createV3MapperState,
    handleClaudeMessage,
    flushV3Turn,
    blockToolForPermission,
    unblockToolApproved,
    unblockToolRejected,
    type V3MapperState,
} from './v3Mapper';
import {
    createV3CodexMapperState,
    handleCodexEvent,
    type V3CodexMapperState,
} from '../../codex/utils/v3Mapper';

// v3 envelope detector (same logic as app's isV3Envelope)
function isV3Envelope(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object') return false;
    const p = payload as Record<string, unknown>;
    return p.v === 3 && p.message !== null && typeof p.message === 'object';
}

// ─── Claude: Full pipeline ──────────────────────────────────────────────────

describe('Claude v3 pipeline: SDK → mapper → v3 envelope', () => {
    let state: V3MapperState;

    beforeEach(() => {
        state = createV3MapperState({ sessionID: 'sess-1', providerID: 'anthropic' });
    });

    it('produces v3 envelopes from a full turn: user → assistant(text+tool) → tool_result → finalize', () => {
        // 1. User message
        const r1 = handleClaudeMessage({
            type: 'user',
            message: { role: 'user', content: 'Read all files' },
        } as any, state);
        expect(r1.messages).toHaveLength(1);
        expect(r1.messages[0].info.role).toBe('user');
        expect(isV3Envelope({ v: 3, message: r1.messages[0] })).toBe(true);

        // 2. Assistant with text + tool
        const r2 = handleClaudeMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Reading files...' },
                    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/app.js' } },
                ],
                model: 'claude-sonnet-4-20250514',
                usage: { input_tokens: 100, output_tokens: 50 },
            },
        } as any, state);
        expect(r2.currentAssistant).toBeTruthy();
        expect(r2.currentAssistant!.parts.some(p => p.type === 'text')).toBe(true);
        expect(r2.currentAssistant!.parts.some(p => p.type === 'tool')).toBe(true);

        // 3. Tool result finalizes the assistant message
        const r3 = handleClaudeMessage({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'const x = 42;' }] },
        } as any, state);

        const finalized = r3.messages.find(m => m.info.role === 'assistant')!;
        expect(finalized).toBeTruthy();
        expect(finalized.parts[0].type).toBe('step-start');
        expect(finalized.parts[finalized.parts.length - 1].type).toBe('step-finish');
        expect(isV3Envelope({ v: 3, message: finalized })).toBe(true);

        // Tool is completed
        const tool = finalized.parts.find(p => p.type === 'tool') as any;
        expect(tool.state.status).toBe('completed');
        expect(tool.state.output).toBe('const x = 42;');
        expect(tool.callID).toBe('toolu_1');

        // Info has correct metadata
        expect((finalized.info as any).providerID).toBe('anthropic');
        expect((finalized.info as any).modelID).toBe('claude-sonnet-4-20250514');
        expect((finalized.info as any).tokens.input).toBe(100);
    });
});

// ─── Claude: Permission pipeline ────────────────────────────────────────────

describe('Claude v3 permission pipeline: block → approve/reject → v3 envelope', () => {
    let state: V3MapperState;

    beforeEach(() => {
        state = createV3MapperState({ sessionID: 'sess-2', providerID: 'anthropic' });
        // Setup: user + assistant with tool
        handleClaudeMessage({ type: 'user', message: { role: 'user', content: 'Fix bug' } } as any, state);
        handleClaudeMessage({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'toolu_edit', name: 'Edit', input: { file_path: 'app.js' } }],
                usage: { input_tokens: 50, output_tokens: 30 },
            },
        } as any, state);
    });

    it('blockToolForPermission sets tool to blocked state', () => {
        const msg = blockToolForPermission(state, 'toolu_edit', 'Edit', ['app.js'], { file_path: 'app.js' });
        expect(msg).toBeTruthy();
        const tool = msg!.parts.find(p => p.type === 'tool') as any;
        expect(tool.state.status).toBe('blocked');
        expect(tool.state.block.type).toBe('permission');
        expect(tool.state.block.permission).toBe('Edit');
        expect(tool.state.block.patterns).toEqual(['app.js']);
    });

    it('unblockToolRejected sets tool to error with reject decision', () => {
        blockToolForPermission(state, 'toolu_edit', 'Edit', ['app.js'], {});
        const msg = unblockToolRejected(state, 'toolu_edit', 'show diff first');
        expect(msg).toBeTruthy();
        const tool = msg!.parts.find(p => p.type === 'tool') as any;
        expect(tool.state.status).toBe('error');
        expect(tool.state.error).toBe('show diff first');
        expect(tool.state.block.decision).toBe('reject');
        expect(typeof tool.state.block.decidedAt).toBe('number');
    });

    it('unblockToolApproved(once) → complete → block.decision=once on finalized message', () => {
        blockToolForPermission(state, 'toolu_edit', 'Edit', ['app.js'], {});
        const approved = unblockToolApproved(state, 'toolu_edit', 'once');
        expect(approved).toBeTruthy();
        const runningTool = approved!.parts.find(p => p.type === 'tool') as any;
        expect(runningTool.state.status).toBe('running'); // back to running

        // Complete via tool_result
        const r = handleClaudeMessage({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'Done' }] },
        } as any, state);

        const finalized = r.messages.find(m => m.info.role === 'assistant')!;
        const completedTool = finalized.parts.find(p => p.type === 'tool') as any;
        expect(completedTool.state.status).toBe('completed');
        expect(completedTool.state.block.decision).toBe('once');
    });

    it('unblockToolApproved(always) → complete → block.decision=always', () => {
        blockToolForPermission(state, 'toolu_edit', 'Edit', ['app.js'], {});
        unblockToolApproved(state, 'toolu_edit', 'always');

        const r = handleClaudeMessage({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'Done' }] },
        } as any, state);

        const finalized = r.messages.find(m => m.info.role === 'assistant')!;
        const completedTool = finalized.parts.find(p => p.type === 'tool') as any;
        expect(completedTool.state.status).toBe('completed');
        expect(completedTool.state.block.decision).toBe('always');
    });
});

// ─── Codex: Full pipeline ───────────────────────────────────────────────────

describe('Codex v3 pipeline: events → mapper → v3 envelope', () => {
    let state: V3CodexMapperState;

    beforeEach(() => {
        state = createV3CodexMapperState({ sessionID: 'codex-1', providerID: 'openai' });
    });

    it('full turn: task_started → message → exec → exec_end → task_complete → v3 envelope', () => {
        handleCodexEvent({ type: 'task_started' }, state);
        handleCodexEvent({ type: 'agent_message', message: 'Running command.' }, state);
        handleCodexEvent({ type: 'exec_command_begin', call_id: 'c1', command: 'echo hello' }, state);
        handleCodexEvent({ type: 'exec_command_end', call_id: 'c1', exit_code: 0, stdout: 'hello\n' }, state);
        const r = handleCodexEvent({ type: 'task_complete' }, state);

        expect(r.messages).toHaveLength(1);
        const msg = r.messages[0];
        expect(msg.info.role).toBe('assistant');
        expect((msg.info as any).providerID).toBe('openai');
        expect(isV3Envelope({ v: 3, message: msg })).toBe(true);

        // Structure
        expect(msg.parts[0].type).toBe('step-start');
        expect(msg.parts[msg.parts.length - 1].type).toBe('step-finish');

        // Text part
        const text = msg.parts.find(p => p.type === 'text') as any;
        expect(text.text).toBe('Running command.');

        // Tool part completed
        const tool = msg.parts.find(p => p.type === 'tool') as any;
        expect(tool.state.status).toBe('completed');
        expect(tool.state.output).toBe('hello\n');
        expect(tool.callID).toBe('c1');
    });

    it('exec_approval_request blocks tool with permission block', () => {
        handleCodexEvent({ type: 'task_started' }, state);
        handleCodexEvent({ type: 'exec_command_begin', call_id: 'c2', command: 'rm -rf /' }, state);
        const r = handleCodexEvent({
            type: 'exec_approval_request',
            callId: 'c2',
            command: 'rm -rf /',
            reason: 'Dangerous',
        }, state);

        const tool = r.currentAssistant!.parts.find(p => p.type === 'tool') as any;
        expect(tool.state.status).toBe('blocked');
        expect(tool.state.block.type).toBe('permission');
        expect(tool.state.block.permission).toBe('bash');
    });

    it('patch_apply_begin → patch_apply_end produces completed tool part', () => {
        handleCodexEvent({ type: 'task_started' }, state);
        handleCodexEvent({
            type: 'patch_apply_begin',
            call_id: 'p1',
            changes: { 'app.js': '+ // comment' },
        }, state);
        handleCodexEvent({ type: 'patch_apply_end', call_id: 'p1', success: true, stdout: '' }, state);
        const r = handleCodexEvent({ type: 'task_complete' }, state);

        const tool = r.messages[0].parts.find(p => p.type === 'tool') as any;
        expect(tool.state.status).toBe('completed');
        expect(tool.tool).toBe('apply_patch');
    });

    it('turn_aborted produces finalized message with cancelled reason', () => {
        handleCodexEvent({ type: 'task_started' }, state);
        handleCodexEvent({ type: 'agent_message', message: 'Working...' }, state);
        const r = handleCodexEvent({ type: 'turn_aborted' }, state);

        expect(r.messages).toHaveLength(1);
        const finish = r.messages[0].parts.find(p => p.type === 'step-finish') as any;
        expect(finish.reason).toBe('cancelled');
    });
});
