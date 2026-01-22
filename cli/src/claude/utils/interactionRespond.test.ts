import { describe, expect, it, vi } from 'vitest';

describe('interaction.respond (Claude)', () => {
    it('approves the tool call and injects a tool_result user message', async () => {
        const { handleClaudeInteractionRespond } = await import('./interactionRespond');

        const approve = vi.fn();
        const pushToolResult = vi.fn();

        await handleClaudeInteractionRespond({
            toolCallId: 'toolu_123',
            responseText: 'Q1: A',
            approveToolCall: approve,
            pushToolResult,
        });

        expect(approve).toHaveBeenCalledWith('toolu_123');
        expect(pushToolResult).toHaveBeenCalledTimes(1);
        expect(pushToolResult.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                type: 'user',
                message: expect.objectContaining({
                    role: 'user',
                }),
            }),
        );
    });
});

