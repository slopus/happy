import { log } from "@/utils/log";
import { Fastify } from "../types";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveUiConfig } from "@/app/api/uiConfig";

export function enableErrorHandlers(app: Fastify) {
    // Global error handler
    app.setErrorHandler(async (error, request, reply) => {
        const method = request.method;
        const url = request.url;
        const userAgent = request.headers['user-agent'] || 'unknown';
        const ip = request.ip || 'unknown';

        // Log the error with comprehensive context
        log({
            module: 'fastify-error',
            level: 'error',
            method,
            url,
            userAgent,
            ip,
            statusCode: error.statusCode || 500,
            errorCode: error.code,
            stack: error.stack
        }, `Unhandled error: ${error.message}`);

        // Return appropriate error response
        const statusCode = error.statusCode || 500;

        if (statusCode >= 500) {
            // Internal server errors - don't expose details
            return reply.code(statusCode).send({
                error: 'Internal Server Error',
                message: 'An unexpected error occurred',
                statusCode
            });
        } else {
            // Client errors - can expose more details
            return reply.code(statusCode).send({
                error: error.name || 'Error',
                message: error.message || 'An error occurred',
                statusCode
            });
        }
    });

    const ui = resolveUiConfig(process.env);
    const uiDirRaw = ui.dir ?? '';
    const uiMountedAtRoot = ui.mountRoot;

    let cachedIndexHtml: { html: string; mtimeMs: number } | null = null;
    const rootDir = uiDirRaw ? resolve(uiDirRaw) : '';

    async function serveSpaIndex(reply: any): Promise<any> {
        if (!uiDirRaw) {
            return reply.code(404).send({ error: 'Not found' });
        }

        const indexPath = join(rootDir, 'index.html');
        const st = await stat(indexPath);
        const mtimeMs = typeof st.mtimeMs === 'number' ? st.mtimeMs : st.mtime.getTime();
        if (!cachedIndexHtml || cachedIndexHtml.mtimeMs !== mtimeMs) {
            cachedIndexHtml = {
                html: (await readFile(indexPath, 'utf-8')) + '\n<!-- Welcome to Happy Server! -->\n',
                mtimeMs,
            };
        }
        reply.header('content-type', 'text/html; charset=utf-8');
        reply.header('cache-control', 'no-cache');
        return reply.send(cachedIndexHtml.html);
    }

    // Catch-all route: in UI-root mode, SPA fallback for unknown GET routes.
    // Otherwise keep strict 404 with extra logging.
    app.setNotFoundHandler(async (request, reply) => {
        const url = request.url || '';

        if (uiDirRaw && uiMountedAtRoot && request.method === 'GET') {
            // Don't SPA-fallback for API and asset paths.
            if (
                url.startsWith('/v1/') ||
                url === '/v1' ||
                url.startsWith('/files/') ||
                url === '/files' ||
                url.startsWith('/_expo/') ||
                url.startsWith('/assets/') ||
                url.startsWith('/.well-known/') ||
                url === '/favicon.ico' ||
                url === '/favicon-active.ico' ||
                url === '/canvaskit.wasm' ||
                url === '/metadata.json' ||
                url === '/health' ||
                url.startsWith('/metrics')
            ) {
                // Fall through to 404 logging below
            } else {
                return await serveSpaIndex(reply);
            }
        }

        log({ module: '404-handler' }, `404 - Method: ${request.method}, Path: ${request.url}, Headers: ${JSON.stringify(request.headers)}`);
        return reply.code(404).send({ error: 'Not found', path: request.url, method: request.method });
    });

    // Error hook for additional logging
    app.addHook('onError', async (request, reply, error) => {
        const method = request.method;
        const url = request.url;
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;

        log({
            module: 'fastify-hook-error',
            level: 'error',
            method,
            url,
            duration,
            statusCode: reply.statusCode || error.statusCode || 500,
            errorName: error.name,
            errorCode: error.code
        }, `Request error: ${error.message}`);
    });

    // Handle uncaught exceptions in routes
    app.addHook('preHandler', async (request, reply) => {
        // Store original reply.send to catch errors in response serialization
        const originalSend = reply.send.bind(reply);
        reply.send = function (payload: any) {
            try {
                return originalSend(payload);
            } catch (error: any) {
                log({
                    module: 'fastify-serialization-error',
                    level: 'error',
                    method: request.method,
                    url: request.url,
                    stack: error.stack
                }, `Response serialization error: ${error.message}`);
                throw error;
            }
        };
    });
}
