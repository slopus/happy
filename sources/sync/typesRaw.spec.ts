import { describe, it, expect } from 'vitest';
import { normalizeRawMessage } from './typesRaw';

/**
 * WOLOG Content Normalization Tests
 *
 * These tests verify the Zod transform approach handles:
 * 1. Hyphenated types (tool-call, tool-call-result) → Canonical (tool_use, tool_result)
 * 2. Canonical types pass through unchanged (idempotency)
 * 3. Unknown fields are preserved (future API compatibility)
 * 4. Unexpected data formats are handled gracefully
 * 5. Backwards compatibility with old CLI messages
 * 6. Cross-agent compatibility (Claude SDK, Codex, Gemini)
 */

// Import the actual schemas from typesRaw.ts
// Note: We're testing the schemas as black boxes through their public API
import { RawRecordSchema } from './typesRaw';

describe('Zod Transform - WOLOG Content Normalization', () => {

    describe('Accepts and transforms hyphenated types', () => {
        it('transforms tool-call to tool_use with field remapping', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool-call',
                                callId: 'call_abc123',
                                name: 'Bash',
                                input: { command: 'ls -la' }
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'output' && content.data.type === 'assistant') {
                    const firstItem = content.data.message.content[0];
                    expect(firstItem.type).toBe('tool_use');
                    if (firstItem.type === 'tool_use') {
                        expect(firstItem.id).toBe('call_abc123');  // callId → id
                        expect(firstItem.name).toBe('Bash');
                        expect(firstItem.input).toEqual({ command: 'ls -la' });
                    }
                }
            }
        });

        it('transforms tool-call-result to tool_result with field remapping', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{
                                type: 'tool-call-result',
                                callId: 'call_abc123',
                                output: 'file1.txt\nfile2.txt',
                                is_error: false
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'output' && content.data.type === 'user') {
                    const msgContent = content.data.message.content;
                    if (Array.isArray(msgContent) && msgContent[0].type === 'tool_result') {
                        expect(msgContent[0].type).toBe('tool_result');
                        expect(msgContent[0].tool_use_id).toBe('call_abc123');  // callId → tool_use_id
                        expect(msgContent[0].content).toBe('file1.txt\nfile2.txt');  // output → content
                        expect(msgContent[0].is_error).toBe(false);
                    }
                }
            }
        });

        it('preserves unknown fields for future compatibility', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool-call',
                                callId: 'call_xyz',
                                name: 'Read',
                                input: {},
                                futureField: 'some_value',  // Unknown field
                                metadata: { timestamp: 123 }  // Unknown nested field
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'output' && content.data.type === 'assistant') {
                    const firstItem: any = content.data.message.content[0];
                    expect(firstItem.type).toBe('tool_use');
                    expect(firstItem.id).toBe('call_xyz');
                    // Verify unknown fields are preserved
                    expect(firstItem.futureField).toBe('some_value');
                    expect(firstItem.metadata).toEqual({ timestamp: 123 });
                }
            }
        });
    });

    describe('Accepts canonical underscore types without transformation (idempotency)', () => {
        it('passes through tool_use unchanged', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool_use',
                                id: 'call_123',
                                name: 'Write',
                                input: { file_path: '/test.txt' }
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'output' && content.data.type === 'assistant') {
                    const firstItem = content.data.message.content[0];
                    expect(firstItem.type).toBe('tool_use');
                    if (firstItem.type === 'tool_use') {
                        expect(firstItem.id).toBe('call_123');
                        expect(firstItem.name).toBe('Write');
                    }
                }
            }
        });

        it('passes through tool_result unchanged', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{
                                type: 'tool_result',
                                tool_use_id: 'call_123',
                                content: 'Success',
                                is_error: false
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'output' && content.data.type === 'user') {
                    const msgContent = content.data.message.content;
                    if (Array.isArray(msgContent) && msgContent[0].type === 'tool_result') {
                        expect(msgContent[0].type).toBe('tool_result');
                        expect(msgContent[0].tool_use_id).toBe('call_123');
                        expect(msgContent[0].content).toBe('Success');
                    }
                }
            }
        });

        it('passes through text content unchanged', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'text',
                                text: 'Hello world'
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'output' && content.data.type === 'assistant') {
                    const firstItem = content.data.message.content[0];
                    expect(firstItem.type).toBe('text');
                    if (firstItem.type === 'text') {
                        expect(firstItem.text).toBe('Hello world');
                    }
                }
            }
        });
    });

    describe('Rejects unknown content types with clear errors', () => {
        it('fails validation for unknown type with clear error message', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'unknown-type',
                                data: 'some data'
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            expect(result.success).toBe(false);
            if (!result.success) {
                // Verify error includes information about expected types
                expect(result.error.issues).toBeDefined();
                expect(result.error.issues.length).toBeGreaterThan(0);
                // The error should be about invalid union (discriminated union mismatch)
                const firstIssue = result.error.issues[0];
                expect(firstIssue.code).toBe('invalid_union');
            }
        });
    });

    describe('Handles mixed hyphenated and canonical in same message', () => {
        it('transforms mixed content array correctly', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [
                                { type: 'text', text: 'Running command...' },
                                { type: 'tool-call', callId: 'call_1', name: 'Bash', input: { command: 'ls' } },
                                { type: 'tool_use', id: 'call_2', name: 'Read', input: { file_path: '/test.txt' } }
                            ]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'output' && content.data.type === 'assistant') {
                    const items = content.data.message.content;

                    // Text passes through
                    expect(items[0].type).toBe('text');

                    // tool-call transformed to tool_use
                    expect(items[1].type).toBe('tool_use');
                    if (items[1].type === 'tool_use') {
                        expect(items[1].id).toBe('call_1');
                    }

                    // tool_use passes through
                    expect(items[2].type).toBe('tool_use');
                    if (items[2].type === 'tool_use') {
                        expect(items[2].id).toBe('call_2');
                    }
                }
            }
        });

        it('handles tool results with both hyphenated and canonical', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [
                                { type: 'tool-call-result', callId: 'call_1', output: 'result1' },
                                { type: 'tool_result', tool_use_id: 'call_2', content: 'result2' }
                            ]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'output' && content.data.type === 'user') {
                    const items = content.data.message.content;
                    if (Array.isArray(items)) {
                        // Both normalized to tool_result
                        expect(items[0].type).toBe('tool_result');
                        if (items[0].type === 'tool_result') {
                            expect(items[0].tool_use_id).toBe('call_1');
                            expect(items[0].content).toBe('result1');
                        }

                        expect(items[1].type).toBe('tool_result');
                        if (items[1].type === 'tool_result') {
                            expect(items[1].tool_use_id).toBe('call_2');
                            expect(items[1].content).toBe('result2');
                        }
                    }
                }
            }
        });
    });

    describe('Backwards compatibility with old CLI messages', () => {
        it('handles old CLI with canonical underscore types', () => {
            const oldCliMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [
                                { type: 'tool_use', id: 'call_old', name: 'Read', input: {} }
                            ]
                        },
                        uuid: 'old-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(oldCliMessage);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'output' && content.data.type === 'assistant') {
                    const firstItem = content.data.message.content[0];
                    expect(firstItem.type).toBe('tool_use');
                    if (firstItem.type === 'tool_use') {
                        expect(firstItem.id).toBe('call_old');
                    }
                }
            }
        });
    });

    describe('Codex/Gemini messages use native hyphenated schema (no transformation)', () => {
        it('accepts Codex tool-call messages via codex schema path', () => {
            const codexMessage = {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call',
                        callId: 'codex_1',
                        name: 'Bash',
                        input: { command: 'pwd' },
                        id: 'codex-id-1'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(codexMessage);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'codex' && content.data.type === 'tool-call') {
                    // Codex path keeps hyphenated types as-is
                    expect(content.data.type).toBe('tool-call');
                    expect(content.data.callId).toBe('codex_1');
                }
            }
        });

        it('accepts Codex tool-call-result messages via codex schema path', () => {
            const codexMessage = {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call-result',
                        callId: 'codex_result_1',
                        output: 'command output',
                        id: 'codex-id-2'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(codexMessage);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'codex' && content.data.type === 'tool-call-result') {
                    // Codex path keeps hyphenated types as-is
                    expect(content.data.type).toBe('tool-call-result');
                    expect(content.data.callId).toBe('codex_result_1');
                    expect(content.data.output).toBe('command output');
                }
            }
        });
    });

    describe('Handles unexpected data formats gracefully', () => {
        it('handles tool-call with both callId and id fields (prefers callId)', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool-call',
                                callId: 'primary_id',
                                id: 'secondary_id',  // Both present
                                name: 'Edit',
                                input: {}
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'output' && content.data.type === 'assistant') {
                    const firstItem = content.data.message.content[0];
                    expect(firstItem.type).toBe('tool_use');
                    if (firstItem.type === 'tool_use') {
                        // Should use callId as the canonical id
                        expect(firstItem.id).toBe('primary_id');
                    }
                }
            }
        });

        it('handles tool-call-result with both output and content fields (prefers output)', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{
                                type: 'tool-call-result',
                                callId: 'call_dual',
                                output: 'primary_output',
                                content: 'secondary_content',  // Both present
                                is_error: false
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'output' && content.data.type === 'user') {
                    const msgContent = content.data.message.content;
                    if (Array.isArray(msgContent) && msgContent[0].type === 'tool_result') {
                        // Should use output as the canonical content
                        expect(msgContent[0].content).toBe('primary_output');
                    }
                }
            }
        });

        it('handles missing optional is_error field (defaults to false)', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{
                                type: 'tool-call-result',
                                callId: 'call_no_error',
                                output: 'success'
                                // is_error missing
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            expect(result.success).toBe(true);
            if (result.success) {
                const content = result.data.content;
                if (content.type === 'output' && content.data.type === 'user') {
                    const msgContent = content.data.message.content;
                    if (Array.isArray(msgContent) && msgContent[0].type === 'tool_result') {
                        // Should default is_error to false
                        expect(msgContent[0].is_error).toBe(false);
                    }
                }
            }
        });

        it('rejects tool-call missing required callId field', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool-call',
                                // callId missing!
                                name: 'Bash',
                                input: {}
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            // Should fail validation
            expect(result.success).toBe(false);
            if (!result.success) {
                // Verify error mentions missing callId
                const errorString = JSON.stringify(result.error.issues);
                expect(errorString).toContain('callId');
            }
        });

        it('rejects tool_use missing required id field', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool_use',
                                // id missing!
                                name: 'Read',
                                input: {}
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(message);

            // Should fail validation
            expect(result.success).toBe(false);
            if (!result.success) {
                const errorString = JSON.stringify(result.error.issues);
                expect(errorString).toContain('id');
            }
        });
    });

    describe('Integration: Complete message flow scenarios', () => {
        it('handles real Claude SDK assistant message with tool_use', () => {
            const realMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-sonnet-4-5-20250929',
                            content: [
                                { type: 'text', text: 'Let me read that file for you.' },
                                {
                                    type: 'tool_use',
                                    id: 'toolu_01ABC123',
                                    name: 'Read',
                                    input: { file_path: '/Users/test/file.ts' }
                                }
                            ],
                            usage: {
                                input_tokens: 1000,
                                output_tokens: 50
                            }
                        },
                        uuid: 'real-assistant-uuid',
                        parentUuid: null
                    }
                },
                meta: {
                    sentFrom: 'cli'
                }
            };

            const result = RawRecordSchema.safeParse(realMessage);

            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.role).toBe('agent');
                expect(result.data.content.type).toBe('output');
                if (result.data.content.type === 'output' && result.data.content.data.type === 'assistant') {
                    const content = result.data.content.data.message.content;
                    expect(content.length).toBe(2);
                    expect(content[0].type).toBe('text');
                    expect(content[1].type).toBe('tool_use');
                    if (content[1].type === 'tool_use') {
                        expect(content[1].id).toBe('toolu_01ABC123');
                    }
                }
            }
        });

        it('handles real user message with tool_result', () => {
            const realMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{
                                type: 'tool_result',
                                tool_use_id: 'toolu_01ABC123',
                                content: 'File contents here...',
                                is_error: false,
                                permissions: {
                                    date: 1736300000000,
                                    result: 'approved',
                                    mode: 'default'
                                }
                            }]
                        },
                        uuid: 'real-user-uuid',
                        parentUuid: 'real-assistant-uuid',
                        isSidechain: false
                    }
                },
                meta: {
                    sentFrom: 'cli'
                }
            };

            const result = RawRecordSchema.safeParse(realMessage);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'user') {
                const content = result.data.content.data.message.content;
                if (Array.isArray(content) && content[0].type === 'tool_result') {
                    expect(content[0].type).toBe('tool_result');
                    expect(content[0].tool_use_id).toBe('toolu_01ABC123');
                    expect(content[0].permissions).toBeDefined();
                }
            }
        });

        it('handles sidechain messages (parent_tool_use_id present)', () => {
            const sidechainMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [
                                { type: 'text', text: 'Sidechain response' }
                            ]
                        },
                        uuid: 'sidechain-uuid',
                        parentUuid: 'parent-uuid',
                        isSidechain: true,
                        parent_tool_use_id: 'toolu_parent'
                    }
                },
                meta: {
                    sentFrom: 'cli'
                }
            };

            const result = RawRecordSchema.safeParse(sidechainMessage);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'assistant') {
                expect(result.data.content.data.isSidechain).toBe(true);
                expect(result.data.content.data.parent_tool_use_id).toBe('toolu_parent');
            }
        });
    });

    describe('Unexpected data format robustness', () => {
        it('handles tool-call with extra unknown fields from future API', () => {
            const futureMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-4',
                            content: [{
                                type: 'tool-call',
                                callId: 'future_call',
                                name: 'FutureTool',
                                input: {},
                                // Future API fields
                                priority: 'high',
                                timeout: 30000,
                                metadata: { version: '2.0' }
                            }]
                        },
                        uuid: 'future-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(futureMessage);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'assistant') {
                const item: any = result.data.content.data.message.content[0];
                expect(item.type).toBe('tool_use');
                // Unknown fields should be preserved
                expect(item.priority).toBe('high');
                expect(item.timeout).toBe(30000);
                expect(item.metadata).toEqual({ version: '2.0' });
            }
        });

        it('handles empty content array', () => {
            const emptyMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: []  // Empty
                        },
                        uuid: 'empty-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(emptyMessage);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'assistant') {
                expect(result.data.content.data.message.content).toEqual([]);
            }
        });

        it('handles string content in user messages (not array)', () => {
            const stringContentMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: 'Plain string message'  // Not an array
                        },
                        uuid: 'string-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(stringContentMessage);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'user') {
                expect(result.data.content.data.message.content).toBe('Plain string message');
            }
        });

        it('handles system messages (no transformation needed)', () => {
            const systemMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'system'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(systemMessage);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output') {
                expect(result.data.content.data.type).toBe('system');
            }
        });

        it('handles summary messages', () => {
            const summaryMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'summary',
                        summary: 'Session summary text'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(summaryMessage);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'summary') {
                expect(result.data.content.data.summary).toBe('Session summary text');
            }
        });

        it('handles event messages (no content transformation)', () => {
            const eventMessage = {
                role: 'agent',
                content: {
                    type: 'event',
                    id: 'event-123',
                    data: {
                        type: 'switch',
                        mode: 'local'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(eventMessage);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'event') {
                expect(result.data.content.data.type).toBe('switch');
                if (result.data.content.data.type === 'switch') {
                    expect(result.data.content.data.mode).toBe('local');
                }
            }
        });

        it('handles user role messages with text content', () => {
            const userMessage = {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'User input message'
                }
            };

            const result = RawRecordSchema.safeParse(userMessage);

            expect(result.success).toBe(true);
            if (result.success && result.data.role === 'user') {
                expect(result.data.content.type).toBe('text');
                expect(result.data.content.text).toBe('User input message');
            }
        });
    });

    describe('Field preservation and edge cases', () => {
        it('preserves permissions object in tool_result', () => {
            const messageWithPermissions = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{
                                type: 'tool_result',
                                tool_use_id: 'perm_call',
                                content: 'result',
                                is_error: false,
                                permissions: {
                                    date: 1736300000000,
                                    result: 'approved',
                                    mode: 'acceptEdits',
                                    allowedTools: ['Read', 'Write'],
                                    decision: 'approved_for_session'
                                }
                            }]
                        },
                        uuid: 'perm-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(messageWithPermissions);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'user') {
                const content = result.data.content.data.message.content;
                if (Array.isArray(content) && content[0].type === 'tool_result') {
                    expect(content[0].permissions).toBeDefined();
                    expect(content[0].permissions?.result).toBe('approved');
                    expect(content[0].permissions?.mode).toBe('acceptEdits');
                    expect(content[0].permissions?.allowedTools).toEqual(['Read', 'Write']);
                }
            }
        });

        it('handles tool_result with array content (text blocks)', () => {
            const messageWithArrayContent = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'user',
                        message: {
                            role: 'user',
                            content: [{
                                type: 'tool_result',
                                tool_use_id: 'array_call',
                                content: [
                                    { type: 'text', text: 'First block' },
                                    { type: 'text', text: 'Second block' }
                                ],
                                is_error: false
                            }]
                        },
                        uuid: 'array-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(messageWithArrayContent);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'user') {
                const content = result.data.content.data.message.content;
                if (Array.isArray(content) && content[0].type === 'tool_result') {
                    expect(Array.isArray(content[0].content)).toBe(true);
                    if (Array.isArray(content[0].content)) {
                        expect(content[0].content.length).toBe(2);
                        expect(content[0].content[0].text).toBe('First block');
                    }
                }
            }
        });

        it('handles metadata fields (uuid, parentUuid, isSidechain, etc.)', () => {
            const messageWithMetadata = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{ type: 'text', text: 'Test' }]
                        },
                        uuid: 'meta-uuid-123',
                        parentUuid: 'parent-uuid-456',
                        isSidechain: true,
                        isCompactSummary: false,
                        isMeta: false
                    }
                }
            };

            const result = RawRecordSchema.safeParse(messageWithMetadata);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output') {
                expect(result.data.content.data.uuid).toBe('meta-uuid-123');
                expect(result.data.content.data.parentUuid).toBe('parent-uuid-456');
                expect(result.data.content.data.isSidechain).toBe(true);
            }
        });
    });

    describe('WOLOG: Cross-agent format handling', () => {
        it('Claude SDK (underscore) passes through unchanged', () => {
            const claudeMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [
                                { type: 'tool_use', id: 'claude_1', name: 'Bash', input: {} }
                            ]
                        },
                        uuid: 'claude-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(claudeMessage);

            expect(result.success).toBe(true);
            // Verify underscore types remain unchanged (idempotent)
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'assistant') {
                expect(result.data.content.data.message.content[0].type).toBe('tool_use');
            }
        });

        it('Codex (hyphenated via codex path) uses native schema', () => {
            const codexMessage = {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call',
                        callId: 'codex_tool',
                        name: 'Read',
                        input: {},
                        id: 'codex-msg-id'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(codexMessage);

            expect(result.success).toBe(true);
            // Codex path keeps hyphenated types (no transformation)
            if (result.success && result.data.content.type === 'codex') {
                expect(result.data.content.data.type).toBe('tool-call');
                if (result.data.content.data.type === 'tool-call') {
                    expect(result.data.content.data.callId).toBe('codex_tool');
                }
            }
        });

        it('Gemini (uses codex path) works with hyphenated types', () => {
            // Gemini uses sendCodexMessage() in CLI, so type: 'codex'
            const geminiMessage = {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'message',
                        message: 'Gemini reasoning output'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(geminiMessage);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'codex' && result.data.content.data.type === 'message') {
                expect(result.data.content.data.message).toBe('Gemini reasoning output');
            }
        });

        it('handles hypothetical hyphenated types in output path (defensive)', () => {
            // This tests the defensive nature of the transform
            // If CLI ever sends hyphenated in output path, it should work
            const hypotheticalMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'future-model',
                            content: [{
                                type: 'tool-call',  // Hyphenated in output path
                                callId: 'defensive_test',
                                name: 'NewTool',
                                input: { param: 'value' }
                            }]
                        },
                        uuid: 'defensive-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(hypotheticalMessage);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'assistant') {
                // Should transform to tool_use
                const item = result.data.content.data.message.content[0];
                expect(item.type).toBe('tool_use');
                if (item.type === 'tool_use') {
                    expect(item.id).toBe('defensive_test');
                }
            }
        });
    });

    describe('Regression prevention: Ensure existing behavior unchanged', () => {
        it('Zod transform produces same output as old preprocessing for canonical types', () => {
            const canonicalMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [
                                { type: 'text', text: 'Hello' },
                                { type: 'tool_use', id: 'c1', name: 'Read', input: {} }
                            ]
                        },
                        uuid: 'regression-test'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(canonicalMessage);

            expect(result.success).toBe(true);
            // Verify output format matches what old preprocessing would produce
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'assistant') {
                const content = result.data.content.data.message.content;
                expect(content[0].type).toBe('text');
                if (content[0].type === 'text') {
                    expect(content[0].text).toBe('Hello');
                }
                expect(content[1].type).toBe('tool_use');
                if (content[1].type === 'tool_use') {
                    expect(content[1].id).toBe('c1');
                    expect(content[1].name).toBe('Read');
                    expect(content[1].input).toEqual({});
                }
            }
        });

        it('Zod transform is idempotent (applying twice produces same result)', () => {
            const message = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [
                                { type: 'tool-call', callId: 'idem_1', name: 'Bash', input: {} }
                            ]
                        },
                        uuid: 'idem-uuid'
                    }
                }
            };

            // Parse once
            const firstResult = RawRecordSchema.safeParse(message);
            expect(firstResult.success).toBe(true);

            // Parse the result again (should be idempotent)
            if (firstResult.success) {
                const secondResult = RawRecordSchema.safeParse(firstResult.data);
                expect(secondResult.success).toBe(true);

                // Results should be identical
                expect(JSON.stringify(secondResult.data)).toBe(JSON.stringify(firstResult.data));
            }
        });

        it('Error messages are preserved (validation still returns clear errors)', () => {
            const invalidMessage = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'invalid-type',
                                data: 'bad'
                            }]
                        },
                        uuid: 'error-test'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(invalidMessage);

            expect(result.success).toBe(false);
            if (!result.success) {
                // Error should be clear and actionable
                expect(result.error.issues.length).toBeGreaterThan(0);
                // Should mention union validation issue
                const errorJson = JSON.stringify(result.error.issues);
                expect(errorJson).toContain('invalid_union');
            }
        });
    });

    describe('Unknown field preservation (WOLOG)', () => {
        it('preserves unknown fields in thinking content via .passthrough()', () => {
            const thinkingWithUnknownFields = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'thinking',
                                thinking: 'Reasoning here',
                                signature: 'EqkCCkYICxgCKkB...',  // Unknown field
                                futureField: 'some_value'       // Unknown field
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(thinkingWithUnknownFields);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'assistant') {
                const thinkingContent = result.data.content.data.message.content[0];
                if (thinkingContent.type === 'thinking') {
                    // Verify unknown fields preserved
                    expect((thinkingContent as any).signature).toBe('EqkCCkYICxgCKkB...');
                    expect((thinkingContent as any).futureField).toBe('some_value');
                }
            }
        });

        it('preserves unknown fields in transformed tool-call → tool_use', () => {
            const toolCallWithUnknownFields = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool-call',
                                callId: 'test-call',
                                name: 'Bash',
                                input: { command: 'ls' },
                                metadata: { timestamp: 123 },  // Unknown field
                                customField: 'custom_value'    // Unknown field
                            }]
                        },
                        uuid: 'test-uuid'
                    }
                }
            };

            const result = RawRecordSchema.safeParse(toolCallWithUnknownFields);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output' && result.data.content.data.type === 'assistant') {
                const toolUseContent = result.data.content.data.message.content[0];
                if (toolUseContent.type === 'tool_use') {
                    // Verify transform preserved unknown fields
                    expect(toolUseContent.id).toBe('test-call');
                    expect((toolUseContent as any).metadata).toEqual({ timestamp: 123 });
                    expect((toolUseContent as any).customField).toBe('custom_value');
                }
            }
        });

        it('preserves CLI metadata fields via .passthrough()', () => {
            const messageWithMetadata = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        message: { role: 'assistant', model: 'claude-3', content: [] },
                        uuid: 'test-uuid',
                        userType: 'external',      // CLI metadata
                        cwd: '/path/to/project',   // CLI metadata
                        sessionId: 'session-123',  // CLI metadata
                        version: '2.1.1',          // CLI metadata
                        gitBranch: 'main',         // CLI metadata
                        slug: 'test-slug',         // CLI metadata
                        requestId: 'req-123',      // CLI metadata
                        timestamp: '2026-01-09T00:00:00.000Z'  // CLI metadata
                    }
                }
            };

            const result = RawRecordSchema.safeParse(messageWithMetadata);

            expect(result.success).toBe(true);
            if (result.success && result.data.content.type === 'output') {
                // Verify metadata preserved
                expect((result.data.content.data as any).userType).toBe('external');
                expect((result.data.content.data as any).cwd).toBe('/path/to/project');
                expect((result.data.content.data as any).sessionId).toBe('session-123');
            }
        });

        it('END-TO-END: preserves unknown fields through normalizeRawMessage()', () => {
            const messageWithUnknownFields = {
                role: 'agent' as const,
                content: {
                    type: 'output' as const,
                    data: {
                        type: 'assistant' as const,
                        message: {
                            role: 'assistant' as const,
                            model: 'claude-3',
                            content: [
                                {
                                    type: 'thinking' as const,
                                    thinking: 'Extended thinking reasoning',
                                    signature: 'EqkCCkYICxgCKkB...',  // Unknown field from Claude API
                                    customField: 'test_value'          // Unknown field
                                },
                                {
                                    type: 'text' as const,
                                    text: 'Final response',
                                    metadata: { timestamp: 123 }       // Unknown field
                                }
                            ]
                        },
                        uuid: 'wolog-e2e-test',
                        userType: 'external'  // CLI metadata (unknown to schema definition)
                    }
                }
            };

            const normalized = normalizeRawMessage('msg-1', null, Date.now(), messageWithUnknownFields);

            expect(normalized).toBeTruthy();
            if (normalized && normalized.role === 'agent') {
                expect(normalized.content.length).toBe(2);

                // Verify thinking content preserved unknown fields
                const thinkingItem = normalized.content[0];
                expect(thinkingItem.type).toBe('thinking');
                if (thinkingItem.type === 'thinking') {
                    expect(thinkingItem.thinking).toBe('Extended thinking reasoning');
                    expect((thinkingItem as any).signature).toBe('EqkCCkYICxgCKkB...');
                    expect((thinkingItem as any).customField).toBe('test_value');
                }

                // Verify text content preserved unknown fields
                const textItem = normalized.content[1];
                expect(textItem.type).toBe('text');
                if (textItem.type === 'text') {
                    expect(textItem.text).toBe('Final response');
                    expect((textItem as any).metadata).toEqual({ timestamp: 123 });
                }
            }
        });

        it('END-TO-END: preserves unknown fields in transformed tool-call through normalizeRawMessage()', () => {
            const messageWithHyphenatedUnknownFields = {
                role: 'agent' as const,
                content: {
                    type: 'output' as const,
                    data: {
                        type: 'assistant' as const,
                        message: {
                            role: 'assistant' as const,
                            model: 'claude-3',
                            content: [{
                                type: 'tool-call' as const,
                                callId: 'e2e-test-call',
                                name: 'Bash',
                                input: { command: 'ls' },
                                executionMetadata: { server: 'remote' },  // Unknown field
                                timestamp: 1234567890                      // Unknown field
                            }]
                        },
                        uuid: 'wolog-transform-e2e'
                    }
                }
            };

            const normalized = normalizeRawMessage('msg-2', null, Date.now(), messageWithHyphenatedUnknownFields);

            expect(normalized).toBeTruthy();
            if (normalized && normalized.role === 'agent') {
                const toolCallItem = normalized.content[0];
                expect(toolCallItem.type).toBe('tool-call');
                if (toolCallItem.type === 'tool-call') {
                    expect(toolCallItem.id).toBe('e2e-test-call');
                    expect(toolCallItem.name).toBe('Bash');
                    // Verify unknown fields preserved through transformation
                    expect((toolCallItem as any).executionMetadata).toEqual({ server: 'remote' });
                    expect((toolCallItem as any).timestamp).toBe(1234567890);
                }
            }
        });
    });
});
