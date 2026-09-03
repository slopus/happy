import { describe, expect, it } from 'vitest';
import { formatCodexEventForLog } from './codexEventLog';

describe('formatCodexEventForLog', () => {
    it.each(['mcp_tool_call_begin', 'mcp_tool_call_end'])(
        'allowlists lifecycle fields for %s without logging MCP App secrets',
        (type) => {
            const prohibitedCanaries = [
                'CANARY_RESOURCE_URI',
                'CANARY_SERVER',
                'CANARY_TOOL',
                'CANARY_APP_NAME',
                'CANARY_CONNECTOR',
                'CANARY_ACCOUNT',
                'CANARY_ARGUMENT',
                'CANARY_CONTENT',
                'CANARY_STRUCTURED',
                'CANARY_META',
                'CANARY_HTML',
                'CANARY_RAW_ERROR',
            ];
            const actualLoggerArgument = formatCodexEventForLog({
                type,
                call_id: 'call-safe-1',
                callId: 'call-safe-1',
                item_id: 'item-safe-1',
                turn_id: 'turn-sensitive-and-unneeded',
                thread_id: 'thread-sensitive-and-unneeded',
                subagent: 'subagent-sensitive-and-unneeded',
                status: type === 'mcp_tool_call_end' ? 'completed' : 'inProgress',
                error: { message: 'CANARY_RAW_ERROR' },
                accountId: 'CANARY_ACCOUNT',
                mcp_call: {
                    callId: 'call-safe-1',
                    server: 'CANARY_SERVER',
                    tool: 'CANARY_TOOL',
                    input: { secret: 'CANARY_ARGUMENT' },
                    connectorId: 'CANARY_CONNECTOR',
                    presentation: {
                        version: 1,
                        server: 'CANARY_SERVER',
                        resourceUri: 'ui://CANARY_RESOURCE_URI/view.html',
                        appName: 'CANARY_APP_NAME',
                    },
                    result: {
                        version: 1,
                        state: 'available',
                        content: [{ type: 'text', text: 'CANARY_CONTENT' }],
                        structuredContent: { value: 'CANARY_STRUCTURED' },
                        _meta: { value: 'CANARY_META' },
                        html: '<p>CANARY_HTML</p>',
                    },
                },
            });
            const serializedLoggerArgument = JSON.stringify(actualLoggerArgument);

            expect(serializedLoggerArgument).toContain(type);
            expect(serializedLoggerArgument).toContain('call-safe-1');
            expect(serializedLoggerArgument).toContain('item-safe-1');
            for (const canary of prohibitedCanaries) {
                expect(serializedLoggerArgument).not.toContain(canary);
            }
            for (const field of [
                'mcp_call',
                'resourceUri',
                'server',
                'tool',
                'appName',
                'connectorId',
                'accountId',
                'input',
                'content',
                'result',
                'structuredContent',
                '_meta',
                'html',
                'error',
                'thread_id',
                'subagent',
            ]) {
                expect(serializedLoggerArgument).not.toContain(`\"${field}\":`);
            }
        },
    );

    it('leaves non-MCP event logging unchanged', () => {
        const event = {
            type: 'agent_message',
            message: 'ordinary event payload',
            nested: { retained: true },
        };

        expect(formatCodexEventForLog(event)).toBe(`[Codex] Event: ${JSON.stringify(event)}`);
    });
});
