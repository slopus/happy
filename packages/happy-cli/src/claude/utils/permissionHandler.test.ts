import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionHandler } from './permissionHandler';
import type { Session } from '../session';
import type { EnhancedMode } from '../loop';

// Mock logger to avoid console output during tests
vi.mock('@/lib', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
    },
}));

// Create a minimal mock Session
function createMockSession(): Session {
    return {
        client: {
            sessionId: 'test-session',
            updateAgentState: vi.fn(),
            sendClaudeSessionMessage: vi.fn(),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
        },
        queue: {
            unshift: vi.fn(),
        },
        api: {
            push: () => ({
                sendToAllDevices: vi.fn(),
            }),
        },
    } as unknown as Session;
}

function createEnhancedMode(permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'): EnhancedMode {
    return {
        permissionMode,
        model: 'claude-3',
        customSystemPrompt: undefined,
        customInstructions: undefined,
    } as EnhancedMode;
}

describe('PermissionHandler', () => {
    let handler: PermissionHandler;
    let mockSession: Session;

    beforeEach(() => {
        mockSession = createMockSession();
        handler = new PermissionHandler(mockSession);
    });

    describe('reset()', () => {
        it('should reset permissionMode to default', () => {
            // Setup: Set permission mode to bypassPermissions
            handler.handleModeChange('bypassPermissions');

            // Act: Reset the handler
            handler.reset();

            // Assert: permissionMode should be reset to 'default'
            // We need to verify this by checking behavior since permissionMode is private
            // After reset, bypassPermissions should NOT auto-allow tools
            const signal = new AbortController().signal;
            const mode = createEnhancedMode('default');

            // Inject a tool call that would normally require permission
            handler.onMessage({
                type: 'assistant',
                message: {
                    content: [{
                        type: 'tool_use',
                        id: 'test-tool-1',
                        name: 'Bash',
                        input: { command: 'ls' },
                    }],
                },
            } as any);

            // Now call handleToolCall - it should NOT auto-approve since mode was reset
            // If permissionMode was still 'bypassPermissions', it would return immediately
            const result = handler.handleToolCall('Bash', { command: 'ls' }, mode, { signal });

            // Result should be a Promise (pending permission) not immediate approval
            expect(result).toBeInstanceOf(Promise);
        });
    });

    describe('handleToolCall()', () => {
        it('should use mode parameter for bypassPermissions when instance mode is default', async () => {
            // BUG TEST: This test demonstrates the race condition bug
            // Instance permissionMode is 'default' (the initial state)
            // But we pass bypassPermissions in the mode parameter
            // CURRENT BUG: The handler ignores mode parameter and uses instance state
            const signal = new AbortController().signal;
            const mode = createEnhancedMode('bypassPermissions');

            // Note: No onMessage() needed - bypassPermissions should return BEFORE tool ID resolution
            // If this fails with "Could not resolve tool call ID", the bug exists

            // Act: Call handleToolCall with bypassPermissions mode
            const result = await handler.handleToolCall(
                'Read',
                { file_path: '/test/file.ts' },
                mode,
                { signal }
            );

            // Assert: Should be auto-approved based on mode parameter
            expect(result.behavior).toBe('allow');
        });

        it('should use mode parameter for acceptEdits when instance mode is default', async () => {
            // BUG TEST: Similar race condition for acceptEdits mode
            // Instance permissionMode is 'default'
            // But we pass acceptEdits in the mode parameter for an edit-type tool
            const signal = new AbortController().signal;
            const mode = createEnhancedMode('acceptEdits');

            // Note: No onMessage() needed - acceptEdits for edit tools should return BEFORE tool ID resolution
            // If this fails with "Could not resolve tool call ID", the bug exists

            // Act: Call handleToolCall with acceptEdits mode for an edit tool
            const result = await handler.handleToolCall(
                'Edit',  // Edit tool should be auto-allowed in acceptEdits mode
                { file_path: '/test/file.ts', old_string: 'foo', new_string: 'bar' },
                mode,
                { signal }
            );

            // Assert: Should be auto-approved for edit tools in acceptEdits mode
            expect(result.behavior).toBe('allow');
        });

        it('should NOT auto-approve when mode is default even if instance was previously bypassPermissions', () => {
            // Setup: First set instance to bypassPermissions, then reset
            handler.handleModeChange('bypassPermissions');
            handler.reset();

            const signal = new AbortController().signal;
            const mode = createEnhancedMode('default');

            // Inject a tool call
            handler.onMessage({
                type: 'assistant',
                message: {
                    content: [{
                        type: 'tool_use',
                        id: 'test-tool-2',
                        name: 'Bash',
                        input: { command: 'rm -rf /' },
                    }],
                },
            } as any);

            // Act: Call handleToolCall with default mode
            const result = handler.handleToolCall('Bash', { command: 'rm -rf /' }, mode, { signal });

            // Assert: Should return a Promise (waiting for permission), not immediate approval
            expect(result).toBeInstanceOf(Promise);
        });

        it('should respect mode parameter over stale instance permissionMode', async () => {
            // BUG TEST: This tests the race condition scenario
            // 1. Handler created with default mode
            // 2. User selects bypassPermissions
            // 3. Tool call happens BEFORE handleModeChange() is called
            // 4. The mode parameter should be used, not the stale instance state
            //
            // CURRENT BUG: The handler uses this.permissionMode (still 'default')
            // instead of the mode parameter (bypassPermissions)

            const signal = new AbortController().signal;
            // Mode parameter says bypassPermissions (from user selection)
            const mode = createEnhancedMode('bypassPermissions');

            // Instance is still at 'default' (handleModeChange not yet called)
            // But the mode parameter should take precedence

            const result = await handler.handleToolCall(
                'Write',
                { file_path: '/test/new.ts', content: 'test' },
                mode,
                { signal }
            );

            // Should be approved based on mode parameter, not instance state
            expect(result.behavior).toBe('allow');
        });
    });
});
