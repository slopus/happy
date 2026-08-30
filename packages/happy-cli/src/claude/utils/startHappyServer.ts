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
import { captureScreenshot, type ScreenshotTarget } from "@/utils/screenshot";
import { type ScreenshotStore, type ScreenshotRef } from "@/utils/screenshotStore";
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

/** 带外图库三工具的依赖注入接口（便于纯函数单测，且给 Task 2.2/3.1 留注入点） */
export interface ScreenshotToolDeps {
    /** 会话内临时缓存（Task 3.1 的会话级 RPC 共享同一实例） */
    store: ScreenshotStore;
    /** 真截图，返回 { path: 图片绝对路径, capturedTarget: 实际截取目标 } */
    capture: (t: ScreenshotTarget) => Promise<{ path: string; capturedTarget: ScreenshotTarget }>;
    /** 读图为 base64（这一刻才会进上下文） */
    readBase64: (p: string) => Promise<string>;
    /** 截图存库后通知 App（Task 2.2 注入真实 updateMetadata；本任务默认 no-op） */
    signalNewScreenshot: (refs: ScreenshotRef[]) => void;
    now: () => number;
}

/**
 * 带外图库核心：把 take/get/list 的逻辑抽成纯工厂，便于单测。
 * take 只返回文本引用（图不进上下文）；get 才把字节作为 image 内容取回。
 */
export function createScreenshotTools(deps: ScreenshotToolDeps) {
    return {
        // 截图 → 存库 → 通知 App → 只返回文本引用（无字节）
        take: async ({ target, note }: { target?: ScreenshotTarget; note?: string }) => {
            const { path: filePath } = await deps.capture(target ?? 'desktop');
            const ref = deps.store.add({ filePath, target: target ?? 'desktop', note, takenAt: deps.now() });
            deps.signalNewScreenshot(deps.store.list());
            return `已截图 #${ref.id} [${ref.target}] ${note ? `note:"${note}" ` : ''}` +
                `已存入图库（未进上下文）。需要分析时调 get_screenshot({ id: "${ref.id}" })。`;
        },
        // 按 id 把某张图取进上下文
        get: async ({ id }: { id: string }) => {
            const fp = deps.store.getFilePath(id);
            if (!fp) throw new Error(`screenshot #${id} not found`);
            return { base64: await deps.readBase64(fp), mimeType: 'image/png' as const };
        },
        // 列出轻量引用（不含字节）
        list: async () => deps.store.list(),
    };
}

function createMcpServer(handlers: HappyMcpHandlers, screenshotTools: ReturnType<typeof createScreenshotTools>): McpServer {
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

    // 带外图库：take 只回文本引用、图不进上下文；get 才把字节取进上下文
    mcp.registerTool('take_screenshot', {
        description: '截取桌面或最前浏览器窗口的截图，存入“带外图库”。图片不会进入对话上下文，只返回一个轻量文本引用；需要真正查看/分析某张时再调 get_screenshot。',
        title: 'Take Screenshot',
        inputSchema: {
            target: z.enum(['desktop', 'browser']).describe('desktop=整屏, browser=最前浏览器窗口'),
            note: z.string().optional().describe('给这张截图的备注，便于以后引用'),
        },
    }, async (args) => ({
        content: [{ type: 'text', text: await screenshotTools.take(args) }],
    }));

    mcp.registerTool('get_screenshot', {
        description: '按 id 把图库里某张截图取进当前上下文以供分析（这一刻才消耗上下文）。',
        title: 'Get Screenshot',
        inputSchema: {
            id: z.string().describe('图库里截图的 id（来自 take_screenshot / list_screenshots）'),
        },
    }, async (args) => {
        // 与 change_title/send_image 一致：捕获错误返回 isError 文本，给 AI 干净的错误而非 HTTP 500
        try {
            const { base64, mimeType } = await screenshotTools.get(args);
            return { content: [{ type: 'image', data: base64, mimeType }] };
        } catch (error) {
            return {
                content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
                isError: true,
            };
        }
    });

    mcp.registerTool('list_screenshots', {
        description: '列出当前会话图库里已有截图的轻量引用（id/来源/时间/备注），不含图片本身。',
        title: 'List Screenshots',
        inputSchema: {},
    }, async () => ({
        content: [{ type: 'text', text: JSON.stringify(await screenshotTools.list()) }],
    }));

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

    // 会话内截图临时缓存：复用 client 持有的同一实例（构造时已 new），
    // 这样 MCP take 工具与会话级 RPC getScreenshotById 共享同一 store，时序无忧。
    const screenshotStore = client.screenshotStore;
    // Task 2.2：每次 take 后，把当前所有截图的轻量引用 + 版本号写进 session metadata。
    // CLI 不能直接 push 给 App，但服务器会把 metadata 更新自动推给 App，App 据此懒拉取（Task 3.1）。
    // 只写轻量引用（id/来源/备注/时间），不写图片字节——几十条无体积压力。
    const signalNewScreenshot = (refs: ScreenshotRef[]) => {
        client.updateMetadata((prev) => ({
            ...prev,
            screenshotRefs: refs,
            // 版本号在上次值基础上 +1，不依赖 refs.length。prev 来自服务端当前
            // metadata，天然跨进程单调——CLI 重启/续接同一 session 时不会回退，
            // 避免 App 误判「版本没变大」而永不拉新图。
            screenshotVersion: (prev.screenshotVersion ?? 0) + 1,
        }));
    };
    const screenshotTools = createScreenshotTools({
        store: screenshotStore,
        capture: captureScreenshot,
        readBase64: (p: string) => fs.readFile(p, 'base64'),
        signalNewScreenshot,
        now: () => Date.now(),
    });

    const server = createServer(async (req, res) => {
        const mcp = createMcpServer(handlers, screenshotTools);
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
            'take_screenshot',
            'get_screenshot',
            'list_screenshots',
            'archive_session',
            'finance_chart',
        ],
        // 暴露给 Task 3.1：会话级 RPC 的 getScreenshotById 复用同一实例
        screenshotStore,
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
