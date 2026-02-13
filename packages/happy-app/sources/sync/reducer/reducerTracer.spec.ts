import { describe, it, expect } from 'vitest';
import { createTracer, traceMessages } from './reducerTracer';
import { NormalizedMessage } from '../typesRaw';

describe('reducerTracer', () => {
    describe('createTracer', () => {
        it('should create initial state', () => {
            const state = createTracer();
            expect(state.taskTools.size).toBe(0);
            expect(state.promptToTaskId.size).toBe(0);
            expect(state.uuidToSidechainId.size).toBe(0);
            expect(state.toolCallToMessageId.size).toBe(0);
            expect(state.orphanMessages.size).toBe(0);
            expect(state.processedIds.size).toBe(0);
        });
    });

    describe('traceMessages', () => {
        it('should return non-sidechain messages immediately', () => {
            const state = createTracer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'msg1',
                    localId: null,
                    createdAt: 1000,
                    role: 'user',
                    isSidechain: false,
                    content: { type: 'text', text: 'Hello' }
                },
                {
                    id: 'msg2',
                    localId: null,
                    createdAt: 2000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{ type: 'text', text: 'Hi there', uuid: 'uuid1', parentUUID: null }]
                }
            ];

            const traced = traceMessages(state, messages);
            
            expect(traced).toHaveLength(2);
            expect(traced[0].sidechainId).toBeUndefined();
            expect(traced[1].sidechainId).toBeUndefined();
            expect(state.processedIds.size).toBe(2);
        });

        it('should identify and track Task tools', () => {
            const state = createTracer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'msg1',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: 'tool1',
                        name: 'Task',
                        input: { prompt: 'Search for files' },
                        description: null,
                        uuid: 'uuid1',
                        parentUUID: null
                    }]
                }
            ];

            traceMessages(state, messages);
            
            expect(state.taskTools.size).toBe(1);
            expect(state.taskTools.get('msg1')).toEqual({
                messageId: 'msg1',
                prompt: 'Search for files'
            });
            expect(state.promptToTaskId.get('Search for files')).toBe('msg1');
        });

        it('should assign sidechainId to sidechain root messages', () => {
            const state = createTracer();
            
            // First, process a Task tool
            const taskMessage: NormalizedMessage = {
                id: 'task1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool1',
                    name: 'Task',
                    input: { prompt: 'Search for files' },
                    description: null,
                    uuid: 'task-uuid',
                    parentUUID: null
                }]
            };
            
            traceMessages(state, [taskMessage]);
            
            // Then process the sidechain root
            const sidechainRoot: NormalizedMessage = {
                id: 'sidechain1',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'sidechain',
                    uuid: 'sidechain-uuid',
                    prompt: 'Search for files'
                }]
            };
            
            const traced = traceMessages(state, [sidechainRoot]);
            
            expect(traced).toHaveLength(1);
            expect(traced[0].sidechainId).toBe('task1');
            expect(state.uuidToSidechainId.get('sidechain-uuid')).toBe('task1');
        });

        it('should handle sidechain messages with parent relationships', () => {
            const state = createTracer();
            
            // Setup: Task and sidechain root
            const setup: NormalizedMessage[] = [
                {
                    id: 'task1',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: 'tool1',
                        name: 'Task',
                        input: { prompt: 'Search for files' },
                        description: null,
                        uuid: 'task-uuid',
                        parentUUID: null
                    }]
                },
                {
                    id: 'sidechain1',
                    localId: null,
                    createdAt: 2000,
                    role: 'agent',
                    isSidechain: true,
                    content: [{
                        type: 'sidechain',
                        uuid: 'sidechain-uuid',
                        prompt: 'Search for files'
                    }]
                }
            ];
            
            traceMessages(state, setup);
            
            // Process child of sidechain
            const sidechainChild: NormalizedMessage = {
                id: 'child1',
                localId: null,
                createdAt: 3000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'Searching...',
                    uuid: 'child-uuid',
                    parentUUID: 'sidechain-uuid'
                }]
            };
            
            const traced = traceMessages(state, [sidechainChild]);
            
            expect(traced).toHaveLength(1);
            expect(traced[0].sidechainId).toBe('task1');
            expect(state.uuidToSidechainId.get('child-uuid')).toBe('task1');
        });

        it('should link invoke-based sidechain messages to parent tool call message', () => {
            const state = createTracer();

            const parentToolMessage: NormalizedMessage = {
                id: 'parent-msg',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-call-1',
                    name: 'Task',
                    input: { prompt: 'Inspect auth code' },
                    description: null,
                    uuid: 'parent-uuid',
                    parentUUID: null
                }]
            };

            traceMessages(state, [parentToolMessage]);

            const invokeMessage: NormalizedMessage = {
                id: 'child-msg',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'subagent output',
                    uuid: 'child-uuid',
                    parentUUID: 'tool-call-1'
                }]
            };

            const traced = traceMessages(state, [invokeMessage]);
            expect(traced).toHaveLength(1);
            expect(traced[0].sidechainId).toBe('parent-msg');
        });

        it('should buffer orphan messages until parent arrives', () => {
            const state = createTracer();
            
            // Setup: Task
            const task: NormalizedMessage = {
                id: 'task1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool1',
                    name: 'Task',
                    input: { prompt: 'Search for files' },
                    description: null,
                    uuid: 'task-uuid',
                    parentUUID: null
                }]
            };
            
            traceMessages(state, [task]);
            
            // Process orphan (parent not yet seen)
            const orphan: NormalizedMessage = {
                id: 'orphan1',
                localId: null,
                createdAt: 3000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'Orphan message',
                    uuid: 'orphan-uuid',
                    parentUUID: 'sidechain-uuid'
                }]
            };
            
            let traced = traceMessages(state, [orphan]);
            
            // Orphan should be buffered, not returned
            expect(traced).toHaveLength(0);
            expect(state.orphanMessages.has('sidechain-uuid')).toBe(true);
            
            // Process parent
            const parent: NormalizedMessage = {
                id: 'sidechain1',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'sidechain',
                    uuid: 'sidechain-uuid',
                    prompt: 'Search for files'
                }]
            };
            
            traced = traceMessages(state, [parent]);
            
            // Should return both parent and orphan
            expect(traced).toHaveLength(2);
            expect(traced[0].id).toBe('sidechain1');
            expect(traced[0].sidechainId).toBe('task1');
            expect(traced[1].id).toBe('orphan1');
            expect(traced[1].sidechainId).toBe('task1');
            
            // Orphan buffer should be cleared
            expect(state.orphanMessages.has('sidechain-uuid')).toBe(false);
        });

        it('should handle recursive orphan processing', () => {
            const state = createTracer();
            
            // Setup: Task
            const task: NormalizedMessage = {
                id: 'task1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool1',
                    name: 'Task',
                    input: { prompt: 'Search for files' },
                    description: null,
                    uuid: 'task-uuid',
                    parentUUID: null
                }]
            };
            
            traceMessages(state, [task]);
            
            // Process multiple orphans in reverse order
            const orphan2: NormalizedMessage = {
                id: 'orphan2',
                localId: null,
                createdAt: 4000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'Second orphan',
                    uuid: 'orphan2-uuid',
                    parentUUID: 'orphan1-uuid'
                }]
            };
            
            const orphan1: NormalizedMessage = {
                id: 'orphan1',
                localId: null,
                createdAt: 3000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'First orphan',
                    uuid: 'orphan1-uuid',
                    parentUUID: 'sidechain-uuid'
                }]
            };
            
            // Process orphans out of order
            traceMessages(state, [orphan2, orphan1]);
            
            // Both should be buffered
            expect(state.orphanMessages.has('orphan1-uuid')).toBe(true);
            expect(state.orphanMessages.has('sidechain-uuid')).toBe(true);
            
            // Process root
            const root: NormalizedMessage = {
                id: 'sidechain1',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'sidechain',
                    uuid: 'sidechain-uuid',
                    prompt: 'Search for files'
                }]
            };
            
            const traced = traceMessages(state, [root]);
            
            // Should return all three in correct order
            expect(traced).toHaveLength(3);
            expect(traced[0].id).toBe('sidechain1');
            expect(traced[1].id).toBe('orphan1');
            expect(traced[2].id).toBe('orphan2');
            
            // All should have the same sidechainId
            expect(traced[0].sidechainId).toBe('task1');
            expect(traced[1].sidechainId).toBe('task1');
            expect(traced[2].sidechainId).toBe('task1');
            
            // Orphan buffers should be cleared
            expect(state.orphanMessages.size).toBe(0);
        });

        it('should flush invoke-orphans when parent tool call arrives later', () => {
            const state = createTracer();

            const orphanInvoke: NormalizedMessage = {
                id: 'invoke-child',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'waiting for parent tool',
                    uuid: 'invoke-child-uuid',
                    parentUUID: 'tool-call-late'
                }]
            };

            const firstPass = traceMessages(state, [orphanInvoke]);
            expect(firstPass).toHaveLength(0);
            expect(state.orphanMessages.has('tool-call-late')).toBe(true);

            const parentToolMessage: NormalizedMessage = {
                id: 'late-parent-msg',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-call-late',
                    name: 'Task',
                    input: { prompt: 'Late parent' },
                    description: null,
                    uuid: 'late-parent-uuid',
                    parentUUID: null
                }]
            };

            const secondPass = traceMessages(state, [parentToolMessage]);
            expect(secondPass.length).toBeGreaterThanOrEqual(2);

            const flushedChild = secondPass.find(msg => msg.id === 'invoke-child');
            expect(flushedChild?.sidechainId).toBe('late-parent-msg');
            expect(state.orphanMessages.has('tool-call-late')).toBe(false);
        });

        it('should skip already processed messages', () => {
            const state = createTracer();
            const message: NormalizedMessage = {
                id: 'msg1',
                localId: null,
                createdAt: 1000,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: 'Hello' }
            };

            // Process once
            const traced1 = traceMessages(state, [message]);
            expect(traced1).toHaveLength(1);

            // Process again
            const traced2 = traceMessages(state, [message]);
            expect(traced2).toHaveLength(0);
        });
    });
});
