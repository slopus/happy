import { describe, it, expect } from 'vitest';
import { normalizeRawMessage, NormalizedMessage } from '../typesRaw';
import { createReducer } from './reducer';
import { reducer } from './reducer';
import { AgentState } from '../storageTypes';

describe('reducer', () => {
    // it('should process golden cases', () => {
    //     for (let i = 0; i <= 3; i++) {

    //         // Load raw data
    //         const raw = require(`./__testdata__/log_${i}.json`) as any[];
    //         const rawParsed = raw.map((v: any) => RawRecordSchema.parse(v.content));
    //         for (let i = 0; i < rawParsed.length; i++) {
    //             expect(rawParsed[i]).not.toBeNull();
    //         }
    //         expect(rawParsed, `raw_${i}`).toMatchSnapshot();

    //         const normalized = rawParsed.map((v: any, i) => normalizeRawMessage(`${i}`, null, 0, v));
    //         for (let i = 0; i < normalized.length; i++) {
    //             if (rawParsed[i].role === 'agent' && ((rawParsed[i] as any).content.data.type === 'system' || (rawParsed[i] as any).content.data.type === 'result')) {
    //                 continue;
    //             }
    //             expect(normalized[i]).not.toBeNull();
    //         }
    //         expect(normalized, `normalized_${i}`).toMatchSnapshot();

    //         const state = createReducer();
    //         const newMessages = reducer(state, normalized.filter(v => v !== null));
    //         expect(newMessages, `log_${i}`).toMatchSnapshot();
    //     }
    // });

    describe('user message handling', () => {
        it('should process user messages with localId', () => {
            const state = createReducer();
            const messages = [
                normalizeRawMessage('msg1', 'local123', 1000, {
                    role: 'user',
                    content: { type: 'text', text: 'Hello' }
                })
            ].filter(Boolean) as NormalizedMessage[];

            const result = reducer(state, messages);
            expect(result).toHaveLength(1);
            expect(result[0].kind).toBe('user-text');
            if (result[0].kind === 'user-text') {
                expect(result[0].text).toBe('Hello');
            }
            expect(state.localIds.has('local123')).toBe(true);
        });

        it('should deduplicate user messages by localId', () => {
            const state = createReducer();
            
            // First message with localId
            const messages1 = [
                normalizeRawMessage('msg1', 'local123', 1000, {
                    role: 'user',
                    content: { type: 'text', text: 'First' }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result1 = reducer(state, messages1);
            expect(result1).toHaveLength(1);

            // Second message with same localId should be ignored
            const messages2 = [
                normalizeRawMessage('msg2', 'local123', 2000, {
                    role: 'user',
                    content: { type: 'text', text: 'Second' }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result2 = reducer(state, messages2);
            expect(result2).toHaveLength(0);
        });

        it('should deduplicate user messages by message id when no localId', () => {
            const state = createReducer();
            
            // First message without localId
            const messages1 = [
                normalizeRawMessage('msg1', null, 1000, {
                    role: 'user',
                    content: { type: 'text', text: 'First' }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result1 = reducer(state, messages1);
            expect(result1).toHaveLength(1);

            // Second message with same id should be ignored
            const messages2 = [
                normalizeRawMessage('msg1', null, 2000, {
                    role: 'user',
                    content: { type: 'text', text: 'Second' }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result2 = reducer(state, messages2);
            expect(result2).toHaveLength(0);
        });

        it('should process multiple user messages with different localIds', () => {
            const state = createReducer();
            const messages = [
                normalizeRawMessage('msg1', 'local123', 1000, {
                    role: 'user',
                    content: { type: 'text', text: 'First' }
                }),
                normalizeRawMessage('msg2', 'local456', 2000, {
                    role: 'user',
                    content: { type: 'text', text: 'Second' }
                }),
                normalizeRawMessage('msg3', null, 3000, {
                    role: 'user',
                    content: { type: 'text', text: 'Third' }
                })
            ].filter(Boolean) as NormalizedMessage[];

            const result = reducer(state, messages);
            expect(result).toHaveLength(3);
            if (result[0].kind === 'user-text') {
                expect(result[0].text).toBe('First');
            }
            if (result[1].kind === 'user-text') {
                expect(result[1].text).toBe('Second');
            }
            if (result[2].kind === 'user-text') {
                expect(result[2].text).toBe('Third');
            }
        });
    });

    describe('agent text message handling', () => {
        it('should process agent text messages', () => {
            const state = createReducer();
            const messages = [
                normalizeRawMessage('agent1', null, 1000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'test-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'text',
                                    text: 'Hello from Claude!'
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];

            const result = reducer(state, messages);
            expect(result).toHaveLength(1);
            expect(result[0].kind).toBe('agent-text');
            if (result[0].kind === 'agent-text') {
                expect(result[0].text).toBe('Hello from Claude!');
            }
        });

        it('should process multiple text blocks in one agent message', () => {
            const state = createReducer();
            const messages = [
                normalizeRawMessage('agent1', null, 1000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'test-uuid-2',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [
                                    { type: 'text', text: 'Part 1' },
                                    { type: 'text', text: 'Part 2' }
                                ]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];

            const result = reducer(state, messages);
            expect(result).toHaveLength(2);
            if (result[0].kind === 'agent-text') {
                expect(result[0].text).toBe('Part 1');
            }
            if (result[1].kind === 'agent-text') {
                expect(result[1].text).toBe('Part 2');
            }
        });
    });

    describe('mixed message processing', () => {
        it('should handle interleaved user and agent messages', () => {
            const state = createReducer();
            const messages = [
                normalizeRawMessage('user1', 'local1', 1000, {
                    role: 'user',
                    content: { type: 'text', text: 'Question 1' }
                }),
                normalizeRawMessage('agent1', null, 2000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'test-uuid-3',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{ type: 'text', text: 'Answer 1' }]
                            }
                        }
                    }
                }),
                normalizeRawMessage('user2', 'local2', 3000, {
                    role: 'user',
                    content: { type: 'text', text: 'Question 2' }
                }),
                normalizeRawMessage('agent2', null, 4000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'test-uuid-4',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{ type: 'text', text: 'Answer 2' }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];

            const result = reducer(state, messages);
            expect(result).toHaveLength(4);
            expect(result[0].kind).toBe('user-text');
            if (result[0].kind === 'user-text') {
                expect(result[0].text).toBe('Question 1');
            }
            expect(result[1].kind).toBe('agent-text');
            if (result[1].kind === 'agent-text') {
                expect(result[1].text).toBe('Answer 1');
            }
            expect(result[2].kind).toBe('user-text');
            if (result[2].kind === 'user-text') {
                expect(result[2].text).toBe('Question 2');
            }
            expect(result[3].kind).toBe('agent-text');
            if (result[3].kind === 'agent-text') {
                expect(result[3].text).toBe('Answer 2');
            }
        });
    });

    describe('edge cases', () => {
        it('should handle empty message array', () => {
            const state = createReducer();
            const result = reducer(state, []);
            expect(result).toHaveLength(0);
        });

        it('should not duplicate agent messages when applied multiple times', () => {
            const state = createReducer();
            const messages = [
                normalizeRawMessage('agent1', null, 1000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'test-uuid-5',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'text',
                                    text: 'Hello world!'
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];

            // Apply the same messages multiple times
            const result1 = reducer(state, messages);
            expect(result1).toHaveLength(1);
            
            const result2 = reducer(state, messages);
            expect(result2).toHaveLength(0); // Should not add duplicates
            
            const result3 = reducer(state, messages);
            expect(result3).toHaveLength(0); // Still no duplicates
        });

        it('should filter out null normalized messages', () => {
            const state = createReducer();
            const messages = [
                normalizeRawMessage('user1', 'local1', 1000, {
                    role: 'user',
                    content: { type: 'text', text: 'Valid' }
                }),
                null,
                null
            ].filter(Boolean) as NormalizedMessage[];

            const result = reducer(state, messages);
            expect(result).toHaveLength(1);
            if (result[0].kind === 'user-text') {
                expect(result[0].text).toBe('Valid');
            }
        });

        it('should handle summary messages', () => {
            const state = createReducer();
            const messages = [
                normalizeRawMessage('agent1', null, 1000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'summary',
                            summary: 'This is a summary'
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];

            const result = reducer(state, messages);
            // Summary messages should be processed but may not appear in output
            expect(result).toBeDefined();
        });
    });

    describe('AgentState permissions', () => {
        it('should create tool messages for pending permission requests', () => {
            const state = createReducer();
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                }
            };

            const result = reducer(state, [], agentState);
            
            expect(result).toHaveLength(1);
            expect(result[0].kind).toBe('tool-call');
            if (result[0].kind === 'tool-call') {
                expect(result[0].tool.name).toBe('Bash');
                expect(result[0].tool.state).toBe('running');
                expect(result[0].tool.permission).toEqual({
                    id: 'perm-1',
                    status: 'pending'
                });
            }
        });

        it('should update permission status for completed requests', () => {
            const state = createReducer();
            
            // First create a pending permission
            const agentState1: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                }
            };
            
            const result1 = reducer(state, [], agentState1);
            expect(result1).toHaveLength(1);

            // Then mark it as completed
            const agentState2: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'denied',
                        reason: 'User denied permission'
                    }
                }
            };

            const result2 = reducer(state, [], agentState2);
            expect(result2).toHaveLength(1);
            if (result2[0].kind === 'tool-call') {
                expect(result2[0].tool.state).toBe('error');
                expect(result2[0].tool.permission?.status).toBe('denied');
                expect(result2[0].tool.permission?.reason).toBe('User denied permission');
            }
        });

        it('should match incoming tool calls to approved permission messages', () => {
            const state = createReducer();
            
            // First create an approved permission
            const agentState: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };
            
            const result1 = reducer(state, [], agentState);
            expect(result1).toHaveLength(1);
            
            // Then receive the actual tool call from the agent
            const messages: NormalizedMessage[] = [
                normalizeRawMessage('msg-1', null, 3000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'msg-1-uuid',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-1',
                                    name: 'Bash',
                                    input: { command: 'ls -la' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];

            const result2 = reducer(state, messages, agentState);
            
            // The tool call should be matched to the existing permission message
            // So we should get an update to the existing message, not a new one
            expect(result2).toHaveLength(1);
            if (result2[0].kind === 'tool-call') {
                expect(result2[0].tool.permission?.status).toBe('approved');
                expect(result2[0].tool.state).toBe('running');
                expect(result2[0].tool.name).toBe('Bash');
            }
        });

        it('should not match a single request to multiple messages', () => {
            const state = createReducer();
            
            // Create multiple pending permission requests
            const agentState1: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    },
                    'perm-2': {
                        tool: 'Bash',
                        arguments: { command: 'pwd' },
                        createdAt: 2000
                    }
                }
            };
            
            const result1 = reducer(state, [], agentState1);
            expect(result1).toHaveLength(2);

            // Approve both permissions
            const agentState2: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 3000,
                        status: 'approved'
                    },
                    'perm-2': {
                        tool: 'Bash',
                        arguments: { command: 'pwd' },
                        createdAt: 2000,
                        completedAt: 3000,
                        status: 'approved'
                    }
                }
            };
            
            reducer(state, [], agentState2);

            // Now receive a tool call from the agent
            const messages: NormalizedMessage[] = [
                normalizeRawMessage('msg-1', null, 4000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'msg-2-uuid',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-1',
                                    name: 'Bash',
                                    input: { command: 'pwd' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];

            // Pass agentState2 - it's always provided as current state
            const result3 = reducer(state, messages, agentState2);
            
            // Should only return the updated message that matched the tool call
            expect(result3).toHaveLength(1);
            expect(result3[0].kind).toBe('tool-call');
            if (result3[0].kind === 'tool-call') {
                expect(result3[0].tool.input).toEqual({ command: 'pwd' });
            }
            
            // Verify that only one permission is linked to a tool
            let linkedCount = 0;
            for (const [_, toolId] of state.permissionIdToToolId) {
                if (toolId === 'tool-1') linkedCount++;
            }
            expect(linkedCount).toBe(1);
        });

        it('should not create new message when tool can be matched to existing permission (priority to newest)', () => {
            const state = createReducer();
            
            // Create multiple approved permissions with same tool but different times
            const agentState: AgentState = {
                completedRequests: {
                    'perm-old': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    },
                    'perm-new': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 3000,
                        completedAt: 4000,
                        status: 'approved'
                    }
                }
            };
            
            const result1 = reducer(state, [], agentState);
            expect(result1).toHaveLength(2);
            
            // Store the message IDs
            const oldMessageId = state.permissionIdToMessageId.get('perm-old');
            const newMessageId = state.permissionIdToMessageId.get('perm-new');
            
            // Now receive a tool call that matches both
            const messages: NormalizedMessage[] = [
                normalizeRawMessage('msg-1', null, 5000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'msg-3-uuid',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-1',
                                    name: 'Bash',
                                    input: { command: 'ls' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];

            // Pass agentState - it's always provided as current state
            const result2 = reducer(state, messages, agentState);
            
            // Should only return the updated message that matched
            expect(result2).toHaveLength(1);
            expect(result2[0].kind).toBe('tool-call');
            if (result2[0].kind === 'tool-call') {
                expect(result2[0].tool.input).toEqual({ command: 'ls' });
            }
            
            // Verify it matched to the newer permission
            expect(state.permissionIdToToolId.get('perm-new')).toBe('tool-1');
            expect(state.permissionIdToToolId.get('perm-old')).toBeUndefined();
            
            // Verify the newer message was updated
            const newMessage = state.messages.get(newMessageId!);
            expect(newMessage?.tool?.startedAt).toBe(5000);
            
            // Verify the older message was not updated
            const oldMessage = state.messages.get(oldMessageId!);
            expect(oldMessage?.tool?.startedAt).toBeNull();
        });

        it('should not create duplicate messages when called twice with same AgentState', () => {
            const state = createReducer();
            
            // AgentState with both pending and completed permissions
            const agentState: AgentState = {
                requests: {
                    'perm-pending': {
                        tool: 'Read',
                        arguments: { file: 'test.txt' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'perm-completed': {
                        tool: 'Write',
                        arguments: { file: 'output.txt', content: 'hello' },
                        createdAt: 2000,
                        completedAt: 3000,
                        status: 'approved'
                    }
                }
            };
            
            // First call - should create messages
            const result1 = reducer(state, [], agentState);
            expect(result1).toHaveLength(2);
            
            // Verify the messages were created
            expect(state.permissionIdToMessageId.has('perm-pending')).toBe(true);
            expect(state.permissionIdToMessageId.has('perm-completed')).toBe(true);
            
            // Second call with same AgentState - should not create duplicates
            const result2 = reducer(state, [], agentState);
            expect(result2).toHaveLength(0); // No new messages
            
            // Verify the mappings still exist and haven't changed
            expect(state.permissionIdToMessageId.size).toBe(2);
            
            // Third call with a message and same AgentState - still no duplicates
            const messages: NormalizedMessage[] = [
                normalizeRawMessage('msg-1', null, 4000, {
                    role: 'user',
                    content: { type: 'text', text: 'Hello' }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result3 = reducer(state, messages, agentState);
            expect(result3).toHaveLength(1); // Only the user message
            expect(result3[0].kind).toBe('user-text');
            
            // Verify permission messages weren't duplicated
            expect(state.permissionIdToMessageId.size).toBe(2);
        });

        it('should prioritize tool call over permission request when both provided simultaneously', () => {
            const state = createReducer();
            
            // AgentState with approved permission
            const agentState: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };
            
            // Tool call message with different timestamp
            const messages: NormalizedMessage[] = [
                normalizeRawMessage('tool-msg-1', null, 5000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'tool-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-1',
                                    name: 'Bash',
                                    input: { command: 'ls' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            // Process both simultaneously
            const result = reducer(state, messages, agentState);
            
            // Should create only one message (the tool call takes priority)
            expect(result).toHaveLength(1);
            expect(result[0].kind).toBe('tool-call');
            if (result[0].kind === 'tool-call') {
                // Should use tool call's timestamp, not permission's
                expect(result[0].createdAt).toBe(5000);
                expect(result[0].id).toBeDefined();
                
                // Should have permission info from AgentState (it was skipped in Phase 0 but attached in Phase 2)
                expect(result[0].tool.permission).toBeDefined();
                expect(result[0].tool.permission?.id).toBe('perm-1');
                expect(result[0].tool.permission?.status).toBe('approved');
            }
            
            // Verify only the tool message was created, not a separate permission message
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);
            expect(state.permissionIdToMessageId.has('perm-1')).toBe(true);
            // Both should point to the same message
            expect(state.toolIdToMessageId.get('tool-1')).toBe(state.permissionIdToMessageId.get('perm-1'));
        });

        it('should preserve original timestamps when request received first, then tool call', () => {
            const state = createReducer();
            
            // First: Process permission request
            const agentState1: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 1000
                    }
                }
            };
            
            const result1 = reducer(state, [], agentState1);
            expect(result1).toHaveLength(1);
            
            const permMessageId = state.permissionIdToMessageId.get('perm-1');
            const originalMessage = state.messages.get(permMessageId!);
            expect(originalMessage?.createdAt).toBe(1000);
            expect(originalMessage?.realID).toBeNull();
            
            // Then: Approve the permission
            const agentState2: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };
            
            const result2 = reducer(state, [], agentState2);
            expect(result2).toHaveLength(1); // Same message, updated
            
            // Finally: Receive the actual tool call
            const messages: NormalizedMessage[] = [
                normalizeRawMessage('tool-msg-1', null, 5000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'tool-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-1',
                                    name: 'Bash',
                                    input: { command: 'ls' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result3 = reducer(state, messages, agentState2);
            expect(result3).toHaveLength(1); // Same message, updated
            
            // Check the final state of the message
            const finalMessage = state.messages.get(permMessageId!);
            
            // Original timestamp should be preserved
            expect(finalMessage?.createdAt).toBe(1000);
            
            // But realID should be updated to the tool message's ID
            expect(finalMessage?.realID).toBe('tool-msg-1');
            
            // Tool should be updated with execution details
            expect(finalMessage?.tool?.startedAt).toBe(5000);
            expect(finalMessage?.tool?.permission?.status).toBe('approved');
            
            // Verify the tool is properly linked
            expect(state.toolIdToMessageId.get('tool-1')).toBe(permMessageId);
            expect(state.permissionIdToToolId.get('perm-1')).toBe('tool-1');
        });

        it('should create separate messages for same tool name with different arguments', () => {
            const state = createReducer();
            
            // AgentState with two approved permissions for same tool but different arguments
            const agentState: AgentState = {
                completedRequests: {
                    'perm-ls': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    },
                    'perm-pwd': {
                        tool: 'Bash',
                        arguments: { command: 'pwd' },
                        createdAt: 1500,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };
            
            // Process permissions
            const result1 = reducer(state, [], agentState);
            expect(result1).toHaveLength(2);
            
            // Both should be separate messages
            const lsMessageId = state.permissionIdToMessageId.get('perm-ls');
            const pwdMessageId = state.permissionIdToMessageId.get('perm-pwd');
            expect(lsMessageId).toBeDefined();
            expect(pwdMessageId).toBeDefined();
            expect(lsMessageId).not.toBe(pwdMessageId);
            
            // Verify the messages have correct arguments
            const lsMessage = state.messages.get(lsMessageId!);
            const pwdMessage = state.messages.get(pwdMessageId!);
            expect(lsMessage?.tool?.input).toEqual({ command: 'ls -la' });
            expect(pwdMessage?.tool?.input).toEqual({ command: 'pwd' });
            
            // Now receive the first tool call (pwd)
            const messages1: NormalizedMessage[] = [
                normalizeRawMessage('msg-1', null, 3000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'tool-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-pwd',
                                    name: 'Bash',
                                    input: { command: 'pwd' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result2 = reducer(state, messages1, agentState);
            expect(result2).toHaveLength(1);
            
            // Should match to the pwd permission (newer one, matching arguments)
            expect(state.toolIdToMessageId.get('tool-pwd')).toBe(pwdMessageId);
            expect(state.permissionIdToToolId.get('perm-pwd')).toBe('tool-pwd');
            // ls permission should remain unmatched
            expect(state.permissionIdToToolId.get('perm-ls')).toBeUndefined();
            
            // Now receive the second tool call (ls)
            const messages2: NormalizedMessage[] = [
                normalizeRawMessage('msg-2', null, 4000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'tool-uuid-2',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-ls',
                                    name: 'Bash',
                                    input: { command: 'ls -la' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result3 = reducer(state, messages2, agentState);
            expect(result3).toHaveLength(1);
            
            // Should match to the ls permission
            expect(state.toolIdToMessageId.get('tool-ls')).toBe(lsMessageId);
            expect(state.permissionIdToToolId.get('perm-ls')).toBe('tool-ls');
            
            // Both permissions should now be matched to their respective tools
            expect(state.permissionIdToToolId.size).toBe(2);
            expect(state.toolIdToMessageId.size).toBe(2);
            
            // Verify final states
            const finalLsMessage = state.messages.get(lsMessageId!);
            const finalPwdMessage = state.messages.get(pwdMessageId!);
            expect(finalLsMessage?.tool?.startedAt).toBe(4000);
            expect(finalPwdMessage?.tool?.startedAt).toBe(3000);
        });

        it('should create separate messages for pending request and tool call with same name but different arguments', () => {
            const state = createReducer();
            
            // AgentState with a pending permission request
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                }
            };
            
            // Tool call with same tool name but different arguments
            const messages: NormalizedMessage[] = [
                normalizeRawMessage('tool-msg-1', null, 2000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'tool-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-1',
                                    name: 'Bash',
                                    input: { command: 'pwd' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            // Process both simultaneously
            const result = reducer(state, messages, agentState);
            
            // Should create two separate messages
            expect(result).toHaveLength(2);
            
            // Find which message is which
            const permissionMessage = result.find(m => 
                m.kind === 'tool-call' && m.tool.permission?.id === 'perm-1'
            );
            const toolMessage = result.find(m => 
                m.kind === 'tool-call' && !m.tool.permission
            );
            
            expect(permissionMessage).toBeDefined();
            expect(toolMessage).toBeDefined();
            
            // Verify they have different arguments
            if (permissionMessage?.kind === 'tool-call') {
                expect(permissionMessage.tool.input).toEqual({ command: 'ls -la' });
                expect(permissionMessage.tool.permission?.status).toBe('pending');
                expect(permissionMessage.createdAt).toBe(1000);
            }
            
            if (toolMessage?.kind === 'tool-call') {
                expect(toolMessage.tool.input).toEqual({ command: 'pwd' });
                expect(toolMessage.tool.permission).toBeUndefined();
                expect(toolMessage.createdAt).toBe(2000);
            }
            
            // Verify internal state
            expect(state.permissionIdToMessageId.has('perm-1')).toBe(true);
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);
            
            // They should be different messages
            const permMsgId = state.permissionIdToMessageId.get('perm-1');
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            expect(permMsgId).not.toBe(toolMsgId);
            
            // Now approve the permission and send its tool call
            const agentState2: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 3000,
                        status: 'approved'
                    }
                }
            };
            
            const messages2: NormalizedMessage[] = [
                normalizeRawMessage('tool-msg-2', null, 4000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'tool-uuid-2',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-2',
                                    name: 'Bash',
                                    input: { command: 'ls -la' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result2 = reducer(state, messages2, agentState2);
            
            // Should update the permission message
            expect(result2).toHaveLength(1);
            expect(result2[0].kind).toBe('tool-call');
            if (result2[0].kind === 'tool-call') {
                expect(result2[0].tool.input).toEqual({ command: 'ls -la' });
                expect(result2[0].tool.permission?.status).toBe('approved');
            }
            
            // Verify it matched to the correct permission
            expect(state.permissionIdToToolId.get('perm-1')).toBe('tool-2');
            expect(state.toolIdToMessageId.get('tool-2')).toBe(permMsgId);
            
            // The original tool-1 should still be separate
            expect(state.toolIdToMessageId.get('tool-1')).toBe(toolMsgId);
            expect(state.toolIdToMessageId.get('tool-1')).not.toBe(state.toolIdToMessageId.get('tool-2'));
        });

        it('should handle full permission lifecycle: pending -> approved -> tool execution -> completion', () => {
            const state = createReducer();
            
            // Step 1: Create pending permission
            const agentState1: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Read',
                        arguments: { file: '/test.txt' },
                        createdAt: 1000
                    }
                }
            };
            
            const result1 = reducer(state, [], agentState1);
            expect(result1).toHaveLength(1);
            expect(result1[0].kind).toBe('tool-call');
            if (result1[0].kind === 'tool-call') {
                expect(result1[0].tool.state).toBe('running');
                expect(result1[0].tool.permission?.status).toBe('pending');
            }
            
            // Step 2: Approve permission
            const agentState2: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Read',
                        arguments: { file: '/test.txt' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };
            
            const result2 = reducer(state, [], agentState2);
            expect(result2).toHaveLength(1);
            if (result2[0].kind === 'tool-call') {
                expect(result2[0].tool.permission?.status).toBe('approved');
                expect(result2[0].tool.state).toBe('running');
            }
            
            // Step 3: Tool call arrives
            const toolMessages: NormalizedMessage[] = [
                normalizeRawMessage('msg-1', null, 3000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'tool-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-1',
                                    name: 'Read',
                                    input: { file: '/test.txt' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result3 = reducer(state, toolMessages, agentState2);
            expect(result3).toHaveLength(1);
            if (result3[0].kind === 'tool-call') {
                expect(result3[0].tool.startedAt).toBe(3000);
            }
            
            // Step 4: Tool result arrives
            const resultMessages: NormalizedMessage[] = [
                normalizeRawMessage('msg-2', null, 4000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'result-uuid-1',
                            message: {
                                role: 'user',
                                content: [{
                                    type: 'tool_result',
                                    tool_use_id: 'tool-1',
                                    content: 'File contents',
                                    is_error: false
                                }]
                            },
                            toolUseResult: 'File contents'
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result4 = reducer(state, resultMessages, agentState2);
            expect(result4).toHaveLength(1);
            if (result4[0].kind === 'tool-call') {
                expect(result4[0].tool.state).toBe('completed');
                expect(result4[0].tool.result).toBe('File contents');
                expect(result4[0].tool.completedAt).toBe(4000);
            }
        });

        it('should handle denied and canceled permissions correctly', () => {
            const state = createReducer();
            
            // Create two permissions
            const agentState1: AgentState = {
                requests: {
                    'perm-deny': {
                        tool: 'Write',
                        arguments: { file: '/secure.txt', content: 'hack' },
                        createdAt: 1000
                    },
                    'perm-cancel': {
                        tool: 'Delete',
                        arguments: { file: '/important.txt' },
                        createdAt: 1500
                    }
                }
            };
            
            const result1 = reducer(state, [], agentState1);
            expect(result1).toHaveLength(2);
            
            // Deny first, cancel second
            const agentState2: AgentState = {
                completedRequests: {
                    'perm-deny': {
                        tool: 'Write',
                        arguments: { file: '/secure.txt', content: 'hack' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'denied',
                        reason: 'Unauthorized access'
                    },
                    'perm-cancel': {
                        tool: 'Delete',
                        arguments: { file: '/important.txt' },
                        createdAt: 1500,
                        completedAt: 2500,
                        status: 'canceled',
                        reason: 'User canceled'
                    }
                }
            };
            
            const result2 = reducer(state, [], agentState2);
            expect(result2).toHaveLength(2);
            
            const deniedMsg = result2.find(m => 
                m.kind === 'tool-call' && m.tool.name === 'Write'
            );
            const canceledMsg = result2.find(m => 
                m.kind === 'tool-call' && m.tool.name === 'Delete'
            );
            
            if (deniedMsg?.kind === 'tool-call') {
                expect(deniedMsg.tool.state).toBe('error');
                expect(deniedMsg.tool.permission?.status).toBe('denied');
                expect(deniedMsg.tool.permission?.reason).toBe('Unauthorized access');
                expect(deniedMsg.tool.result).toEqual({ error: 'Unauthorized access' });
            }
            
            if (canceledMsg?.kind === 'tool-call') {
                expect(canceledMsg.tool.state).toBe('error');
                expect(canceledMsg.tool.permission?.status).toBe('canceled');
                expect(canceledMsg.tool.permission?.reason).toBe('User canceled');
                expect(canceledMsg.tool.result).toEqual({ error: 'User canceled' });
            }
        });

        it('should handle tool result arriving before tool call (race condition)', () => {
            const state = createReducer();
            
            // Tool result arrives first
            const resultMessages: NormalizedMessage[] = [
                normalizeRawMessage('msg-1', null, 1000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'result-uuid-1',
                            message: {
                                role: 'user',
                                content: [{
                                    type: 'tool_result',
                                    tool_use_id: 'tool-1',
                                    content: 'Success',
                                    is_error: false
                                }]
                            },
                            toolUseResult: 'Success'
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result1 = reducer(state, resultMessages);
            expect(result1).toHaveLength(0); // Should not create anything
            
            // Tool call arrives later
            const toolMessages: NormalizedMessage[] = [
                normalizeRawMessage('msg-2', null, 2000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'tool-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-1',
                                    name: 'Test',
                                    input: { test: true }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result2 = reducer(state, toolMessages);
            expect(result2).toHaveLength(1);
            if (result2[0].kind === 'tool-call') {
                expect(result2[0].tool.state).toBe('running'); // Result was ignored
                expect(result2[0].tool.result).toBeUndefined();
            }
            
            // Result arrives again (with different message ID since it's a new message)
            const resultMessages2: NormalizedMessage[] = [
                normalizeRawMessage('msg-3', null, 3000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'result-uuid-2',
                            message: {
                                role: 'user',
                                content: [{
                                    type: 'tool_result',
                                    tool_use_id: 'tool-1',
                                    content: 'Success',
                                    is_error: false
                                }]
                            },
                            toolUseResult: 'Success'
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result3 = reducer(state, resultMessages2, null);
            
            // Debug: Check if tool was properly registered
            const toolId = 'tool-1';
            const msgId = state.toolIdToMessageId.get(toolId);
            const message = msgId ? state.messages.get(msgId) : null;
            
            expect(result3).toHaveLength(1);
            if (result3[0].kind === 'tool-call') {
                expect(result3[0].tool.state).toBe('completed');
                expect(result3[0].tool.result).toBe('Success');
            }
        });

        it('should isolate sidechain tool calls from main message flow', () => {
            const state = createReducer();
            const agentState: AgentState = {
                requests: {},
                completedRequests: {}
            };
            
            // Main flow: Task tool call that will spawn a sidechain
            const mainToolMessages: NormalizedMessage[] = [
                normalizeRawMessage('main-msg-1', null, 1000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'main-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'main-tool-1',
                                    name: 'Task',  // Use Task which creates sidechains
                                    input: { prompt: 'Do something in sidechain' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result1 = reducer(state, mainToolMessages, agentState);
            expect(result1).toHaveLength(1);
            expect(result1[0].kind).toBe('tool-call');
            if (result1[0].kind === 'tool-call') {
                expect(result1[0].tool.name).toBe('Task');
                expect(result1[0].tool.state).toBe('running');
            }
            
            // Sidechain flow: messages that occur within the Task's execution context
            // The tracer will automatically link these to the Task tool
            const sidechainMessages: NormalizedMessage[] = [
                // Sidechain root message (user prompt in sidechain)
                normalizeRawMessage('sidechain-1', null, 2000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'sidechain-uuid-1',
                            isSidechain: true,
                            message: {
                                role: 'user',
                                content: 'Do something in sidechain' as any
                            }
                        }
                    }
                }),
                // Tool call within the sidechain
                normalizeRawMessage('sidechain-2', null, 3000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'sidechain-uuid-2',
                            parentUuid: 'sidechain-uuid-1',
                            isSidechain: true,
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'sidechain-tool-1',
                                    name: 'SidechainTool',
                                    input: { action: 'sidechain' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result2 = reducer(state, sidechainMessages, agentState);
            // Sidechain messages shouldn't appear in main flow (they're stored in children)
            expect(result2).toHaveLength(0);
            
            // Verify sidechain is stored separately
            expect(state.sidechains.has('main-msg-1')).toBe(true);
            const sidechainContent = state.sidechains.get('main-msg-1');
            expect(sidechainContent).toBeDefined();
            expect(sidechainContent?.length).toBe(2); // User prompt + tool call
            
            // Tool results for main Task tool
            const mainResultMessages: NormalizedMessage[] = [
                normalizeRawMessage('main-result-1', null, 4000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'main-result-uuid',
                            message: {
                                role: 'user',
                                content: [{
                                    type: 'tool_result',
                                    tool_use_id: 'main-tool-1',
                                    content: 'Task completed successfully',
                                    is_error: false
                                }]
                            },
                            toolUseResult: 'Task completed successfully'
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result3 = reducer(state, mainResultMessages, agentState);
            expect(result3).toHaveLength(1);
            if (result3[0].kind === 'tool-call') {
                expect(result3[0].tool.state).toBe('completed');
                expect(result3[0].tool.result).toBe('Task completed successfully');
                expect(result3[0].tool.name).toBe('Task');
            }
            
            // Tool results for sidechain tool (should update sidechain, not main)
            const sidechainResultMessages: NormalizedMessage[] = [
                normalizeRawMessage('sidechain-result-1', null, 5000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'sidechain-result-uuid',
                            parentUuid: 'sidechain-uuid-2',
                            isSidechain: true,
                            message: {
                                role: 'user',
                                content: [{
                                    type: 'tool_result',
                                    tool_use_id: 'sidechain-tool-1',
                                    content: 'Sidechain tool success',
                                    is_error: false
                                }]
                            },
                            toolUseResult: 'Sidechain tool success'
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result4 = reducer(state, sidechainResultMessages, agentState);
            // Sidechain result shouldn't create new main messages
            expect(result4).toHaveLength(0);
            
            // Verify sidechain tool was updated
            const updatedSidechain = state.sidechains.get('main-msg-1');
            expect(updatedSidechain).toBeDefined();
            const sidechainTool = updatedSidechain?.find(m => m.tool?.name === 'SidechainTool');
            expect(sidechainTool?.tool?.state).toBe('completed');
            expect(sidechainTool?.tool?.result).toBe('Sidechain tool success');
            
            // Verify main Task tool is unaffected by sidechain updates
            const mainTool = state.messages.get(result1[0].id);
            expect(mainTool?.tool?.name).toBe('Task');
            expect(mainTool?.tool?.state).toBe('completed');
            expect(mainTool?.tool?.result).toBe('Task completed successfully');
        });

        it('should handle interleaved messages from multiple sources correctly', () => {
            const state = createReducer();
            
            // Mix of user messages, permissions, and tool calls
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'echo "hello"' },
                        createdAt: 1500
                    }
                },
                completedRequests: {
                    'perm-2': {
                        tool: 'Read',
                        arguments: { file: 'test.txt' },
                        createdAt: 500,
                        completedAt: 1000,
                        status: 'approved'
                    }
                }
            };
            
            const messages: NormalizedMessage[] = [
                // User message
                normalizeRawMessage('user-1', 'local-1', 1000, {
                    role: 'user',
                    content: { type: 'text', text: 'Do something' }
                }),
                // Agent text
                normalizeRawMessage('agent-1', null, 2000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'agent-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'text',
                                    text: 'I will help you'
                                }]
                            }
                        }
                    }
                }),
                // Tool call
                normalizeRawMessage('tool-1', null, 3000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'tool-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-new',
                                    name: 'Write',
                                    input: { file: 'output.txt', content: 'data' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result = reducer(state, messages, agentState);
            
            // Should create: 1 user, 1 agent text, 1 tool from permission request,
            // 1 tool from completed permission, 1 new tool call
            expect(result).toHaveLength(5);
            
            const types = result.map(m => m.kind).sort();
            expect(types).toEqual(['agent-text', 'tool-call', 'tool-call', 'tool-call', 'user-text']);
            
            // Verify each has correct properties
            const userMsg = result.find(m => m.kind === 'user-text');
            expect(userMsg?.createdAt).toBe(1000);
            
            const pendingPerm = result.find(m => 
                m.kind === 'tool-call' && m.tool.permission?.status === 'pending'
            );
            expect(pendingPerm).toBeDefined();
            
            const approvedPerm = result.find(m => 
                m.kind === 'tool-call' && m.tool.permission?.status === 'approved'
            );
            expect(approvedPerm).toBeDefined();
        });

        it('should not allow multiple tool results for the same tool ID', () => {
            const state = createReducer();
            
            // Create a tool call
            const toolMessages: NormalizedMessage[] = [
                normalizeRawMessage('msg-1', null, 1000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'tool-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-1',
                                    name: 'Test',
                                    input: {}
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            reducer(state, toolMessages);
            
            // First result
            const result1Messages: NormalizedMessage[] = [
                normalizeRawMessage('msg-2', null, 2000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'result-uuid-1',
                            message: {
                                role: 'user',
                                content: [{
                                    type: 'tool_result',
                                    tool_use_id: 'tool-1',
                                    content: 'First result',
                                    is_error: false
                                }]
                            },
                            toolUseResult: 'First result'
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result1 = reducer(state, result1Messages);
            expect(result1).toHaveLength(1);
            if (result1[0].kind === 'tool-call') {
                expect(result1[0].tool.state).toBe('completed');
                expect(result1[0].tool.result).toBe('First result');
            }
            
            // Second result (should be ignored)
            const result2Messages: NormalizedMessage[] = [
                normalizeRawMessage('msg-3', null, 3000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'result-uuid-2',
                            message: {
                                role: 'user',
                                content: [{
                                    type: 'tool_result',
                                    tool_use_id: 'tool-1',
                                    content: 'Should not override',
                                    is_error: true
                                }]
                            },
                            toolUseResult: 'Should not override'
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result2 = reducer(state, result2Messages);
            expect(result2).toHaveLength(0); // No changes
            
            // Verify original result is preserved
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            const toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.state).toBe('completed');
            expect(toolMsg?.tool?.result).toBe('First result');
        });

        it('should handle permission updates after tool execution started', () => {
            const state = createReducer();
            
            // Create approved permission
            const agentState1: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };
            
            reducer(state, [], agentState1);
            
            // Tool call arrives and matches
            const toolMessages: NormalizedMessage[] = [
                normalizeRawMessage('msg-1', null, 3000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'tool-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-1',
                                    name: 'Bash',
                                    input: { command: 'ls' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            reducer(state, toolMessages, agentState1);
            
            // Try to change permission status (should not affect running tool)
            const agentState2: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 1000,
                        completedAt: 4000,
                        status: 'denied',
                        reason: 'Changed mind'
                    }
                }
            };
            
            const result = reducer(state, [], agentState2);
            expect(result).toHaveLength(0); // No changes, tool already started
            
            // Verify tool is still running
            const permMsgId = state.permissionIdToMessageId.get('perm-1');
            const permMsg = state.messages.get(permMsgId!);
            expect(permMsg?.tool?.state).toBe('running');
            expect(permMsg?.tool?.permission?.status).toBe('approved'); // Status unchanged
        });

        it('should handle empty or null AgentState gracefully', () => {
            const state = createReducer();
            
            // Test with null
            const result1 = reducer(state, [], null);
            expect(result1).toHaveLength(0);
            
            // Test with undefined
            const result2 = reducer(state, [], undefined);
            expect(result2).toHaveLength(0);
            
            // Test with empty AgentState
            const emptyState: AgentState = {};
            const result3 = reducer(state, [], emptyState);
            expect(result3).toHaveLength(0);
            
            // Test with null requests/completedRequests
            const partialState: AgentState = {
                requests: null,
                completedRequests: null
            };
            const result4 = reducer(state, [], partialState);
            expect(result4).toHaveLength(0);
        });

        it('should handle completed permissions and tool calls with same name but different arguments', () => {
            const state = createReducer();
            
            // AgentState has completed permission for Bash with 'ls' command
            const agentState: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls' },
                        createdAt: 1000,
                        completedAt: 1500,
                        status: 'approved'
                    }
                }
            };
            
            // Incoming messages have tool call for Bash with 'pwd' command
            const messages: NormalizedMessage[] = [
                normalizeRawMessage('msg-1', null, 2000, {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'tool-uuid-1',
                            message: {
                                role: 'assistant',
                                model: 'claude-3',
                                content: [{
                                    type: 'tool_use',
                                    id: 'tool-1',
                                    name: 'Bash',
                                    input: { command: 'pwd' }
                                }]
                            }
                        }
                    }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const result = reducer(state, messages, agentState);
            
            // Should create TWO separate tool messages:
            // 1. One for the approved permission (Bash with 'ls')
            // 2. One for the incoming tool call (Bash with 'pwd')
            expect(result).toHaveLength(2);
            
            const bashLs = result.find(m => 
                m.kind === 'tool-call' && 
                m.tool.name === 'Bash' && 
                JSON.stringify(m.tool.input) === JSON.stringify({ command: 'ls' })
            );
            const bashPwd = result.find(m => 
                m.kind === 'tool-call' && 
                m.tool.name === 'Bash' && 
                JSON.stringify(m.tool.input) === JSON.stringify({ command: 'pwd' })
            );
            
            expect(bashLs).toBeDefined();
            expect(bashPwd).toBeDefined();
            
            // The permission one should have permission info
            if (bashLs?.kind === 'tool-call') {
                expect(bashLs.tool.permission?.status).toBe('approved');
                expect(bashLs.tool.permission?.id).toBe('perm-1');
            }
            
            // The tool call one should not have permission info
            if (bashPwd?.kind === 'tool-call') {
                expect(bashPwd.tool.permission).toBeUndefined();
            }
        });

        it('should maintain correct state across many operations', () => {
            const state = createReducer();
            let totalMessages = 0;
            
            // Simulate a long conversation with many operations
            for (let i = 0; i < 10; i++) {
                // Add user message
                const userMsg: NormalizedMessage[] = [
                    normalizeRawMessage(`user-${i}`, `local-${i}`, i * 1000, {
                        role: 'user',
                        content: { type: 'text', text: `Message ${i}` }
                    })
                ].filter(Boolean) as NormalizedMessage[];
                
                const userResult = reducer(state, userMsg);
                expect(userResult).toHaveLength(1);
                totalMessages++;
                
                // Add permission
                const agentState: AgentState = {
                    requests: {
                        [`perm-${i}`]: {
                            tool: 'Test',
                            arguments: { index: i },
                            createdAt: i * 1000 + 100
                        }
                    }
                };
                
                const permResult = reducer(state, [], agentState);
                expect(permResult).toHaveLength(1);
                totalMessages++;
                
                // Approve permission
                const approvedState: AgentState = {
                    completedRequests: {
                        [`perm-${i}`]: {
                            tool: 'Test',
                            arguments: { index: i },
                            createdAt: i * 1000 + 100,
                            completedAt: i * 1000 + 200,
                            status: 'approved'
                        }
                    }
                };
                
                reducer(state, [], approvedState);
            }
            
            // Verify state integrity
            expect(state.messages.size).toBe(totalMessages);
            expect(state.permissionIdToMessageId.size).toBe(10);
            expect(state.localIds.size).toBe(10);
            
            // Try to add duplicates (should not increase count)
            const duplicateUser: NormalizedMessage[] = [
                normalizeRawMessage('user-0', 'local-0', 0, {
                    role: 'user',
                    content: { type: 'text', text: 'Duplicate' }
                })
            ].filter(Boolean) as NormalizedMessage[];
            
            const dupResult = reducer(state, duplicateUser);
            expect(dupResult).toHaveLength(0);
            expect(state.messages.size).toBe(totalMessages); // No increase
        });

        it('should NOT create duplicate messages for pending permission requests', () => {
            const state = createReducer();
            
            // AgentState with a pending permission request
            const agentState: AgentState = {
                requests: {
                    'perm-pending-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                }
            };
            
            // Process the pending permission - should create exactly ONE message
            const result1 = reducer(state, [], agentState);
            expect(result1).toHaveLength(1);
            expect(result1[0].kind).toBe('tool-call');
            
            // Verify only one message exists
            const pendingMessageId = state.permissionIdToMessageId.get('perm-pending-1');
            expect(pendingMessageId).toBeDefined();
            expect(state.messages.size).toBe(1);
            
            // Process again with same state - should not create duplicate
            const result2 = reducer(state, [], agentState);
            expect(result2).toHaveLength(0); // No new messages
            expect(state.messages.size).toBe(1); // Still only one message
            
            // Verify the message has correct permission status
            const message = state.messages.get(pendingMessageId!);
            expect(message?.tool?.permission?.status).toBe('pending');
            expect(message?.tool?.permission?.id).toBe('perm-pending-1');
        });

        it('should match permissions when tool messages are loaded BEFORE AgentState', () => {
            const state = createReducer();
            
            // First, process the tool call message (as if loaded from storage)
            const toolMessage = normalizeRawMessage('msg-1', null, 1000, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'tool-uuid-1',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool_use',
                                id: 'tool-1',
                                name: 'Bash',
                                input: { command: 'ls -la' }
                            }]
                        }
                    }
                }
            });
            
            const messages = [toolMessage].filter(Boolean) as NormalizedMessage[];
            const result1 = reducer(state, messages);
            
            // Should create the tool message
            expect(result1).toHaveLength(1);
            expect(state.messages.size).toBe(1);
            
            // Now process the AgentState with pending permission
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 900  // Permission requested before the tool call
                    }
                }
            };
            
            const result2 = reducer(state, [], agentState);
            
            // Should NOT create a new message, but update the existing one
            expect(result2).toHaveLength(1); // The updated message
            expect(state.messages.size).toBe(1); // Still only one message
            
            // The existing tool message should now have the permission attached
            const messageId = state.toolIdToMessageId.get('tool-1');
            expect(messageId).toBeDefined();
            
            const message = state.messages.get(messageId!);
            expect(message?.tool?.name).toBe('Bash');
            expect(message?.tool?.permission?.status).toBe('pending');
            expect(message?.tool?.permission?.id).toBe('perm-1');
        });

        it('should match permissions when tool messages are loaded AFTER AgentState', () => {
            const state = createReducer();
            
            // First, process the AgentState with pending permission
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 900
                    }
                }
            };
            
            const result1 = reducer(state, [], agentState);
            
            // Should create a permission message
            expect(result1).toHaveLength(1);
            expect(state.messages.size).toBe(1);
            
            // Now process the tool call message
            const toolMessage = normalizeRawMessage('msg-1', null, 1000, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'tool-uuid-1',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool_use',
                                id: 'tool-1',
                                name: 'Bash',
                                input: { command: 'ls -la' }
                            }]
                        }
                    }
                }
            });
            
            const messages = [toolMessage].filter(Boolean) as NormalizedMessage[];
            const result2 = reducer(state, messages, agentState);
            
            // Should NOT create a new message, but update the existing permission message
            expect(result2).toHaveLength(1); // The updated message
            expect(state.messages.size).toBe(1); // Still only one message
            
            // The permission message should now be linked to the tool
            const messageId = state.toolIdToMessageId.get('tool-1');
            expect(messageId).toBeDefined();
            
            const message = state.messages.get(messageId!);
            expect(message?.tool?.name).toBe('Bash');
            expect(message?.tool?.permission?.status).toBe('pending');
            expect(message?.tool?.permission?.id).toBe('perm-1');
            expect(message?.tool?.startedAt).toBe(1000); // From the tool message
        });

        it('should not downgrade approved permission to pending when AgentState has both', () => {
            const state = createReducer();
            
            // AgentState with both pending and completed for same permission
            // This can happen when server sends stale data
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash', 
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };
            
            // Process tool message
            const toolMessage = normalizeRawMessage('msg-1', null, 1500, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'tool-uuid-1',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool_use',
                                id: 'tool-1',
                                name: 'Bash',
                                input: { command: 'ls -la' }
                            }]
                        }
                    }
                }
            });
            
            const messages = [toolMessage].filter(Boolean) as NormalizedMessage[];
            const result = reducer(state, messages, agentState);
            
            // Should create one message
            expect(result).toHaveLength(1);
            
            // Permission should be approved, NOT pending
            const messageId = state.toolIdToMessageId.get('tool-1');
            expect(messageId).toBeDefined();
            const message = state.messages.get(messageId!);
            expect(message).toBeDefined();
            expect(message?.tool).toBeDefined();
            expect(message?.tool?.permission).toBeDefined();
            expect(message?.tool?.permission?.status).toBe('approved'); // Not 'pending'!
        });

        it('should update permission status when AgentState changes from pending to approved', () => {
            const state = createReducer();
            
            // First, create a tool message with pending permission
            const agentState1: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                }
            };
            
            const toolMessage = normalizeRawMessage('msg-1', null, 1500, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'tool-uuid-1',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool_use',
                                id: 'tool-1',
                                name: 'Bash',
                                input: { command: 'ls -la' }
                            }]
                        }
                    }
                }
            });
            
            // Process with pending permission
            const messages = [toolMessage].filter(Boolean) as NormalizedMessage[];
            const result1 = reducer(state, messages, agentState1);
            
            // Should create one message with pending permission
            expect(result1).toHaveLength(1);
            expect(state.messages.size).toBe(1);
            
            const messageId = state.toolIdToMessageId.get('tool-1');
            expect(messageId).toBeDefined();
            
            let message = state.messages.get(messageId!);
            expect(message?.tool?.permission?.status).toBe('pending');
            
            // Now update AgentState to approved
            const agentState2: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };
            
            // Process only the new AgentState (simulating applySessions update)
            const result2 = reducer(state, [], agentState2);
            
            // Should return the updated message
            expect(result2).toHaveLength(1);
            expect(state.messages.size).toBe(1); // Still only one message
            
            // Check that the permission status was updated
            message = state.messages.get(messageId!);
            expect(message?.tool?.permission?.status).toBe('approved');
            expect(message?.tool?.permission?.id).toBe('perm-1');
        });

        it('should handle app loading flow: tool loaded first, then AgentState with approved permission', () => {
            const state = createReducer();
            
            // Step 1: Load tool message first (without AgentState) - simulates messages loaded before sessions
            const toolMessage = normalizeRawMessage('msg-1', null, 1500, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'tool-uuid-1',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool_use',
                                id: 'tool-1',
                                name: 'Bash',
                                input: { command: 'ls -la' }
                            }]
                        }
                    }
                }
            });
            
            const messages = [toolMessage].filter(Boolean) as NormalizedMessage[];
            const result1 = reducer(state, messages); // No AgentState
            
            // Tool should be created without permission
            expect(result1).toHaveLength(1);
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            expect(toolMsgId).toBeDefined();
            let toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission).toBeUndefined();
            expect(toolMsg?.tool?.state).toBe('running');
            
            // Step 2: AgentState arrives with both pending and approved (sessions loaded)
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };
            
            const result2 = reducer(state, [], agentState);
            
            // Should update the existing tool with approved permission
            expect(result2).toHaveLength(1); // Updated message
            expect(state.messages.size).toBe(1); // Still only one message
            
            toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission).toBeDefined();
            expect(toolMsg?.tool?.permission?.status).toBe('approved');
            expect(toolMsg?.tool?.permission?.id).toBe('perm-1');
            expect(toolMsg?.tool?.state).toBe('running'); // Should stay running for approved
        });

        it('should handle app loading flow: tool loaded first, then AgentState with denied permission', () => {
            const state = createReducer();
            
            // Step 1: Load tool message first
            const toolMessage = normalizeRawMessage('msg-1', null, 1500, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'tool-uuid-1',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool_use',
                                id: 'tool-1',
                                name: 'Bash',
                                input: { command: 'rm -rf /' }
                            }]
                        }
                    }
                }
            });
            
            const messages = [toolMessage].filter(Boolean) as NormalizedMessage[];
            reducer(state, messages);
            
            // Step 2: AgentState arrives with denied permission
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'rm -rf /' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'rm -rf /' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'denied',
                        reason: 'Dangerous command'
                    }
                }
            };
            
            const result2 = reducer(state, [], agentState);
            
            // Should update the existing tool with denied permission
            expect(result2).toHaveLength(1);
            
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            const toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('denied');
            expect(toolMsg?.tool?.permission?.reason).toBe('Dangerous command');
            expect(toolMsg?.tool?.state).toBe('error'); // Should change to error
            expect(toolMsg?.tool?.completedAt).toBeDefined();
            expect(toolMsg?.tool?.result).toEqual({ error: 'Dangerous command' });
        });

        it('should handle app loading flow: tool loaded first, then AgentState with canceled permission', () => {
            const state = createReducer();
            
            // Step 1: Load tool message first
            const toolMessage = normalizeRawMessage('msg-1', null, 1500, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'tool-uuid-1',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool_use',
                                id: 'tool-1',
                                name: 'Bash',
                                input: { command: 'sleep 3600' }
                            }]
                        }
                    }
                }
            });
            
            const messages = [toolMessage].filter(Boolean) as NormalizedMessage[];
            reducer(state, messages);
            
            // Step 2: AgentState arrives with canceled permission
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 3600' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'sleep 3600' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'canceled',
                        reason: 'User canceled'
                    }
                }
            };
            
            const result2 = reducer(state, [], agentState);
            
            // Should update the existing tool with canceled permission
            expect(result2).toHaveLength(1);
            
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            const toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('canceled');
            expect(toolMsg?.tool?.permission?.reason).toBe('User canceled');
            expect(toolMsg?.tool?.state).toBe('error'); // Should change to error
            expect(toolMsg?.tool?.completedAt).toBeDefined();
            expect(toolMsg?.tool?.result).toEqual({ error: 'User canceled' });
        });

        it('should handle permission state transitions correctly', () => {
            const state = createReducer();
            
            // Start with pending permission
            const agentState1: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'echo test' },
                        createdAt: 1000
                    }
                }
            };
            
            const result1 = reducer(state, [], agentState1);
            expect(result1).toHaveLength(1);
            
            const permMsgId = state.permissionIdToMessageId.get('perm-1');
            let msg = state.messages.get(permMsgId!);
            expect(msg?.tool?.permission?.status).toBe('pending');
            expect(msg?.tool?.state).toBe('running');
            
            // Transition to approved
            const agentState2: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'echo test' },
                        createdAt: 1000,
                        completedAt: 2000,
                        status: 'approved'
                    }
                }
            };
            
            const result2 = reducer(state, [], agentState2);
            expect(result2).toHaveLength(1);
            
            msg = state.messages.get(permMsgId!);
            expect(msg?.tool?.permission?.status).toBe('approved');
            expect(msg?.tool?.state).toBe('running'); // Should stay running
            expect(msg?.tool?.completedAt).toBeNull(); // Not completed yet
            
            // Now simulate a different scenario: transition from pending to denied
            const state2 = createReducer();
            const agentState3: AgentState = {
                requests: {
                    'perm-2': {
                        tool: 'Bash',
                        arguments: { command: 'echo denied' },
                        createdAt: 3000
                    }
                }
            };
            
            reducer(state2, [], agentState3);
            
            const agentState4: AgentState = {
                completedRequests: {
                    'perm-2': {
                        tool: 'Bash',
                        arguments: { command: 'echo denied' },
                        createdAt: 3000,
                        completedAt: 4000,
                        status: 'denied',
                        reason: 'Not allowed'
                    }
                }
            };
            
            const result4 = reducer(state2, [], agentState4);
            expect(result4).toHaveLength(1);
            
            const permMsgId2 = state2.permissionIdToMessageId.get('perm-2');
            const msg2 = state2.messages.get(permMsgId2!);
            expect(msg2?.tool?.permission?.status).toBe('denied');
            expect(msg2?.tool?.state).toBe('error'); // Should change to error
            expect(msg2?.tool?.completedAt).toBe(4000);
            expect(msg2?.tool?.result).toEqual({ error: 'Not allowed' });
        });

        it('should handle finished tool: completed successfully, then AgentState with approved permission', () => {
            const state = createReducer();
            
            // Step 1: Load tool message that's already completed
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'echo success' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }]
            };
            
            // Tool result message
            const resultMessage: NormalizedMessage = {
                id: 'msg-2',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: 'success\n',
                    is_error: false,
                    uuid: 'tool-uuid-2',
                    parentUUID: null
                }]
            };
            
            const messages = [toolMessage, resultMessage];
            reducer(state, messages);
            
            // Verify tool is completed
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            let toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.state).toBe('completed');
            expect(toolMsg?.tool?.result).toBe('success\n');
            expect(toolMsg?.tool?.permission).toBeUndefined();
            
            // Step 2: AgentState arrives with approved permission
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'echo success' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'echo success' },
                        createdAt: 1000,
                        completedAt: 1400,
                        status: 'approved'
                    }
                }
            };
            
            const result = reducer(state, [], agentState);
            
            // Permission should be attached but tool should remain completed
            expect(result).toHaveLength(1);
            toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('approved');
            expect(toolMsg?.tool?.state).toBe('completed'); // Should stay completed
            expect(toolMsg?.tool?.result).toBe('success\n'); // Result unchanged
        });

        it('should handle finished tool: completed successfully, then AgentState with denied permission', () => {
            const state = createReducer();
            
            // Step 1: Load completed tool
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'rm important.txt' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }]
            };
            
            const resultMessage: NormalizedMessage = {
                id: 'msg-2',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: 'file removed',
                    is_error: false,
                    uuid: 'tool-uuid-2',
                    parentUUID: null
                }]
            };
            
            reducer(state, [toolMessage, resultMessage]);
            
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            let toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.state).toBe('completed');
            
            // Step 2: AgentState with denied permission (too late!)
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'rm important.txt' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'rm important.txt' },
                        createdAt: 1000,
                        completedAt: 1400,
                        status: 'denied',
                        reason: 'Dangerous operation'
                    }
                }
            };
            
            reducer(state, [], agentState);
            
            // Tool should NOT change to error (already executed)
            toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('denied');
            expect(toolMsg?.tool?.permission?.reason).toBe('Dangerous operation');
            expect(toolMsg?.tool?.state).toBe('completed'); // Should stay completed, not error
            expect(toolMsg?.tool?.result).toBe('file removed'); // Result unchanged
        });

        it('should handle finished tool: errored, then AgentState with approved permission', () => {
            const state = createReducer();
            
            // Step 1: Load tool that errored
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'cat /nonexistent' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }]
            };
            
            const errorMessage: NormalizedMessage = {
                id: 'msg-2',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: 'File not found',
                    is_error: true,
                    uuid: 'tool-uuid-2',
                    parentUUID: null
                }]
            };
            
            reducer(state, [toolMessage, errorMessage]);
            
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            let toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.state).toBe('error');
            expect(toolMsg?.tool?.result).toBe('File not found');
            
            // Step 2: AgentState with approved permission (too late to help)
            const agentState: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'cat /nonexistent' },
                        createdAt: 1000,
                        completedAt: 1400,
                        status: 'approved'
                    }
                }
            };
            
            reducer(state, [], agentState);
            
            // Permission attached but error state maintained
            toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('approved');
            expect(toolMsg?.tool?.state).toBe('error'); // Should stay error
            expect(toolMsg?.tool?.result).toBe('File not found'); // Error unchanged
        });

        it('should handle finished tool: errored, then AgentState with denied permission', () => {
            const state = createReducer();
            
            // Step 1: Load tool that errored
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'sudo rm -rf /' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }]
            };
            
            const errorMessage: NormalizedMessage = {
                id: 'msg-2',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: 'Permission denied',
                    is_error: true,
                    uuid: 'tool-uuid-2',
                    parentUUID: null
                }]
            };
            
            reducer(state, [toolMessage, errorMessage]);
            
            // Step 2: AgentState with denied permission
            const agentState: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'sudo rm -rf /' },
                        createdAt: 1000,
                        completedAt: 1400,
                        status: 'denied',
                        reason: 'Extremely dangerous'
                    }
                }
            };
            
            reducer(state, [], agentState);
            
            // Both permission and error should be present
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            const toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('denied');
            expect(toolMsg?.tool?.permission?.reason).toBe('Extremely dangerous');
            expect(toolMsg?.tool?.state).toBe('error');
            expect(toolMsg?.tool?.result).toBe('Permission denied'); // Original error
        });

        it('should handle finished tool: with multiple messages in sequence', () => {
            const state = createReducer();
            
            // Step 1: Tool call
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'ls -la' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }]
            };
            
            reducer(state, [toolMessage]);
            
            // Step 2: Tool result arrives
            const resultMessage: NormalizedMessage = {
                id: 'msg-2',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'tool-1',
                    content: 'file1.txt\nfile2.txt',
                    is_error: false,
                    uuid: 'tool-uuid-2',
                    parentUUID: null
                }]
            };
            
            reducer(state, [resultMessage]);
            
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            let toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.state).toBe('completed');
            expect(toolMsg?.tool?.result).toBe('file1.txt\nfile2.txt');
            
            // Step 3: AgentState arrives later with permission info
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000
                    }
                },
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1000,
                        completedAt: 1400,
                        status: 'approved'
                    }
                }
            };
            
            const result = reducer(state, [], agentState);
            
            // Permission should be attached to completed tool
            expect(result).toHaveLength(1);
            toolMsg = state.messages.get(toolMsgId!);
            expect(toolMsg?.tool?.permission?.status).toBe('approved');
            expect(toolMsg?.tool?.state).toBe('completed');
            expect(toolMsg?.tool?.result).toBe('file1.txt\nfile2.txt');
        });

        it('should handle real-world scenario: messages and AgentState received simultaneously', () => {
            const state = createReducer();
            
            // Simulate a tool call message from the agent
            const toolMessage = normalizeRawMessage('msg-1', null, 1000, {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'tool-uuid-1',
                        message: {
                            role: 'assistant',
                            model: 'claude-3',
                            content: [{
                                type: 'tool_use',
                                id: 'tool-1',
                                name: 'Bash',
                                input: { command: 'ls -la' }
                            }]
                        }
                    }
                }
            });
            
            // AgentState with the pending permission for the same tool
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 900  // Permission requested before the tool call
                    }
                }
            };
            
            // Process both simultaneously (as would happen when loading from storage)
            const messages = [toolMessage].filter(Boolean) as NormalizedMessage[];
            const result = reducer(state, messages, agentState);
            
            // Should create exactly ONE message, not two
            expect(result).toHaveLength(1);
            expect(state.messages.size).toBe(1);
            
            // The message should be the tool call with the permission attached
            const messageId = state.toolIdToMessageId.get('tool-1');
            expect(messageId).toBeDefined();
            
            const message = state.messages.get(messageId!);
            expect(message?.tool?.name).toBe('Bash');
            expect(message?.tool?.permission?.status).toBe('pending');
            expect(message?.tool?.permission?.id).toBe('perm-1');
        });

        it('should retroactively match permissions when tools are processed without AgentState initially', () => {
            const state = createReducer();
            
            // Step 1: Process tool messages WITHOUT AgentState (simulating messages loading before session)
            const toolMessage: NormalizedMessage = {
                id: 'msg-1',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'echo hello' },
                    description: null,
                    uuid: 'tool-uuid-1',
                    parentUUID: null
                }]
            };
            
            // Process WITHOUT AgentState (undefined)
            const result1 = reducer(state, [toolMessage], undefined);
            
            // Should create a tool message WITHOUT permission
            expect(result1).toHaveLength(1);
            expect(result1[0].kind).toBe('tool-call');
            if (result1[0].kind === 'tool-call') {
                expect(result1[0].tool.permission).toBeUndefined();
                expect(result1[0].tool.state).toBe('running');
            }
            
            // Verify tool is registered in state
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            
            // Step 2: Later, AgentState arrives with permission for this tool
            const agentState: AgentState = {
                requests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'echo hello' },
                        createdAt: 1000  // Permission was requested BEFORE the tool ran
                    }
                }
            };
            
            // Process with AgentState but no new messages
            const result2 = reducer(state, [], agentState);
            
            // The reducer SHOULD match the permission to the existing tool
            expect(result2).toHaveLength(1);
            expect(result2[0].kind).toBe('tool-call');
            if (result2[0].kind === 'tool-call') {
                // The existing tool should now have the permission attached
                expect(result2[0].tool.permission?.status).toBe('pending');
                expect(result2[0].tool.permission?.id).toBe('perm-1');
            }
            
            // Should still only have ONE message - the tool was updated
            expect(state.messages.size).toBe(1);
            
            // The original tool message should now have permission
            const originalTool = state.messages.get(toolMsgId!);
            expect(originalTool?.tool?.permission).toBeDefined();
            expect(originalTool?.tool?.permission?.status).toBe('pending');
            
            // The permission should be linked to the existing tool
            const permMsgId = state.permissionIdToMessageId.get('perm-1');
            expect(permMsgId).toBeDefined();
            expect(permMsgId).toBe(toolMsgId); // Same message ID
        });

        it('should handle the full race condition scenario: messages load, then session with AgentState, then new message', () => {
            const state = createReducer();
            
            // Step 1: Messages load WITHOUT AgentState (session hasn't arrived yet)
            const existingMessages: NormalizedMessage[] = [
                // User message
                {
                    id: 'user-1',
                    localId: 'local-1',
                    createdAt: 1000,
                    role: 'user',
                    isSidechain: false,
                    content: {
                        type: 'text',
                        text: 'Please list files'
                    }
                },
                // Tool call that should have permission
                {
                    id: 'tool-msg-1',
                    localId: null,
                    createdAt: 2000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: 'tool-1',
                        name: 'Bash',
                        input: { command: 'ls -la' },
                        description: 'List files',
                        uuid: 'tool-uuid-1',
                        parentUUID: null
                    }]
                },
                // Tool result
                {
                    id: 'result-1',
                    localId: null,
                    createdAt: 3000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: 'tool-1',
                        content: 'file1.txt\nfile2.txt',
                        is_error: false,
                        uuid: 'result-uuid-1',
                        parentUUID: null
                    }]
                }
            ];
            
            // Process messages WITHOUT AgentState
            const result1 = reducer(state, existingMessages, undefined);
            
            // Should create user message and tool message
            expect(result1.length).toBeGreaterThanOrEqual(2);
            
            // Find the tool message
            const toolMsg = result1.find(m => m.kind === 'tool-call');
            expect(toolMsg).toBeDefined();
            if (toolMsg?.kind === 'tool-call') {
                expect(toolMsg.tool.permission).toBeUndefined(); // No permission yet
                expect(toolMsg.tool.state).toBe('completed'); // Tool completed
                expect(toolMsg.tool.result).toBe('file1.txt\nfile2.txt');
            }
            
            // Step 2: Session arrives with AgentState containing permission info
            const agentState: AgentState = {
                completedRequests: {
                    'perm-1': {
                        tool: 'Bash',
                        arguments: { command: 'ls -la' },
                        createdAt: 1500,
                        completedAt: 1800,
                        status: 'approved'
                    }
                }
            };
            
            // Process AgentState (simulating session arrival)
            const result2 = reducer(state, [], agentState);
            
            // Should update the existing tool with permission info
            expect(result2).toHaveLength(1);
            if (result2[0].kind === 'tool-call') {
                expect(result2[0].tool.permission?.status).toBe('approved');
                // The tool should still be completed
                expect(result2[0].tool.state).toBe('completed');
            }
            
            // Step 3: User sends a new message, triggering a new reducer call
            const newUserMessage: NormalizedMessage = {
                id: 'user-2',
                localId: 'local-2',
                createdAt: 4000,
                role: 'user',
                isSidechain: false,
                content: {
                    type: 'text',
                    text: 'Thanks!'
                }
            };
            
            // Process new message WITH AgentState (as would happen in real app)
            const result3 = reducer(state, [newUserMessage], agentState);
            
            // Should only create the new user message
            expect(result3).toHaveLength(1);
            expect(result3[0].kind).toBe('user-text');
            
            // The tool and permission should be the SAME message (matched correctly)
            expect(state.toolIdToMessageId.has('tool-1')).toBe(true);
            expect(state.permissionIdToMessageId.has('perm-1')).toBe(true);
            
            const toolMsgId = state.toolIdToMessageId.get('tool-1');
            const permMsgId = state.permissionIdToMessageId.get('perm-1');
            expect(toolMsgId).toBe(permMsgId); // Same message - properly matched!
        });
    });
});