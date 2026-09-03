import fastify from "fastify";
import type { FastifyBaseLogger } from 'fastify';
import { log, logger } from "@/utils/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { authRoutes } from "./routes/authRoutes";
import { pushRoutes } from "./routes/pushRoutes";
import { sessionRoutes } from "./routes/sessionRoutes";
import { connectRoutes } from "./routes/connectRoutes";
import { accountRoutes } from "./routes/accountRoutes";
import { startSocket } from "./socket";
import { machinesRoutes } from "./routes/machinesRoutes";
import { devRoutes } from "./routes/devRoutes";
import { versionRoutes } from "./routes/versionRoutes";
import { voiceRoutes } from "./routes/voiceRoutes";
import { artifactsRoutes } from "./routes/artifactsRoutes";
import { accessKeysRoutes } from "./routes/accessKeysRoutes";
import { enableMonitoring } from "./utils/enableMonitoring";
import { enableErrorHandlers, handleFrameworkError } from "./utils/enableErrorHandlers";
import {
    isPublicSessionShareApiUrl,
    publicSessionShareNotFound,
} from '@/app/sessionSharing/publicSessionShareHttp';
import { enableAuthentication } from "./utils/enableAuthentication";
import { userRoutes } from "./routes/userRoutes";
import { feedRoutes } from "./routes/feedRoutes";
import { kvRoutes } from "./routes/kvRoutes";
import { v3SessionRoutes } from "./routes/v3SessionRoutes";
import { attachmentRoutes } from "./routes/attachmentRoutes";
import { fileRoutes } from "./routes/fileRoutes";
import { relationshipAdvisorRoutes } from "./routes/relationshipAdvisorRoutes";
import { pluginRoutes } from "@/app/api/routes/pluginRoutes";
import { publicSessionShareRoutes } from "./routes/publicSessionShareRoutes";
import { externalSessionShareRoutes } from "./routes/externalSessionShareRoutes";
import { mcpAppSandboxRoutes } from "./routes/mcpAppSandboxRoutes";
import { isLiteralMcpAppSandboxRequestUrl } from './mcpAppSandboxHttp';
import * as path from "path";
import * as fs from "fs";

export interface StartApiOptions {
    port?: number;
    host?: string;
    staticDir?: string;
    injectHtmlConfig?: Record<string, unknown>;
    loggerInstance?: FastifyBaseLogger;
}

export function resolveTrustProxySetting(value = process.env.HAPPY_TRUST_PROXY_HOPS): false | number {
    if (!value) return false;
    const hops = Number.parseInt(value, 10);
    return Number.isSafeInteger(hops) && hops > 0 ? hops : false;
}

const PUBLIC_SHARE_DOCUMENT_CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "media-src 'self' blob: https: http:",
    "connect-src 'self' https: http:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
].join('; ');

export function isPublicShareDocumentUrl(url: string): boolean {
    const pathname = url.split('?', 1)[0];
    return /^\/share\/[^/]+\/?$/.test(pathname);
}

export function isSpaFallbackExcludedUrl(url: string): boolean {
    const pathname = url.split('?', 1)[0];
    return pathname.startsWith('/v1') || pathname.startsWith('/v3') || pathname.startsWith('/socket') ||
        pathname.startsWith('/files/') || pathname.startsWith('/metrics') || pathname.startsWith('/health') ||
        pathname === '/mcp-app-sandbox' || pathname.startsWith('/mcp-app-sandbox/');
}

export function getPublicShareDocumentHeaders(): Record<string, string> {
    return {
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': PUBLIC_SHARE_DOCUMENT_CSP,
        'Referrer-Policy': 'no-referrer',
    };
}

function securePublicShareDocument(reply: any): void {
    for (const [name, value] of Object.entries(getPublicShareDocumentHeaders())) reply.header(name, value);
}

