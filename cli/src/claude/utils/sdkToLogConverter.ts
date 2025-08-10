/**
 * Converter from SDK message types to log format (RawJSONLines)
 * Transforms Claude SDK messages into the format expected by session logs
 */

import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import type { 
    SDKMessage, 
    SDKUserMessage, 
    SDKAssistantMessage, 
    SDKSystemMessage,
    SDKResultMessage 
} from '@/claude/sdk'
import type { RawJSONLines } from '@/claude/types'

/**
 * Context for converting SDK messages to log format
 */
export interface ConversionContext {
    sessionId: string
    cwd: string
    version?: string
    gitBranch?: string
    parentUuid?: string | null
}

/**
 * Get current git branch for the working directory
 */
function getGitBranch(cwd: string): string | undefined {
    try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim()
        return branch || undefined
    } catch {
        return undefined
    }
}

/**
 * SDK to Log converter class
 * Maintains state for parent-child relationships between messages
 */
export class SDKToLogConverter {
    private lastUuid: string | null = null
    private context: ConversionContext

    constructor(context: Omit<ConversionContext, 'parentUuid'>) {
        this.context = {
            ...context,
            gitBranch: context.gitBranch ?? getGitBranch(context.cwd),
            version: context.version ?? process.env.npm_package_version ?? '0.0.0',
            parentUuid: null
        }
    }

    /**
     * Update session ID (for when session changes during resume)
     */
    updateSessionId(sessionId: string): void {
        this.context.sessionId = sessionId
    }

    /**
     * Reset parent chain (useful when starting new conversation)
     */
    resetParentChain(): void {
        this.lastUuid = null
        this.context.parentUuid = null
    }

    /**
     * Convert SDK message to log format
     */
    convert(sdkMessage: SDKMessage): RawJSONLines | null {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        const baseFields = {
            parentUuid: this.lastUuid,
            isSidechain: false,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            uuid,
            timestamp
        }

        let logMessage: RawJSONLines | null = null

        switch (sdkMessage.type) {
            case 'user': {
                const userMsg = sdkMessage as SDKUserMessage
                logMessage = {
                    ...baseFields,
                    type: 'user',
                    message: userMsg.message
                }
                break
            }

            case 'assistant': {
                const assistantMsg = sdkMessage as SDKAssistantMessage
                logMessage = {
                    ...baseFields,
                    type: 'assistant',
                    message: assistantMsg.message,
                    // Assistant messages often have additional fields
                    requestId: (assistantMsg as any).requestId
                }
                break
            }

            case 'system': {
                const systemMsg = sdkMessage as SDKSystemMessage
                
                // System messages with subtype 'init' might update session ID
                if (systemMsg.subtype === 'init' && systemMsg.session_id) {
                    this.updateSessionId(systemMsg.session_id)
                }

                // System messages are typically not sent to logs
                // but we can convert them if needed
                logMessage = {
                    ...baseFields,
                    type: 'system',
                    subtype: systemMsg.subtype,
                    model: systemMsg.model,
                    tools: systemMsg.tools,
                    // Include all other fields
                    ...(systemMsg as any)
                }
                break
            }

            case 'result': {
                // Result messages are typically not sent to logs
                // They're more for SDK consumption
                // But we can include them as metadata if needed
                const resultMsg = sdkMessage as SDKResultMessage
                
                // Could convert to a summary message
                if (resultMsg.subtype === 'success') {
                    logMessage = {
                        type: 'summary',
                        summary: `Session completed successfully in ${resultMsg.num_turns} turns`,
                        leafUuid: this.lastUuid ?? uuid,
                        // Include usage and cost info
                        usage: resultMsg.usage,
                        totalCost: resultMsg.total_cost_usd,
                        duration: resultMsg.duration_ms,
                        sessionId: resultMsg.session_id || this.context.sessionId
                    }
                }
                break
            }

            // Handle tool use results (often comes as user messages)
            case 'tool_result': {
                const toolMsg = sdkMessage as any
                logMessage = {
                    ...baseFields,
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{
                            type: 'tool_result',
                            tool_use_id: toolMsg.tool_use_id,
                            content: toolMsg.content
                        }]
                    },
                    toolUseResult: toolMsg.content
                }
                break
            }

            default:
                // Unknown message type - pass through with all fields
                logMessage = {
                    ...baseFields,
                    ...sdkMessage,
                    type: (sdkMessage as any).type // Override type last to ensure it's set
                } as any
        }

        // Update last UUID for parent tracking
        if (logMessage && logMessage.type !== 'summary') {
            this.lastUuid = uuid
        }

        return logMessage
    }

    /**
     * Convert multiple SDK messages to log format
     */
    convertMany(sdkMessages: SDKMessage[]): RawJSONLines[] {
        return sdkMessages
            .map(msg => this.convert(msg))
            .filter((msg): msg is RawJSONLines => msg !== null)
    }
}

/**
 * Convenience function for one-off conversions
 */
export function convertSDKToLog(
    sdkMessage: SDKMessage, 
    context: Omit<ConversionContext, 'parentUuid'>
): RawJSONLines | null {
    const converter = new SDKToLogConverter(context)
    return converter.convert(sdkMessage)
}