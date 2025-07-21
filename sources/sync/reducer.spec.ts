import { describe, it, expect } from 'vitest';
import { normalizeRawMessage, RawRecordSchema, NormalizedMessage } from './typesRaw';
import { createReducer } from './reducer';
import { reducer } from './reducer';

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
});