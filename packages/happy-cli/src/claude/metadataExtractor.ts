/**
 * SDK Metadata Extractor
 * Captures available tools and slash commands from Claude SDK initialization
 */

import { query, type SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk'
import { logger } from '@/ui/logger'

export interface SDKMetadata {
    tools?: string[]
    slashCommands?: string[]
}

/**
 * Extract SDK metadata by running a minimal query and capturing the init message
 * @returns SDK metadata containing tools and slash commands
 */
export async function extractSDKMetadata(): Promise<SDKMetadata> {
    const abortController = new AbortController()

    try {
        logger.debug('[metadataExtractor] Starting SDK metadata extraction')

        const sdkQuery = query({
            prompt: 'hello',
            options: {
                abortController,
                allowedTools: ['Bash(echo)'],
                maxTurns: 1,
                settingSources: ['user', 'project', 'local'],
            }
        })

        for await (const message of sdkQuery) {
            if (message.type === 'system' && message.subtype === 'init') {
                const systemMessage = message as SDKSystemMessage

                const metadata: SDKMetadata = {
                    tools: systemMessage.tools,
                    slashCommands: systemMessage.slash_commands
                }

                logger.debug('[metadataExtractor] Captured SDK metadata:', metadata)
                abortController.abort()
                return metadata
            }
        }

        logger.debug('[metadataExtractor] No init message received from SDK')
        return {}
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            logger.debug('[metadataExtractor] SDK query aborted after capturing metadata')
            return {}
        }
        logger.debug('[metadataExtractor] Error extracting SDK metadata:', error)
        return {}
    }
}

/**
 * Extract SDK metadata asynchronously without blocking
 * Fires the extraction and updates metadata when complete
 */
export function extractSDKMetadataAsync(onComplete: (metadata: SDKMetadata) => void): void {
    extractSDKMetadata()
        .then(metadata => {
            if (metadata.tools || metadata.slashCommands) {
                onComplete(metadata)
            }
        })
        .catch(error => {
            logger.debug('[metadataExtractor] Async extraction failed:', error)
        })
}
