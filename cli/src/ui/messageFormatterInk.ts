import type { SDKMessage, SDKAssistantMessage, SDKResultMessage, SDKSystemMessage, SDKUserMessage } from '@/backends/claude/sdk'
import type { MessageBuffer } from './ink/messageBuffer'
import { logger } from './logger'

export type OnAssistantResultInkCallback = (result: SDKResultMessage, messageBuffer: MessageBuffer) => void | Promise<void>

/**
 * Formats Claude SDK messages for Ink display
 */
export function formatClaudeMessageForInk(
    message: SDKMessage,
    messageBuffer: MessageBuffer,
    onAssistantResult?: OnAssistantResultInkCallback
): void {
    logger.debugLargeJson('[CLAUDE INK] Message from remote mode:', message)

    switch (message.type) {
        case 'system': {
            const sysMsg = message as SDKSystemMessage
            if (sysMsg.subtype === 'init') {
                messageBuffer.addMessage('─'.repeat(40), 'status')
                messageBuffer.addMessage(`🚀 Session initialized: ${sysMsg.session_id}`, 'system')
                messageBuffer.addMessage(`  Model: ${sysMsg.model}`, 'status')
                messageBuffer.addMessage(`  CWD: ${sysMsg.cwd}`, 'status')
                if (sysMsg.tools && sysMsg.tools.length > 0) {
                    messageBuffer.addMessage(`  Tools: ${sysMsg.tools.join(', ')}`, 'status')
                }
                messageBuffer.addMessage('─'.repeat(40), 'status')
            }
            break
        }

        case 'user': {
            const userMsg = message as SDKUserMessage
            if (userMsg.message && typeof userMsg.message === 'object' && 'content' in userMsg.message) {
                const content = userMsg.message.content
                
                if (typeof content === 'string') {
                    messageBuffer.addMessage(`👤 User: ${content}`, 'user')
                } 
                else if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === 'text') {
                            messageBuffer.addMessage(`👤 User: ${block.text}`, 'user')
                        } else if (block.type === 'tool_result') {
                            messageBuffer.addMessage(`✅ Tool Result (ID: ${block.tool_use_id})`, 'result')
                            if (block.content) {
                                const outputStr = typeof block.content === 'string' 
                                    ? block.content 
                                    : JSON.stringify(block.content, null, 2)
                                const maxLength = 200
                                if (outputStr.length > maxLength) {
                                    messageBuffer.addMessage(outputStr.substring(0, maxLength) + '... (truncated)', 'result')
                                } else {
                                    messageBuffer.addMessage(outputStr, 'result')
                                }
                            }
                        }
                    }
                }
                else {
                    messageBuffer.addMessage(`👤 User: ${JSON.stringify(content, null, 2)}`, 'user')
                }
            }
            break
        }

        case 'assistant': {
            const assistantMsg = message as SDKAssistantMessage
            if (assistantMsg.message && assistantMsg.message.content) {
                messageBuffer.addMessage('🤖 Assistant:', 'assistant')
                
                for (const block of assistantMsg.message.content) {
                    if (block.type === 'text') {
                        messageBuffer.addMessage(block.text || '', 'assistant')
                    } else if (block.type === 'tool_use') {
                        messageBuffer.addMessage(`🔧 Tool: ${block.name}`, 'tool')
                        if (block.input) {
                            const inputStr = JSON.stringify(block.input, null, 2)
                            const maxLength = 500
                            if (inputStr.length > maxLength) {
                                messageBuffer.addMessage(`Input: ${inputStr.substring(0, maxLength)}... (truncated)`, 'tool')
                            } else {
                                messageBuffer.addMessage(`Input: ${inputStr}`, 'tool')
                            }
                        }
                    }
                }
            }
            break
        }

        case 'result': {
            const resultMsg = message as SDKResultMessage
            if (resultMsg.subtype === 'success') {
                if ('result' in resultMsg && resultMsg.result) {
                    messageBuffer.addMessage('✨ Summary:', 'result')
                    messageBuffer.addMessage(resultMsg.result || '', 'result')
                }
                
                if (resultMsg.usage) {
                    messageBuffer.addMessage('📊 Session Stats:', 'status')
                    messageBuffer.addMessage(`  • Turns: ${resultMsg.num_turns}`, 'status')
                    messageBuffer.addMessage(`  • Input tokens: ${resultMsg.usage.input_tokens}`, 'status')
                    messageBuffer.addMessage(`  • Output tokens: ${resultMsg.usage.output_tokens}`, 'status')
                    if (resultMsg.usage.cache_read_input_tokens) {
                        messageBuffer.addMessage(`  • Cache read tokens: ${resultMsg.usage.cache_read_input_tokens}`, 'status')
                    }
                    if (resultMsg.usage.cache_creation_input_tokens) {
                        messageBuffer.addMessage(`  • Cache creation tokens: ${resultMsg.usage.cache_creation_input_tokens}`, 'status')
                    }
                    messageBuffer.addMessage(`  • Cost: $${resultMsg.total_cost_usd.toFixed(4)}`, 'status')
                    messageBuffer.addMessage(`  • Duration: ${resultMsg.duration_ms}ms`, 'status')

                    if (onAssistantResult) {
                        Promise.resolve(onAssistantResult(resultMsg, messageBuffer)).catch(err => {
                            logger.debug('Error in onAssistantResult callback:', err)
                        })
                    }
                }
            } else if (resultMsg.subtype === 'error_max_turns') {
                messageBuffer.addMessage('❌ Error: Maximum turns reached', 'result')
                messageBuffer.addMessage(`Completed ${resultMsg.num_turns} turns`, 'status')
            } else if (resultMsg.subtype === 'error_during_execution') {
                messageBuffer.addMessage('❌ Error during execution', 'result')
                messageBuffer.addMessage(`Completed ${resultMsg.num_turns} turns before error`, 'status')
                logger.debugLargeJson('[RESULT] Error during execution', resultMsg)
            }
            break
        }

        default: {
            if (process.env.DEBUG) {
                messageBuffer.addMessage(`[Unknown message type: ${message.type}]`, 'status')
            }
        }
    }
}