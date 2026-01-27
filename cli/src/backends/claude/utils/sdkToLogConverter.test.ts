/**
 * Tests for SDK to Log converter
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SDKToLogConverter, convertSDKToLog } from './sdkToLogConverter'
import type { SDKMessage, SDKUserMessage, SDKAssistantMessage, SDKSystemMessage, SDKResultMessage } from '@/backends/claude/sdk'

describe('SDKToLogConverter', () => {
    let converter: SDKToLogConverter
    const context = {
        sessionId: 'test-session-123',
        cwd: '/test/project',
        version: '1.0.0',
        gitBranch: 'main'
    }

    beforeEach(() => {
        converter = new SDKToLogConverter(context)
    })

    describe('User messages', () => {
        it('should convert SDK user message to log format', () => {
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: {
                    role: 'user',
                    content: 'Hello Claude'
                }
            }

            const logMessage = converter.convert(sdkMessage)

            expect(logMessage).toBeTruthy()
            expect(logMessage?.type).toBe('user')
            expect(logMessage).toMatchObject({
                type: 'user',
                sessionId: context.sessionId,
                cwd: context.cwd,
                version: context.version,
                gitBranch: context.gitBranch,
                parentUuid: null,
                isSidechain: false,
                userType: 'external',
                message: {
                    role: 'user',
                    content: 'Hello Claude'
                }
            })
            expect(logMessage?.uuid).toBeTruthy()
            expect(logMessage?.timestamp).toBeTruthy()
        })

        it('should handle user message with complex content', () => {
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Check this out' },
                        { type: 'tool_result', tool_use_id: 'tool123', content: 'Result data' }
                    ]
                }
            }

            const logMessage = converter.convert(sdkMessage)

            expect(logMessage?.type).toBe('user')
            expect((logMessage as any).message.content).toHaveLength(2)
        })
    })

    describe('Assistant messages', () => {
        it('should convert SDK assistant message to log format', () => {
            const sdkMessage: SDKAssistantMessage = {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Hello! How can I help?' }
                    ]
                }
            }

            const logMessage = converter.convert(sdkMessage)

            expect(logMessage).toBeTruthy()
            expect(logMessage?.type).toBe('assistant')
            expect(logMessage).toMatchObject({
                type: 'assistant',
                sessionId: context.sessionId,
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Hello! How can I help?' }
                    ]
                }
            })
        })

        it('should include requestId if present', () => {
            const sdkMessage: any = {
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Response' }]
                },
                requestId: 'req_123'
            }

            const logMessage = converter.convert(sdkMessage)

            expect((logMessage as any).requestId).toBe('req_123')
        })
    })

    describe('System messages', () => {
        it('should convert SDK system message to log format', () => {
            const sdkMessage: SDKSystemMessage = {
                type: 'system',
                subtype: 'init',
                session_id: 'new-session-456',
                model: 'claude-opus-4',
                cwd: '/project',
                tools: ['bash', 'edit']
            }

            const logMessage = converter.convert(sdkMessage)

            expect(logMessage).toBeTruthy()
            expect(logMessage?.type).toBe('system')
            expect(logMessage).toMatchObject({
                type: 'system',
                subtype: 'init',
                model: 'claude-opus-4',
                tools: ['bash', 'edit']
            })
        })

        it('should update session ID on init system message', () => {
            const sdkMessage: SDKSystemMessage = {
                type: 'system',
                subtype: 'init',
                session_id: 'updated-session-789'
            }

            converter.convert(sdkMessage)

            // Next message should have updated session ID
            const userMessage: SDKUserMessage = {
                type: 'user',
                message: { role: 'user', content: 'Test' }
            }

            const logMessage = converter.convert(userMessage)
            expect(logMessage?.sessionId).toBe('updated-session-789')
        })
    })

    describe('Result messages', () => {
        it('should not convert result messages', () => {
            const sdkMessage: SDKResultMessage = {
                type: 'result',
                subtype: 'success',
                result: 'Task completed',
                num_turns: 5,
                usage: {
                    input_tokens: 100,
                    output_tokens: 200
                },
                total_cost_usd: 0.05,
                duration_ms: 3000,
                duration_api_ms: 2500,
                is_error: false,
                session_id: 'result-session'
            }

            const logMessage = converter.convert(sdkMessage)

            expect(logMessage).toBeNull()
        })

        it('should not convert error results', () => {
            const sdkMessage: SDKResultMessage = {
                type: 'result',
                subtype: 'error_max_turns',
                num_turns: 10,
                total_cost_usd: 0.1,
                duration_ms: 5000,
                duration_api_ms: 4500,
                is_error: true,
                session_id: 'error-session'
            }

            const logMessage = converter.convert(sdkMessage)

            // Error results are not converted to summaries
            expect(logMessage).toBeFalsy()
        })
    })

    describe('Parent-child relationships', () => {
        it('should track parent UUIDs across messages', () => {
            const msg1: SDKUserMessage = {
                type: 'user',
                message: { role: 'user', content: 'First' }
            }
            const msg2: SDKAssistantMessage = {
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Second' }] }
            }
            const msg3: SDKUserMessage = {
                type: 'user',
                message: { role: 'user', content: 'Third' }
            }

            const log1 = converter.convert(msg1)
            const log2 = converter.convert(msg2)
            const log3 = converter.convert(msg3)

            expect(log1?.parentUuid).toBeNull()
            expect(log2?.parentUuid).toBe(log1?.uuid)
            expect(log3?.parentUuid).toBe(log2?.uuid)
        })

        it('should reset parent chain when requested', () => {
            const msg1: SDKUserMessage = {
                type: 'user',
                message: { role: 'user', content: 'First' }
            }
            const log1 = converter.convert(msg1)

            converter.resetParentChain()

            const msg2: SDKUserMessage = {
                type: 'user',
                message: { role: 'user', content: 'Second' }
            }
            const log2 = converter.convert(msg2)

            expect(log2?.parentUuid).toBeNull()
        })
    })

    describe('Batch conversion', () => {
        it('should convert multiple messages maintaining relationships', () => {
            const messages: SDKMessage[] = [
                {
                    type: 'user',
                    message: { role: 'user', content: 'Hello' }
                } as SDKUserMessage,
                {
                    type: 'assistant',
                    message: { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] }
                } as SDKAssistantMessage,
                {
                    type: 'user',
                    message: { role: 'user', content: 'How are you?' }
                } as SDKUserMessage
            ]

            const logMessages = converter.convertMany(messages)

            expect(logMessages).toHaveLength(3)
            expect(logMessages[0].parentUuid).toBeNull()
            expect(logMessages[1].parentUuid).toBe(logMessages[0].uuid)
            expect(logMessages[2].parentUuid).toBe(logMessages[1].uuid)
        })
    })

    describe('Convenience function', () => {
        it('should convert single message without state', () => {
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: { role: 'user', content: 'Test message' }
            }

            const logMessage = convertSDKToLog(sdkMessage, context)

            expect(logMessage).toBeTruthy()
            expect(logMessage?.type).toBe('user')
            expect(logMessage?.parentUuid).toBeNull()
        })
    })

    describe('Tool results with mode', () => {
        it('should add mode to tool result when available in responses', () => {
            const responses = new Map<string, { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }>()
            responses.set('tool_123', { approved: true, mode: 'acceptEdits' })
            
            const converterWithResponses = new SDKToLogConverter(context, responses)
            
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: 'tool_123',
                        content: 'Tool executed successfully'
                    }]
                }
            }

            const logMessage = converterWithResponses.convert(sdkMessage)

            expect(logMessage).toBeTruthy()
            expect((logMessage as any).mode).toBe('acceptEdits')
            expect((logMessage as any).toolUseResult).toBeUndefined() // toolUseResult is not added when using array content
        })

        it('should not add mode when not in responses', () => {
            const responses = new Map<string, { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }>()
            
            const converterWithResponses = new SDKToLogConverter(context, responses)
            
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: 'tool_456',
                        content: 'Tool result'
                    }]
                }
            }

            const logMessage = converterWithResponses.convert(sdkMessage)

            expect(logMessage).toBeTruthy()
            expect((logMessage as any).mode).toBeUndefined()
            expect((logMessage as any).toolUseResult).toBeUndefined() // toolUseResult is not added when using array content
        })

        it('should handle mixed content with tool results', () => {
            const responses = new Map<string, { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }>()
            responses.set('tool_789', { approved: true, mode: 'bypassPermissions' })
            
            const converterWithResponses = new SDKToLogConverter(context, responses)
            
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Here is the result:' },
                        {
                            type: 'tool_result',
                            tool_use_id: 'tool_789',
                            content: 'Tool output'
                        }
                    ]
                }
            }

            const logMessage = converterWithResponses.convert(sdkMessage)

            expect(logMessage).toBeTruthy()
            expect((logMessage as any).mode).toBe('bypassPermissions')
            expect((logMessage as any).toolUseResult).toBeUndefined() // toolUseResult is not added when using array content
        })

        it('should work with convenience function', () => {
            const responses = new Map<string, { approved: boolean, mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan', reason?: string }>()
            responses.set('tool_abc', { approved: false, mode: 'plan', reason: 'User rejected' })
            
            const sdkMessage: SDKUserMessage = {
                type: 'user',
                message: {
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: 'tool_abc',
                        content: 'Permission denied'
                    }]
                }
            }

            const logMessage = convertSDKToLog(sdkMessage, context, responses)

            expect(logMessage).toBeTruthy()
            expect((logMessage as any).mode).toBe('plan')
        })
    })
})