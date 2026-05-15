import fastify from "fastify";
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
import { enableErrorHandlers } from "./utils/enableErrorHandlers";
import { enableAuthentication } from "./utils/enableAuthentication";
import { userRoutes } from "./routes/userRoutes";
import { feedRoutes } from "./routes/feedRoutes";
import { kvRoutes } from "./routes/kvRoutes";
import { v3SessionRoutes } from "./routes/v3SessionRoutes";
import { attachmentRoutes } from "./routes/attachmentRoutes";
import { isLocalStorage, getLocalFilesDir } from "@/storage/files";
import * as path from "path";
import * as fs from "fs";

export interface StartApiOptions {
    port?: number;
    host?: string;
    staticDir?: string;
    injectHtmlConfig?: Record<string, unknown>;
}

export async function startApi(opts: StartApiOptions = {}) {

    // Configure
    log('Starting API...');

    // Start API
    const app = fastify({
        loggerInstance: logger,
        bodyLimit: 1024 * 1024 * 100, // 100MB
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

    // Serve local files when using local storage
    if (isLocalStorage()) {
        app.get('/files/*', function (request, reply) {
            const filePath = (request.params as any)['*'];
            const baseDir = path.resolve(getLocalFilesDir());
            const fullPath = path.resolve(baseDir, filePath);
            if (!fullPath.startsWith(baseDir + path.sep)) {
                reply.code(403).send('Forbidden');
                return;
            }
            if (!fs.existsSync(fullPath)) {
                reply.code(404).send('Not found');
                return;
            }
            const stream = fs.createReadStream(fullPath);
            reply.send(stream);
        });
    }

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
        if (injectScript) {
            app.addHook('onSend', async (request, reply, payload) => {
                const url = request.raw.url || '';
                const isIndex = url === '/' || url === '/index.html' || url.startsWith('/?');
                if (!isIndex) return payload;
                const contentType = reply.getHeader('content-type');
                if (typeof contentType !== 'string' || !contentType.includes('text/html')) return payload;
                let html: string;
                if (typeof payload === 'string') {
                    html = payload;
                } else if (Buffer.isBuffer(payload)) {
                    html = payload.toString('utf8');
                } else if (payload && typeof (payload as any).pipe === 'function') {
                    // stream — read it
                    const chunks: Buffer[] = [];
                    for await (const chunk of payload as any) {
                        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
                    }
                    html = Buffer.concat(chunks).toString('utf8');
                } else {
                    return payload;
                }
                const injected = html.replace(/<head[^>]*>/i, (m) => `${m}\n${injectScript}`);
                reply.header('content-length', Buffer.byteLength(injected));
                return injected;
            });
        }
        // SPA fallback: serve index.html for any unmatched GET that looks like a route.
        app.setNotFoundHandler(async (request, reply) => {
            const url = request.raw.url || '';
            // Don't fall through for API/socket/files paths
            if (request.method !== 'GET') return reply.code(404).send({ error: 'Not found' });
            if (url.startsWith('/v1') || url.startsWith('/v3') || url.startsWith('/socket') ||
                url.startsWith('/files/') || url.startsWith('/metrics') || url.startsWith('/health')) {
                return reply.code(404).send({ error: 'Not found' });
            }
            const indexPath = path.join(opts.staticDir!, 'index.html');
            if (!fs.existsSync(indexPath)) {
                return reply.code(404).send({ error: 'Not found' });
            }
            const html = fs.readFileSync(indexPath, 'utf8');
            const injected = injectScript ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${injectScript}`) : html;
            reply.type('text/html').send(injected);
        });
    }

    // Start HTTP
    const port = opts.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 3005);
    const host = opts.host ?? '0.0.0.0';
    await app.listen({ port, host });
    onShutdown('api', async () => {
        await app.close();
    });

    // Start Socket
    startSocket(typed);

    // End
    log(`API ready on http://${host}:${port}`);
    return { port, host };
}
