/**
 * Happy MCP server
 * Provides Happy CLI specific tools including chat session title management
 * and current-session lifecycle actions.
 *
 * Uses stateless StreamableHTTP: each request gets a fresh McpServer + transport.
 * This is required by MCP SDK >=1.27 which rejects reuse of an already-connected transport.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { z } from "zod";
import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { BROWSER_STEP_TOOL_DESCRIPTION } from "@/browser/browserStepReportingPrompt";
import { configuration } from "@/configuration";
import { fetchFinanceChart } from "@/finance/financeChart";

type HappyMcpHandlers = {
    changeTitle: (title: string) => Promise<{ success: boolean; error?: string }>;
    sendImage: (input: SendImageInput) => Promise<{ success: boolean; error?: string }>;
    sendFile: (input: SendFileInput) => Promise<{ success: boolean; error?: string }>;
    reportBrowserStep: (input: BrowserStepInput) => Promise<{ success: boolean; error?: string }>;
    archiveSession: (reason?: string) => Promise<{ success: boolean; error?: string }>;
    financeChart: (input: {
        query: string;
        range?: '5d' | '1mo' | '3mo' | '6mo' | '1y';
        interval?: '1d';
    }) => Promise<{ success: boolean; data?: unknown; error?: string }>;
};

type SendImageInput = {
    path: string;
    prompt?: string;
    batchId?: string;
};

type SendFileInput = {
    path: string;
    mimeType?: string;
};

type BrowserStepInput = {
    path: string;
    label: string;
};

function createMcpServer(handlers: HappyMcpHandlers): McpServer {
    const mcp = new McpServer({
        name: "Happy MCP",
        version: "1.0.0",
    });

    mcp.registerTool('change_title', {
        description: 'Change the title of the current chat session',
        title: 'Change Chat Title',
        inputSchema: {
            title: z.string().describe('The new title for the chat session'),
        },
    }, async (args) => {
        const response = await handlers.changeTitle(args.title);
        logger.debug('[happyMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Successfully changed chat title to: "${args.title}"`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to change chat title: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool('send_image', {
        description: 'Send a local image file into the current chat so the user sees it inline (works on phone and desktop). Use after generating or editing an image. Provide an absolute path to a PNG/JPEG. Include prompt and batchId when this is a GPT Image 2 output so it appears in the generated image gallery with its prompt.',
        title: 'Send Image To Chat',
        inputSchema: {
            path: z.string().describe('Absolute path to the local image file (PNG/JPEG)'),
            prompt: z.string().optional().describe('Prompt used to generate this image. Required for GPT Image 2 gallery records when available.'),
            batchId: z.string().optional().describe('Stable id shared by images from the same generation batch.'),
        },
    }, async (args) => {
        const response = await handlers.sendImage({
            path: args.path,
            ...(args.prompt ? { prompt: args.prompt } : {}),
            ...(args.batchId ? { batchId: args.batchId } : {}),
        });
        logger.debug('[happyMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Sent image to chat: ${args.path}`,
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to send image: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool('send_file', {
        description: 'Send a locally generated audio or video file into the current chat. Phone and desktop clients render a playable media card. Provide an absolute path to MP4/MOV/WebM/MP3/M4A/WAV or another supported media file.',
        title: 'Send File To Chat',
        inputSchema: {
            path: z.string().describe('Absolute path to the local audio/video file'),
            mimeType: z.string().optional().describe('Optional audio/* or video/* MIME type override'),
        },
    }, async (args) => {
        const response = await handlers.sendFile({
            path: args.path,
            ...(args.mimeType ? { mimeType: args.mimeType } : {}),
        });
        logger.debug('[happyMCP] Response:', response);
        return response.success
            ? {
                content: [{ type: 'text', text: `Sent file to chat: ${args.path}` }],
                isError: false,
            }
            : {
                content: [{ type: 'text', text: `Failed to send file: ${response.error || 'Unknown error'}` }],
                isError: true,
            };
    });

    mcp.registerTool('report_browser_step', {
        description: BROWSER_STEP_TOOL_DESCRIPTION,
        title: 'Report Browser Step',
        inputSchema: {
            path: z.string().describe('Absolute path to the browser screenshot (PNG/JPEG)'),
            label: z.string().trim().min(1).describe('Short description of the operation that just completed'),
        },
    }, async (args) => {
        const response = await handlers.reportBrowserStep({ path: args.path, label: args.label });
        logger.debug('[happyMCP] Response:', response);
        return response.success
            ? {
                content: [{ type: 'text', text: `Reported browser step: ${args.label}` }],
                isError: false,
            }
            : {
                content: [{ type: 'text', text: `Failed to report browser step: ${response.error || 'Unknown error'}` }],
                isError: true,
            };
    });

    mcp.registerTool('archive_session', {
        description: 'Archive and stop the current Happy chat session. Only use this when the user explicitly asks to archive, close, or end the current session after finishing the task.',
        title: 'Archive Current Chat Session',
        inputSchema: {
            reason: z.string().optional().describe('Optional short reason for archiving the session'),
        },
    }, async (args) => {
        const response = await handlers.archiveSession(args.reason);

        logger.debug('[happyMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: 'Archived current chat session',
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to archive chat session: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    mcp.registerTool('finance_chart', {
        description: 'Fetch real market OHLC chart data for a stock, index, ETF, or crypto symbol and return a Happy finance chart block for chat rendering.',
        title: 'Fetch Finance Chart',
        inputSchema: {
            query: z.string().describe('Stock/index query or symbol, such as 上证指数, 000001.SS, AAPL, or 0700.HK'),
            range: z.enum(['5d', '1mo', '3mo', '6mo', '1y']).optional().describe('Chart range. Defaults to 1mo.'),
            interval: z.enum(['1d']).optional().describe('Chart interval. Defaults to 1d.'),
        },
    }, async (args) => {
        const response = await handlers.financeChart({
            query: args.query,
            ...(args.range ? { range: args.range } : {}),
            ...(args.interval ? { interval: args.interval } : {}),
        });
        logger.debug('[happyMCP] Response:', response);

        if (response.success) {
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
                isError: false,
            };
        } else {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to fetch finance chart: ${response.error || 'Unknown error'}`,
                    },
                ],
                isError: true,
            };
        }
    });

    return mcp;
}

export async function startHappyServer(
    client: ApiSessionClient,
    options?: {
        archiveSession?: (reason?: string) => Promise<{ success: boolean; error?: string }>;
    },
) {
    logger.debug(`[happyMCP] server:start sessionId=${client.sessionId}`);

    const handlers: HappyMcpHandlers = {
        changeTitle: async (title: string) => {
            logger.debug('[happyMCP] Changing title to:', title);
            try {
                client.sendClaudeSessionMessage({
                    type: 'summary',
                    summary: title,
                    leafUuid: randomUUID()
                });
                return { success: true };
            } catch (error) {
                return { success: false, error: String(error) };
            }
        },
        sendImage: async (input: SendImageInput) => {
            logger.debug('[happyMCP] Sending image:', input.path);
            try {
                const batchId = input.batchId?.trim() || randomUUID();
                const archive = await archiveGeneratedImage({
                    path: input.path,
                    prompt: input.prompt,
                    batchId,
                    sessionId: client.sessionId,
                });
                const { ref, name, size, dims, motionPhoto } = await client.uploadImageAttachment(input.path);
                client.sendFileEvent(ref, name, size, dims, {
                    source: 'generated',
                    ...(input.prompt ? { prompt: input.prompt } : {}),
                    batchId,
                    localPath: archive.imagePath,
                    ...(motionPhoto ? { motionPhoto } : {}),
                });
                return { success: true };
            } catch (error) {
                return { success: false, error: String(error) };
            }
        },
        sendFile: async (input: SendFileInput) => {
            logger.debug('[happyMCP] Sending file:', input.path);
            try {
                const uploaded = await client.uploadMediaAttachment(input.path, input.mimeType);
                client.sendFileEvent(uploaded.ref, uploaded.name, uploaded.size, null, {
                    source: 'generated',
                    kind: uploaded.kind,
                    mimeType: uploaded.mimeType,
                    encrypted: false,
                    localPath: input.path,
                });
                return { success: true };
            } catch (error) {
                return { success: false, error: String(error) };
            }
        },
        reportBrowserStep: async (input: BrowserStepInput) => {
            logger.debug('[happyMCP] Reporting browser step:', input.label, input.path);
            try {
                const uploaded = await client.uploadImageAttachment(input.path);
                client.sendFileEvent(uploaded.ref, uploaded.name, uploaded.size, uploaded.dims, {
                    source: 'browser_step',
                    browserStep: { label: input.label.trim() },
                });
                return { success: true };
            } catch (error) {
                return { success: false, error: String(error) };
            }
        },
        archiveSession: async (reason?: string) => {
            logger.debug('[happyMCP] Archiving current session:', reason);
            if (!options?.archiveSession) {
                return { success: false, error: 'Archive handler is not configured' };
            }
            return options.archiveSession(reason);
        },
        financeChart: async (input) => {
            logger.debug('[happyMCP] Fetching finance chart:', input);
            try {
                const data = await fetchFinanceChart(input);
                return { success: true, data };
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) };
            }
        },
    };

    const server = createServer(async (req, res) => {
        const mcp = createMcpServer(handlers);
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            res.on('close', () => {
                transport.close();
                mcp.close();
            });
        } catch (error) {
            logger.debug("Error handling request:", error);
            if (!res.headersSent) {
                res.writeHead(500).end();
            }
            mcp.close();
        }
    });

    const baseUrl = await new Promise<URL>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as AddressInfo;
            resolve(new URL(`http://127.0.0.1:${addr.port}`));
        });
    });

    logger.debug(`[happyMCP] server:ready sessionId=${client.sessionId} url=${baseUrl.toString()}`);

    return {
        url: baseUrl.toString(),
        toolNames: [
            'change_title',
            'send_image',
            'send_file',
            'report_browser_step',
            'archive_session',
            'finance_chart',
        ],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            server.close();
        }
    }
}

async function archiveGeneratedImage(input: {
    path: string;
    prompt?: string;
    batchId: string;
    sessionId: string;
}): Promise<{ imagePath: string; manifestPath: string }> {
    const day = new Date().toISOString().slice(0, 10);
    const batchDir = join(configuration.generatedImagesDir, day, sanitizePathSegment(input.batchId));
    const outputDir = join(batchDir, 'outputs');
    await fs.mkdir(outputDir, { recursive: true });

    const originalName = basename(input.path);
    const imageName = `${Date.now()}-${sanitizeFileName(originalName || 'image.png')}`;
    const imagePath = join(outputDir, imageName);
    await fs.copyFile(input.path, imagePath);

    if (input.prompt?.trim()) {
        await fs.writeFile(join(batchDir, 'prompt.md'), input.prompt.trim() + '\n', 'utf8');
    }

    const manifestPath = join(batchDir, 'manifest.json');
    const existing = await readGeneratedImageManifest(manifestPath);
    const now = new Date().toISOString();
    const manifest = {
        version: 1,
        batchId: input.batchId,
        sessionId: input.sessionId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        prompt: input.prompt ?? existing?.prompt,
        outputs: [
            ...(Array.isArray(existing?.outputs) ? existing.outputs : []),
            {
                path: imagePath,
                originalPath: input.path,
                filename: imageName,
                createdAt: now,
            },
        ],
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return { imagePath, manifestPath };
}

async function readGeneratedImageManifest(path: string): Promise<any | null> {
    try {
        return JSON.parse(await fs.readFile(path, 'utf8'));
    } catch {
        return null;
    }
}

function sanitizePathSegment(value: string): string {
    return sanitizeFileName(value).replace(/^\.+$/, 'batch');
}

function sanitizeFileName(value: string): string {
    return value.replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'image';
}
