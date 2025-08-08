/**
 * Main query implementation for Claude Code SDK
 * Handles spawning Claude process and managing message streams
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { Stream } from './stream'
import { 
    type QueryOptions, 
    type QueryPrompt, 
    type SDKMessage, 
    type ControlResponseHandler,
    type SDKControlRequest,
    type ControlRequest,
    type SDKControlResponse,
    AbortError 
} from './types'
import { getDefaultClaudeCodePath, logDebug, streamToStdin } from './utils'
import type { Writable } from 'node:stream'

/**
 * Query class manages Claude Code process interaction
 */
export class Query implements AsyncIterableIterator<SDKMessage> {
    private pendingControlResponses = new Map<string, ControlResponseHandler>()
    private sdkMessages: AsyncIterableIterator<SDKMessage>
    private inputStream = new Stream<SDKMessage>()

    constructor(
        private childStdin: Writable | null,
        private childStdout: NodeJS.ReadableStream,
        private processExitPromise: Promise<void>
    ) {
        this.readMessages()
        this.sdkMessages = this.readSdkMessages()
    }

    /**
     * Set an error on the stream
     */
    setError(error: Error): void {
        this.inputStream.error(error)
    }

    /**
     * AsyncIterableIterator implementation
     */
    next(...args: [] | [undefined]): Promise<IteratorResult<SDKMessage>> {
        return this.sdkMessages.next(...args)
    }

    return(value?: any): Promise<IteratorResult<SDKMessage>> {
        if (this.sdkMessages.return) {
            return this.sdkMessages.return(value)
        }
        return Promise.resolve({ done: true, value: undefined })
    }

    throw(e: any): Promise<IteratorResult<SDKMessage>> {
        if (this.sdkMessages.throw) {
            return this.sdkMessages.throw(e)
        }
        return Promise.reject(e)
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
        return this.sdkMessages
    }

    /**
     * Read messages from Claude process stdout
     */
    private async readMessages(): Promise<void> {
        const rl = createInterface({ input: this.childStdout })
        
        try {
            for await (const line of rl) {
                if (line.trim()) {
                    const message = JSON.parse(line) as SDKMessage | SDKControlResponse
                    
                    if (message.type === 'control_response') {
                        const controlResponse = message as SDKControlResponse
                        const handler = this.pendingControlResponses.get(controlResponse.response.request_id)
                        if (handler) {
                            handler(controlResponse.response)
                        }
                        continue
                    }
                    
                    this.inputStream.enqueue(message)
                }
            }
            await this.processExitPromise
        } catch (error) {
            this.inputStream.error(error as Error)
        } finally {
            this.inputStream.done()
            rl.close()
        }
    }

    /**
     * Async generator for SDK messages
     */
    private async *readSdkMessages(): AsyncIterableIterator<SDKMessage> {
        for await (const message of this.inputStream) {
            yield message
        }
    }

    /**
     * Send interrupt request to Claude
     */
    async interrupt(): Promise<void> {
        if (!this.childStdin) {
            throw new Error('Interrupt requires --input-format stream-json')
        }
        
        await this.request({
            subtype: 'interrupt'
        }, this.childStdin)
    }

    /**
     * Send control request to Claude process
     */
    private request(request: ControlRequest, childStdin: Writable): Promise<SDKControlResponse['response']> {
        const requestId = Math.random().toString(36).substring(2, 15)
        const sdkRequest: SDKControlRequest = {
            request_id: requestId,
            type: 'control_request',
            request
        }
        
        return new Promise((resolve, reject) => {
            this.pendingControlResponses.set(requestId, (response) => {
                if (response.subtype === 'success') {
                    resolve(response)
                } else {
                    reject(new Error(response.error))
                }
            })
            
            childStdin.write(JSON.stringify(sdkRequest) + '\n')
        })
    }
}

/**
 * Main query function to interact with Claude Code
 */
