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
import { internalFeedRoutes } from "./routes/internalFeedRoutes";
import { kvRoutes } from "./routes/kvRoutes";
import { v3SessionRoutes } from "./routes/v3SessionRoutes";
import { v3SessionEventRoutes } from "./routes/v3SessionEventRoutes";
import { projectRoutes } from "./routes/projectRoutes";
import { projectMemberRoutes } from "./routes/projectMemberRoutes";
import { workspaceRoutes } from "./routes/workspaceRoutes";
import { mergeRequestRoutes } from "./routes/mergeRequestRoutes";
import { previewRoutes } from "./routes/previewRoutes";
import { parsePreviewHost } from "@/modules/preview/parsePreviewHost";
import { isLocalStorage, getLocalFilesDir } from "@/storage/files";
import * as path from "path";
import * as fs from "fs";

export async function startApi() {

    // Configure
    log('Starting API...');

    // Start API
    const app = fastify({
        loggerInstance: logger,
        bodyLimit: 1024 * 1024 * 100, // 100MB,
        // specs/preview-iframe-origin-isolation-subdomain Phase 3 fix —
        // Fastify lifecycle runs routing BEFORE onRequest hooks, so a hook
        // that mutates `request.raw.url` cannot redirect routing decisions.
        // rewriteUrl runs *before* the router, which is what we need: when
        // the iframe Host is `<mid>-<port>.preview.<zone>`, rewrite the URL
        // into the canonical `/v1/preview/{mid}/{port}/<app-path>` shape
        // so the existing preview route picks it up.
        rewriteUrl: (req) => {
            const host = req.headers.host;
            const parsed = parsePreviewHost(host);
            if (!parsed) return req.url ?? '/';
            const url = req.url ?? '/';
            const qIdx = url.indexOf('?');
            const rawPath = qIdx >= 0 ? url.slice(0, qIdx) : url;
            const search = qIdx >= 0 ? url.slice(qIdx) : '';
            const trimmed = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
            return `/v1/preview/${parsed.machineId}/${parsed.port}/${trimmed}${search}`;
        },
    });
    app.register(import('@fastify/cors'), {
        origin: '*',
        allowedHeaders: '*',
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
    });
    app.get('/', function (request, reply) {
        reply.send('Welcome to Happy Server!');
    });

    // Create typed provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    // Enable features
    enableMonitoring(typed);
    enableErrorHandlers(typed);
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
    internalFeedRoutes(typed);
    kvRoutes(typed);
    v3SessionRoutes(typed);
    v3SessionEventRoutes(typed);
    projectRoutes(typed);
    projectMemberRoutes(typed);
    workspaceRoutes(typed);
    mergeRequestRoutes(typed);
    previewRoutes(typed);

    // Start HTTP
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
    await app.listen({ port, host: '0.0.0.0' });
    onShutdown('api', async () => {
        await app.close();
    });

    // Start Socket
    startSocket(typed);

    // End
    log('API ready on port http://localhost:' + port);
}
