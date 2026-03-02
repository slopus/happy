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
import { remoteRoutes } from "./routes/remoteRoutes";
import { sessionImageRoutes } from "./routes/sessionImageRoutes";
import { sessionDocumentRoutes } from "./routes/sessionDocumentRoutes";
import { shareRoutes } from "./routes/shareRoutes";
import { isLocalStorage, getLocalFilesDir, s3client, s3bucket } from "@/storage/files";
import * as path from "path";
import * as fs from "fs";

export async function startApi() {

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
        methods: ['GET', 'POST', 'DELETE', 'PATCH', 'PUT']
    });
    // Accept raw binary body for image and document uploads
    app.addContentTypeParser([
        'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
        'application/pdf', 'application/octet-stream',
    ], { parseAs: 'buffer' }, (req, body, done) => {
        done(null, body);
    });

    // Accept text-based document uploads as raw buffer
    app.addContentTypeParser([
        'text/plain', 'text/csv', 'text/markdown', 'text/html', 'text/xml',
        'text/x-python', 'text/x-python-script', 'text/javascript', 'text/typescript',
        'text/x-java', 'text/x-c', 'text/x-csrc', 'text/x-c++', 'text/x-c++src',
        'text/x-go', 'text/x-rust', 'text/x-ruby', 'text/x-php',
        'text/x-swift', 'text/x-kotlin', 'text/x-yaml', 'text/x-sh',
        'application/x-yaml', 'application/yaml', 'application/xml',
        'application/x-sh', 'application/x-python',
        'application/javascript', 'application/typescript',
    ], { parseAs: 'buffer' }, (req, body, done) => {
        done(null, body);
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

    // Serve files: local filesystem or S3 proxy
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
    } else {
        // Proxy /files/* to MinIO/S3 for serving uploaded files
        app.get('/files/*', async (request, reply) => {
            const filePath = (request.params as any)['*'];
            if (!filePath) {
                return reply.code(400).send({ error: 'No path specified' });
            }
            try {
                const stream = await s3client.getObject(s3bucket, filePath);
                reply.header('Cache-Control', 'public, max-age=31536000, immutable');
                reply.header('Access-Control-Allow-Origin', '*');
                return reply.send(stream);
            } catch (e: any) {
                if (e.code === 'NoSuchKey') {
                    return reply.code(404).send({ error: 'File not found' });
                }
                return reply.code(500).send({ error: 'Failed to retrieve file' });
            }
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
    remoteRoutes(typed);
    sessionImageRoutes(typed);
    sessionDocumentRoutes(typed);
    shareRoutes(typed);

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
