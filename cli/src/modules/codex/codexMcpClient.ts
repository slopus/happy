/**
 * Codex MCP Client - Simple wrapper for Codex tools
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { logger } from '@/ui/logger';
import type { CodexSessionConfig, CodexToolResponse } from './types';
import { z } from 'zod';

export class CodexMcpClient {
    private client: Client;
    private transport: StdioClientTransport | null = null;
    private connected: boolean = false;
    private sessionId: string | null = null;
    private handler: ((event: any) => void) | null = null;

    constructor() {
        this.client = new Client(
            { name: 'happy-codex-client', version: '1.0.0' },
            { capabilities: { tools: {} } }
        );

        this.client.setNotificationHandler(z.object({
            method: z.literal('codex/event'),
            params: z.object({
                msg: z.any()
            })
        }).passthrough(), (data) => {
            if ((data.params as any).msg.type === 'agent_reasoning_delta'
                || (data.params as any).msg.type === 'agent_message_delta'
                || (data.params as any).msg.type === 'exec_command_output_delta'
            ) {
                return;
            }
            if (data.params.msg.type === 'session_configured') {
                this.sessionId = data.params.msg.session_id;
            }
            this.handler?.(data.params.msg);
        });
    }

    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        logger.debug('[CodexMCP] Connecting to Codex MCP server...');

        this.transport = new StdioClientTransport({
            command: 'codex',
            args: ['mcp']
        });

        await this.client.connect(this.transport);
        this.connected = true;

        logger.debug('[CodexMCP] Connected to Codex');
    }

    async startSession(config: CodexSessionConfig, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        logger.debug('[CodexMCP] Starting Codex session:', config);

        const response = await this.client.callTool({
            name: 'codex',
            arguments: config as any
        }, undefined, {
            signal: options?.signal
            // timeout: 10000000000,
            // maxTotalTimeout: 10000000000 
        });

        console.log('[CodexMCP] Response:', response);

        // Extract session ID from response if present
        this.extractSessionId(response);

        return response as CodexToolResponse;
    }

    async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        if (!this.sessionId) {
            throw new Error('No active session. Call startSession first.');
        }

        const args = { sessionId: this.sessionId, prompt };
        logger.debug('[CodexMCP] Continuing Codex session:', args);

        const response = await this.client.callTool({
            name: 'codex-reply',
            arguments: args
        }, undefined, {
            signal: options?.signal
            // timeout: 1000000,
            // maxTotalTimeout: 1000000
        });

        return response as CodexToolResponse;
    }

    private extractSessionId(response: any): void {
        // Try to extract session ID from response
        // This might be in response.content or response.meta or elsewhere
        // Adjust based on actual Codex response structure
        if (response?.meta?.sessionId) {
            this.sessionId = response.meta.sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
        } else if (response?.sessionId) {
            this.sessionId = response.sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
        } else {
            // Look in content for session ID
            const content = response?.content;
            if (Array.isArray(content)) {
                for (const item of content) {
                    if (item?.sessionId) {
                        this.sessionId = item.sessionId;
                        logger.debug('[CodexMCP] Session ID extracted from content:', this.sessionId);
                        break;
                    }
                }
            }
        }
    }

    getSessionId(): string | null {
        return this.sessionId;
    }

    hasActiveSession(): boolean {
        return this.sessionId !== null;
    }

    clearSession(): void {
        this.sessionId = null;
        logger.debug('[CodexMCP] Session cleared');
    }

    async disconnect(): Promise<void> {
        if (!this.connected) return;

        await this.client.close();
        this.transport = null;
        this.connected = false;
        this.sessionId = null;

        logger.debug('[CodexMCP] Disconnected');
    }
}