export function query(config: {
    prompt: QueryPrompt
    options?: QueryOptions
}): Query {
    const {
        prompt,
        options: {
            allowedTools = [],
            appendSystemPrompt,
            customSystemPrompt,
            cwd,
            disallowedTools = [],
            executable = 'node',
            executableArgs = [],
            maxTurns,
            mcpServers,
            pathToClaudeCodeExecutable = getDefaultClaudeCodePath(),
            permissionMode = 'default',
            permissionPromptToolName,
            continue: continueConversation,
            resume,
            model,
            fallbackModel,
            strictMcpConfig
        } = {}
    } = config

    // Set entrypoint if not already set
    if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
        process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    }

    // Build command arguments
    const args = ['--output-format', 'stream-json', '--verbose']
    
    if (customSystemPrompt) args.push('--system-prompt', customSystemPrompt)
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt)
    if (maxTurns) args.push('--max-turns', maxTurns.toString())
    if (model) args.push('--model', model)
    if (permissionPromptToolName) args.push('--permission-prompt-tool', permissionPromptToolName)
    if (continueConversation) args.push('--continue')
    if (resume) args.push('--resume', resume)
    if (allowedTools.length > 0) args.push('--allowedTools', allowedTools.join(','))
    if (disallowedTools.length > 0) args.push('--disallowedTools', disallowedTools.join(','))
    if (mcpServers && Object.keys(mcpServers).length > 0) {
        args.push('--mcp-config', JSON.stringify({ mcpServers }))
    }
    if (strictMcpConfig) args.push('--strict-mcp-config')
    if (permissionMode) args.push('--permission-mode', permissionMode)
    
    if (fallbackModel) {
        if (model && fallbackModel === model) {
            throw new Error('Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.')
        }
        args.push('--fallback-model', fallbackModel)
    }

    // Handle prompt input
    if (typeof prompt === 'string') {
        args.push('--print', prompt.trim())
    } else {
        args.push('--input-format', 'stream-json')
    }

    // Validate executable path
    if (!existsSync(pathToClaudeCodeExecutable)) {
        throw new ReferenceError(`Claude Code executable not found at ${pathToClaudeCodeExecutable}. Is options.pathToClaudeCodeExecutable set?`)
    }

    // Spawn Claude Code process
    logDebug(`Spawning Claude Code process: ${executable} ${[...executableArgs, pathToClaudeCodeExecutable, ...args].join(' ')}`)
    
    const child = spawn(executable, [...executableArgs, pathToClaudeCodeExecutable, ...args], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: config.options?.abort,
        env: {
            ...process.env
        }
    }) as ChildProcessWithoutNullStreams

    // Handle stdin
    let childStdin: Writable | null = null
    if (typeof prompt === 'string') {
        child.stdin.end()
    } else {
        streamToStdin(prompt, child.stdin, config.options?.abort)
        childStdin = child.stdin
    }

    // Handle stderr in debug mode
    if (process.env.DEBUG) {
        child.stderr.on('data', (data) => {
            console.error('Claude Code stderr:', data.toString())
        })
    }

    // Setup cleanup
    const cleanup = () => {
        if (!child.killed) {
            child.kill('SIGTERM')
        }
    }

    config.options?.abort?.addEventListener('abort', cleanup)
    process.on('exit', cleanup)

    // Handle process exit
    const processExitPromise = new Promise<void>((resolve) => {
        child.on('close', (code) => {
            if (config.options?.abort?.aborted) {
                query.setError(new AbortError('Claude Code process aborted by user'))
            }
            if (code !== 0) {
                query.setError(new Error(`Claude Code process exited with code ${code}`))
            } else {
                resolve()
            }
        })
    })

    // Create query instance
    const query = new Query(childStdin, child.stdout, processExitPromise)

    // Handle process errors
    child.on('error', (error) => {
        if (config.options?.abort?.aborted) {
            query.setError(new AbortError('Claude Code process aborted by user'))
        } else {
            query.setError(new Error(`Failed to spawn Claude Code process: ${error.message}`))
        }
    })

    // Cleanup on exit
    processExitPromise.finally(() => {
        cleanup()
        config.options?.abort?.removeEventListener('abort', cleanup)
        if (process.env.CLAUDE_SDK_MCP_SERVERS) {
            delete process.env.CLAUDE_SDK_MCP_SERVERS
        }
    })

    return query
}