import { describe, it, expect } from 'vitest';
import { createReducer, reducer } from './reducer';
import { NormalizedMessage } from '../typesRaw';
import { AgentState } from '../storageTypes';

describe('Phase 0 permission skipping issue', () => {
    it('should handle permissions when AgentState and matching tools arrive together', () => {
        const state = createReducer();
        
        // Create tool messages that will arrive with AgentState (simulating opening a chat)
        const toolMessages: NormalizedMessage[] = [
            {
                id: 'msg1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool1',
                    name: 'WebFetch',
                    input: { url: 'https://example.com', prompt: 'test' },
                    description: 'Fetching webpage',
                    uuid: 'uuid1',
                    parentUUID: null
                }]
            },
            {
                id: 'msg2',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool2',
                    name: 'Write',
                    input: { file_path: '/test.txt', content: 'hello' },
                    description: 'Writing file',
                    uuid: 'uuid2',
                    parentUUID: null
                }]
            },
            {
                id: 'msg3',
                localId: null,
                createdAt: 3000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool3',
                    name: 'Read',
                    input: { file_path: '/test.txt' },
                    description: 'Reading file',
                    uuid: 'uuid3',
                    parentUUID: null
                }]
            }
        ];
        
        // Create AgentState with both pending and completed permissions
        const agentState: AgentState = {
            requests: {
                // Pending permission for WebFetch (tool1)
                'tool1': {
                    tool: 'WebFetch',
                    arguments: { url: 'https://example.com', prompt: 'test' },
                    createdAt: 900
                }
            },
            completedRequests: {
                // Completed (approved) permission for Write (tool2)
                'tool2': {
                    tool: 'Write',
                    arguments: { file_path: '/test.txt', content: 'hello' },
                    status: 'approved',
                    createdAt: 1900,
                    completedAt: 1950
                },
                // Completed (denied) permission for Read (tool3)
                'tool3': {
                    tool: 'Read',
                    arguments: { file_path: '/test.txt' },
                    status: 'denied',
                    reason: 'Access denied',
                    createdAt: 2900,
                    completedAt: 2950
                }
            }
        };
        
        // Process messages and AgentState together (simulates opening chat)
        const result = reducer(state, toolMessages, agentState);
        
        // Log what happened (for debugging)
        console.log('Result messages:', result.length);
        console.log('Permission mappings:', {
            toolIdToMessageId: Array.from(state.toolIdToMessageId.entries())
        });
        
        // Find the tool messages in the result
        const webFetchTool = result.find(m => m.kind === 'tool-call' && m.tool?.name === 'WebFetch');
        const writeTool = result.find(m => m.kind === 'tool-call' && m.tool?.name === 'Write');
        const readTool = result.find(m => m.kind === 'tool-call' && m.tool?.name === 'Read');
        
        // THESE ASSERTIONS WILL FAIL with current code because Phase 2 can't find skipped permissions
        
        // WebFetch should have pending permission
        expect(webFetchTool).toBeDefined();
        expect(webFetchTool?.kind).toBe('tool-call');
        if (webFetchTool?.kind === 'tool-call') {
            expect(webFetchTool.tool?.permission).toBeDefined();
            expect(webFetchTool.tool?.permission?.id).toBe('tool1');
            expect(webFetchTool.tool?.permission?.status).toBe('pending');
        }
        
        // Write should have approved permission
        expect(writeTool).toBeDefined();
        expect(writeTool?.kind).toBe('tool-call');
        if (writeTool?.kind === 'tool-call') {
            expect(writeTool.tool?.permission).toBeDefined();
            expect(writeTool.tool?.permission?.id).toBe('tool2');
            expect(writeTool.tool?.permission?.status).toBe('approved');
            expect(writeTool.tool?.state).toBe('running'); // Approved tools should be running
        }
        
        // Read should have denied permission
        expect(readTool).toBeDefined();
        expect(readTool?.kind).toBe('tool-call');
        if (readTool?.kind === 'tool-call') {
            expect(readTool.tool?.permission).toBeDefined();
            expect(readTool.tool?.permission?.id).toBe('tool3');
            expect(readTool.tool?.permission?.status).toBe('denied');
            expect(readTool.tool?.permission?.reason).toBe('Access denied');
            expect(readTool.tool?.state).toBe('error'); // Denied tools should be in error state
        }
        
        // Verify that permissions were properly linked (IDs now match)
        expect(state.toolIdToMessageId.has('tool1')).toBe(true);
        expect(state.toolIdToMessageId.has('tool2')).toBe(true);
        expect(state.toolIdToMessageId.has('tool3')).toBe(true);
        // All tool IDs should be in the map
        expect(state.toolIdToMessageId.has('tool1')).toBe(true);
        expect(state.toolIdToMessageId.has('tool2')).toBe(true);
        expect(state.toolIdToMessageId.has('tool3')).toBe(true);
    });
    
    it('should handle case where tools arrive first, then AgentState arrives later', () => {
        const state = createReducer();
        
        // Step 1: Process tools without AgentState
        const toolMessages: NormalizedMessage[] = [
            {
                id: 'msg1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool1',
                    name: 'Write',
                    input: { file_path: '/test.txt', content: 'hello' },
                    description: 'Writing file',
                    uuid: 'uuid4',
                    parentUUID: null
                }]
            }
        ];
        
        const result1 = reducer(state, toolMessages, undefined);
        
        // Tool should be created without permission
        const toolBeforePermission = result1.find(m => m.kind === 'tool-call');
        expect(toolBeforePermission?.kind).toBe('tool-call');
        if (toolBeforePermission?.kind === 'tool-call') {
            expect(toolBeforePermission.tool?.permission).toBeUndefined();
        }
        
        // Step 2: AgentState arrives later with permission
        const agentState: AgentState = {
            requests: {},
            completedRequests: {
                'tool1': {
                    tool: 'Write',
                    arguments: { file_path: '/test.txt', content: 'hello' },
                    status: 'approved',
                    createdAt: 900,
                    completedAt: 950
                }
            }
        };
        
        const result2 = reducer(state, [], agentState);
        
        // Permission should be matched to existing tool
        const toolAfterPermission = Array.from(state.messages.values())
            .find(m => m.tool?.name === 'Write');
        
        expect(toolAfterPermission).toBeDefined();
        expect(toolAfterPermission?.tool?.permission).toBeDefined();
        expect(toolAfterPermission?.tool?.permission?.id).toBe('tool1');
        expect(toolAfterPermission?.tool?.permission?.status).toBe('approved');
    });
});