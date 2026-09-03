import { log } from "@/utils/log";
import { Fastify } from "../types";
import { FastifyError } from "fastify";
import {
    isPublicSessionShareApiUrl,
    publicSessionShareNotFound,
} from '@/app/sessionSharing/publicSessionShareHttp';
import {
    isLiteralMcpAppSandboxRequestUrl,
    mcpAppSandboxNotFound,
} from '@/app/api/mcpAppSandboxHttp';

export interface EnableErrorHandlersOptions {
    skipNotFoundHandler?: boolean;
}

export function handleFrameworkError(error: FastifyError, request: any, reply: any) {
    if (isLiteralMcpAppSandboxRequestUrl(request.raw.url || request.url)) {
        return mcpAppSandboxNotFound(reply);
    }
    if (error.code === 'FST_ERR_BAD_URL'
        && isPublicSessionShareApiUrl(request.raw.url || request.url)) {
        return publicSessionShareNotFound(reply);
    }
    const statusCode = error.statusCode || 500;
    return reply.code(statusCode).send({
        error: error.name || 'Error',
        code: error.code,
        message: error.message || 'An error occurred',
        statusCode,
    });
}

export function enableErrorHandlers(app: Fastify, options: EnableErrorHandlersOptions = {}) {
    // Global error handler
    app.setErrorHandler(async (error: FastifyError, request, reply) => {
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

    // Catch-all route for debugging 404s. Skipped when caller will register
    // its own (e.g. SPA fallback for self-hosted webapp).
    if (!options.skipNotFoundHandler) {
        app.setNotFoundHandler((request, reply) => {
            if (isPublicSessionShareApiUrl(request.url)) return publicSessionShareNotFound(reply);
            log({
                module: '404-handler',
                method: request.method,
                path: request.url,
                userAgent: request.headers['user-agent'] || 'unknown',
                ip: request.ip || 'unknown',
            }, 'Route not found');
            reply.code(404).send({ error: 'Not found', path: request.url, method: request.method });
        });
    }

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
