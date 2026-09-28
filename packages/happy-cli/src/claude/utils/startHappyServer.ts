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
import { tmpdir } from 'node:os';
import { readBrowserStepEvidence } from '@/browser/browserStepEvidence';
import { BROWSER_STEP_TOOL_DESCRIPTION, BROWSER_STEP_CAPTURE_MODULE_URL, browserCaptureSessionInstruction } from "@/browser/browserStepReportingPrompt";
import { configuration } from "@/configuration";
import { fetchFinanceChart } from "@/finance/financeChart";
import { PreviewWorkspaceRegistry } from "@/previews/previewWorkspace";
import { startCloudflarePreview } from '@/previews/cloudflarePreview';
import { SessionPreviewSlots, type SessionPreviewStatus } from '@/previews/sessionPreviewSlots';

type HappyMcpHandlers = {
    browserSessionId: string;
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
    createPreview: (title: string) => Promise<{ success: boolean; previewId?: string; path?: string; error?: string }>;
    publishPreview: (previewId: string, mode?: 'tunnel' | 'hosted') => Promise<{ success: boolean; url?: string; expiresAt?: number; provider?: 'cloudflare'; mode?: 'tunnel' | 'hosted'; lifetime?: string; error?: string }>;
    listPreviews: () => Promise<SessionPreviewStatus>;
    closePreview: (previewId: string) => Promise<{ success: boolean; status: SessionPreviewStatus; error?: string }>;
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

export type BrowserStepInput = {
    path: string;
    label: string;
    runId: string;
    skillName: 'ego-browser' | 'ego-ops';
};

type BrowserStepReporter = (input: BrowserStepInput) => Promise<{ success: boolean; error?: string }>;

export function registerBrowserStepTool(mcp: McpServer, reportBrowserStep: BrowserStepReporter, sessionId?: string): void {
    mcp.registerTool('report_browser_step', {
        description: BROWSER_STEP_TOOL_DESCRIPTION + (sessionId ? '\n' + browserCaptureSessionInstruction(sessionId) : ''),
        title: 'Report Browser Step',
        inputSchema: {
            path: z.string().describe('Absolute path to the browser screenshot (PNG/JPEG)'),
            label: z.string().trim().min(1).describe('Short description of the operation that just completed'),
            runId: z.string().trim().min(1).max(128).describe('Unique task identifier reused across Ego commands in this session'),
            skillName: z.enum(['ego-browser', 'ego-ops']).describe('Ego skill associated with this browser task'),
        },
    }, async (args) => {
        const response = await reportBrowserStep({
            path: args.path,
            label: args.label,
            runId: args.runId,
            skillName: args.skillName,
        });
        logger.debug('[happyMCP] Response:', response);
        return response.success
            ? { content: [{ type: 'text', text: `Reported browser step: ${args.label}` }], isError: false }
            : { content: [{ type: 'text', text: `Failed to report browser step: ${response.error || 'Unknown error'}` }], isError: true };
    });
}

export function createBrowserStepReporter(client: Pick<ApiSessionClient, 'sessionId' | 'uploadImageAttachment' | 'sendFileEvent'>): BrowserStepReporter {
    const taskByRun = new Map<string, string>();
    const reportedPaths = new Set<string>();
    return async (input) => {
        logger.debug('[happyMCP] Reporting browser step:', input.label, input.path);
        let uploadDirectory: string | undefined;
        let reserved = false;
        try {
            if (/^ego-browser-shot-\d+-\d+\.(png|jpe?g)$/i.test(basename(input.path))) {
                throw new Error('Shared Ego screenshot files can be overwritten by another task. Recapture with captureVerifiedBrowserStep from ' + BROWSER_STEP_CAPTURE_MODULE_URL + ' inside the same Ego round; report its unique path. Do not rename or copy the shared file.');
            }
            const { bytes, evidence } = await readBrowserStepEvidence(input, client.sessionId);
            const taskKey = JSON.stringify([evidence.taskSpaceId, evidence.skillName]);
            const existing = taskByRun.get(input.runId);
            if (existing && existing !== taskKey) throw new Error('This runId is already bound to another Ego task space');
            if (reportedPaths.has(input.path)) throw new Error('This browser frame was already reported; capture a new key step');
            taskByRun.set(input.runId, taskKey);
            reportedPaths.add(input.path);
            reserved = true;
            // Upload the verified bytes, never re-open an agent-controlled path after validation.
            uploadDirectory = await fs.mkdtemp(join(tmpdir(), 'paws-browser-upload-'));
            const uploadPath = join(uploadDirectory, 'screenshot.png');
            await fs.writeFile(uploadPath, bytes, { flag: 'wx', mode: 0o600 });
            const uploaded = await client.uploadImageAttachment(uploadPath);
            client.sendFileEvent(uploaded.ref, uploaded.name, uploaded.size, uploaded.dims, {
                source: 'browser_step',
                browserStep: {
                    label: input.label.trim(),
                    ...(input.runId ? { runId: input.runId } : {}),
                    ...(input.skillName ? { skillName: input.skillName } : {}),
                },
            });
            return { success: true };
        } catch (error) {
            if (reserved) reportedPaths.delete(input.path);
            return { success: false, error: String(error) };
        } finally {
            if (uploadDirectory) await fs.rm(uploadDirectory, { recursive: true, force: true });
        }
    };
}

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

    registerBrowserStepTool(mcp, handlers.reportBrowserStep, handlers.browserSessionId);

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

    mcp.registerTool('create_preview', {
        description: 'Create an empty, Happy-managed workspace for a static HTML/CSS/JS interaction draft. Write only public, non-sensitive preview files into the returned directory, then call publish_preview.',
        title: 'Create Interactive Preview',
        inputSchema: { title: z.string().trim().min(1).max(160) },
    }, async ({ title }) => {
        const response = await handlers.createPreview(title);
        return response.success
            ? { content: [{ type: 'text', text: JSON.stringify({ previewId: response.previewId, workspacePath: response.path, next: 'Write the static files, then call publish_preview with previewId.' }) }] }
            : { content: [{ type: 'text', text: `Failed to create preview: ${response.error}` }], isError: true };
    });

    mcp.registerTool('publish_preview', {
        description: 'Publish a Happy-managed static preview. Cloudflare mode: tunnel (default, no login, requires cloudflared, session lifetime up to 24 hours) or hosted (connected Cloudflare Pages account, 24 hours, survives local shutdown). Links are public.',
        title: 'Publish Interactive Preview',
        inputSchema: { previewId: z.string().uuid(), mode: z.enum(['tunnel', 'hosted']).optional() },
    }, async ({ previewId, mode }) => {
        const response = await handlers.publishPreview(previewId, mode);
        return response.success
            ? { content: [{ type: 'text', text: JSON.stringify({ url: response.url, expiresAt: response.expiresAt, provider: 'cloudflare', mode: response.mode ?? mode ?? 'tunnel', lifetime: response.lifetime ?? '24 hours' }) }] }
            : { content: [{ type: 'text', text: `Failed to publish preview: ${response.error}` }], isError: true };
    });

    mcp.registerTool('list_previews', {
        description: 'List active Cloudflare tunnel previews owned by this Happy session and show used, remaining, and maximum tunnel slots. Cloud-hosted previews do not occupy these slots.',
        title: 'List Session Previews',
        inputSchema: {},
    }, async () => ({ content: [{ type: 'text', text: JSON.stringify(await handlers.listPreviews()) }] }));

    mcp.registerTool('close_preview', {
        description: 'Stop one active Cloudflare tunnel preview in this Happy session and release its slot. This immediately invalidates its public link. Use only when the user asks to close that preview.',
        title: 'Close Session Preview',
        inputSchema: { previewId: z.string().uuid() },
    }, async ({ previewId }) => {
        const response = await handlers.closePreview(previewId);
        return response.success
            ? { content: [{ type: 'text', text: JSON.stringify({ closed: previewId, ...response.status }) }] }
            : { content: [{ type: 'text', text: `Failed to close preview: ${response.error}` }], isError: true };
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
    const previewWorkspaces = new PreviewWorkspaceRegistry();
    const previewSlots = new SessionPreviewSlots((expired) => client.reportInteractivePreview(expired));
    const hostedPreviews = new Map<string, { url: string; expiresAt?: number }>();
    const previewAbort = new AbortController();
    let previewCloseRegistered = false;
    const stopCloudflarePreviews = (): void => {
        previewAbort.abort();
        previewSlots.stopAll();
        if (previewCloseRegistered) client.removeListener('before-close', stopCloudflarePreviews);
        previewCloseRegistered = false;
    };

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
        browserSessionId: client.sessionId,
        reportBrowserStep: createBrowserStepReporter(client),
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
        createPreview: async (title) => {
            try {
                const workspace = await previewWorkspaces.create(client.sessionId, title);
                return { success: true, previewId: workspace.previewId, path: workspace.path };
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) };
            }
        },
        publishPreview: async (previewId, mode = 'tunnel') => {
            const hosted = hostedPreviews.get(previewId);
            if (hosted) {
                if (mode !== 'hosted') return { success: false, error: 'This preview is cloud hosted. Create a new workspace for a tunnel.' };
                if (hosted.expiresAt && hosted.expiresAt <= Date.now()) return { success: false, error: 'Preview expired. Create a new workspace.' };
                return { success: true, ...hosted, provider: 'cloudflare', mode, lifetime: '24 hours (cloud hosted)' };
            }
            const existing = previewSlots.get(previewId);
            if (existing) return mode === 'tunnel'
                ? { success: true, url: existing.preview.url, expiresAt: existing.preview.expiresAt, provider: 'cloudflare', mode, lifetime: 'session (at most 24 hours)' }
                : { success: false, error: 'This preview already uses a tunnel. Create a new workspace for cloud hosting.' };
            if (previewSlots.hasPublication(previewId)) return { success: false, error: 'Preview publication is already in progress' };
            if (previewAbort.signal.aborted) return { success: false, error: 'Preview session has stopped' };
            if (!previewSlots.reserve(previewId, mode)) {
                const { used, limit, publishing } = previewSlots.status();
                const pending = publishing ? ` ${publishing} publication${publishing === 1 ? ' is' : 's are'} still starting; wait for ${publishing === 1 ? 'it' : 'them'} to finish.` : '';
                return { success: false, error: `${used}/${limit} Cloudflare tunnel preview slots are in use.${pending} Use list_previews to see active previews and close_preview to close one when the user asks.` };
            }
            try {
                const workspace = await previewWorkspaces.resolveForPublish(client.sessionId, previewId);
                if (mode === 'tunnel') {
                    const running = await startCloudflarePreview(workspace, (expired) => previewSlots.expired(previewId, expired), previewAbort.signal);
                    previewSlots.add(previewId, running);
                    if (!previewCloseRegistered) {
                        client.once('before-close', stopCloudflarePreviews);
                        previewCloseRegistered = true;
                    }
                    client.reportInteractivePreview(running.preview);
                    await previewWorkspaces.remove(client.sessionId, previewId);
                    return { success: true, url: running.preview.url, expiresAt: running.preview.expiresAt, provider: 'cloudflare', mode, lifetime: 'session (at most 24 hours)' };
                }
                const preview = await client.publishInteractivePreview(workspace);
                if (preview.state !== 'ready' || !preview.url) {
                    return { success: false, error: 'Cloud hosting has not become ready. Retry this preview to check its publication; do not create another deployment.' };
                }
                hostedPreviews.set(previewId, { url: preview.url, expiresAt: preview.expiresAt });
                await previewWorkspaces.remove(client.sessionId, previewId);
                return { success: true, url: preview.url, expiresAt: preview.expiresAt, provider: 'cloudflare', mode, lifetime: '24 hours (cloud hosted)' };
            } catch (error) {
                return { success: false, error: error instanceof Error ? error.message : String(error) };
            } finally {
                previewSlots.finishPublication(previewId);
            }
        },
        listPreviews: async () => previewSlots.status(),
        closePreview: async (previewId) => {
            const closed = previewSlots.close(previewId);
            return closed
                ? { success: true, status: previewSlots.status() }
                : { success: false, status: previewSlots.status(), error: 'No active tunnel preview with this ID belongs to this session.' };
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
            'create_preview',
            'publish_preview',
            'list_previews',
            'close_preview',
        ],
        stop: () => {
            logger.debug(`[happyMCP] server:stop sessionId=${client.sessionId}`);
            stopCloudflarePreviews();
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
