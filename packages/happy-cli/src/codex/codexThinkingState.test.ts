import { describe, expect, it } from 'vitest';
import { nextCodexThinkingState } from './codexThinkingState';

describe('Codex thinking state', () => {
    it('restores busy for a continuation and clears it when that turn completes', () => {
        let thinking = false;
        const transitions: boolean[] = [];
        for (const type of ['task_started', 'agent_message', 'task_complete', 'token_count', 'agent_message', 'exec_command_begin', 'task_complete']) {
            const next = nextCodexThinkingState(thinking, type, false);
            if (next !== thinking) transitions.push(next);
            thinking = next;
        }
        expect(transitions).toEqual([true, false, true, false]);
    });

    it.each(['agent_reasoning', 'agent_reasoning_delta', 'exec_command_begin', 'exec_command_end', 'mcp_tool_call_begin', 'mcp_tool_call_end', 'patch_apply_begin', 'patch_apply_end'])('recognizes %s as work before any assistant reply', type => {
        expect(nextCodexThinkingState(false, type, false)).toBe(true);
        expect(nextCodexThinkingState(false, type, true)).toBe(false);
    });

    it('does not wake an idle parent on metadata, usage, or subagent output', () => {
        for (const type of ['thread_goal_updated', 'token_count', 'unknown']) {
            expect(nextCodexThinkingState(false, type, false)).toBe(false);
            expect(nextCodexThinkingState(true, type, false)).toBe(true);
        }
        expect(nextCodexThinkingState(false, 'agent_message', true)).toBe(false);
        expect(nextCodexThinkingState(true, 'turn_aborted', false)).toBe(false);
    });
});