function injectPublicShareMetadata(html: string): string {
    if (/name=["']robots["']/i.test(html)) return html;
    return html.replace(/<head[^>]*>/i, (head) => `${head}\n<meta name="robots" content="noindex,nofollow,noarchive">`);
}

export async function createApiApp(opts: StartApiOptions = {}): Promise<Fastify> {
    const app = fastify({
        loggerInstance: opts.loggerInstance ?? logger,
        bodyLimit: 1024 * 1024 * 100, // 100MB
        trustProxy: resolveTrustProxySetting(),
        frameworkErrors: handleFrameworkError,
        childLoggerFactory(parentLogger, bindings, loggerOptions, rawRequest) {
            const options = isLiteralMcpAppSandboxRequestUrl(rawRequest.url)
                ? { ...loggerOptions, level: 'silent' }
                : loggerOptions;
            return parentLogger.child(bindings, options);
        },
    });
    app.register(import('@fastify/cors'), {
        origin: '*',
        allowedHeaders: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE']
    });

    // Required for local-mode attachment uploads (PUT /v1/sessions/:id/attachments/:file).
    // Fastify v5 rejects unknown media types with 415 before reaching the handler.
    app.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer' },
        (_req, body, done) => done(null, body),
    );

    // Root handler — when not serving a static webapp, return a banner.
    // When serving a static webapp, @fastify/static handles `/` via its index.
    if (!opts.staticDir) {
        app.get('/', function (request, reply) {
            reply.send('Welcome to Happy Server!');
        });
    }

    // Create typed provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    // Enable features
    enableMonitoring(typed);
    enableErrorHandlers(typed, { skipNotFoundHandler: !!opts.staticDir });
    enableAuthentication(typed);

    fileRoutes(typed);

    // Routes
    authRoutes(typed);
    pushRoutes(typed);
    sessionRoutes(typed);
    accountRoutes(typed);
    connectRoutes(typed);
    machinesRoutes(typed);
    artifactsRoutes(typed);
    accessKeysRoutes(typed);
    devRoutes(typed);
    versionRoutes(typed);
    voiceRoutes(typed);
    userRoutes(typed);
    feedRoutes(typed);
    kvRoutes(typed);
    v3SessionRoutes(typed);
    attachmentRoutes(typed);
    relationshipAdvisorRoutes(typed);
    pluginRoutes(typed);
    publicSessionShareRoutes(typed);
    externalSessionShareRoutes(typed);
    mcpAppSandboxRoutes(typed);

    // Static webapp (self-host mode)
    if (opts.staticDir) {
        const fastifyStatic = (await import('@fastify/static')).default;
        const injectScript = opts.injectHtmlConfig
            ? `<script>window.__HAPPY_CONFIG__ = ${JSON.stringify(opts.injectHtmlConfig)};</script>`
            : null;
        app.register(fastifyStatic, {
            root: opts.staticDir,
            prefix: '/',
            decorateReply: false,
            // SPA fallback — if file not found, serve index.html
            wildcard: false,
        });
        app.addHook('onSend', async (request, reply, payload) => {
            const url = request.raw.url || '';
            const isIndex = url === '/' || url === '/index.html' || url.startsWith('/?');
            const isPublicShare = isPublicShareDocumentUrl(url);
            if (!isIndex && !isPublicShare) return payload;
            const contentType = reply.getHeader('content-type');
            if (typeof contentType !== 'string' || !contentType.includes('text/html')) return payload;
            let html: string;
            if (typeof payload === 'string') {
                html = payload;
            } else if (Buffer.isBuffer(payload)) {
                html = payload.toString('utf8');
            } else if (payload && typeof (payload as any).pipe === 'function') {
                const chunks: Buffer[] = [];
                for await (const chunk of payload as any) {
                    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
                }
                html = Buffer.concat(chunks).toString('utf8');
            } else {
                return payload;
            }
            let injected = injectScript ? html.replace(/<head[^>]*>/i, (head) => `${head}\n${injectScript}`) : html;
            if (isPublicShare) {
                securePublicShareDocument(reply);
                injected = injectPublicShareMetadata(injected);
            }
            reply.header('content-length', Buffer.byteLength(injected));
            return injected;
        });
        // SPA fallback: serve index.html for any unmatched GET that looks like a route.
        app.setNotFoundHandler(async (request, reply) => {
            const url = request.raw.url || '';
            if (isPublicSessionShareApiUrl(url)) return publicSessionShareNotFound(reply);
            // Don't fall through for API/socket/files paths
            if (request.method !== 'GET') return reply.code(404).send({ error: 'Not found' });
            if (isSpaFallbackExcludedUrl(url)) {
                return reply.code(404).send({ error: 'Not found' });
            }
            const indexPath = path.join(opts.staticDir!, 'index.html');
            if (!fs.existsSync(indexPath)) {
                return reply.code(404).send({ error: 'Not found' });
            }
            const html = fs.readFileSync(indexPath, 'utf8');
            const isPublicShare = isPublicShareDocumentUrl(url);
            const injected = injectScript && !isPublicShare
                ? html.replace(/<head[^>]*>/i, (head) => `${head}\n${injectScript}`)
                : html;
            reply.type('text/html').send(injected);
        });
    }

    return typed;
}

export async function startApi(opts: StartApiOptions = {}) {

    // Configure
    log('Starting API...');

    // Start API
    const app = await createApiApp(opts);

    // Start HTTP
    const port = opts.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3005);
    const host = opts.host ?? '0.0.0.0';
    await app.listen({ port, host });
    onShutdown('api', async () => {
        await app.close();
    });

    // Start Socket
    startSocket(app);

    // End
    log(`API ready on http://${host}:${port}`);
    return { port, host };
}
