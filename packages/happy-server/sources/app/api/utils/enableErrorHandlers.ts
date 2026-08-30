import { error as logError } from "@/utils/log";
import { Fastify } from "../types";
import { FastifyError } from "fastify";
import { isTransactionTimeout, recordProductionError } from "@/app/monitoring/productionLogSummary";

export interface EnableErrorHandlersOptions {
    skipNotFoundHandler?: boolean;
}

export function resolveErrorStatusCode(replyStatusCode: number, errorStatusCode?: number): number {
    if (errorStatusCode) return errorStatusCode;
    return replyStatusCode >= 400 ? replyStatusCode : 500;
}

export function enableErrorHandlers(app: Fastify, options: EnableErrorHandlersOptions = {}) {
    // Global error handler
    app.setErrorHandler(async (error: FastifyError, request, reply) => {
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
            reply.code(404).send({ error: 'Not found', path: request.url, method: request.method });
        });
    }

    // Error hook for additional logging
    app.addHook('onError', async (request, reply, error) => {
        const method = request.method;
        const route = request.routeOptions?.url || '<unmatched>';
        const durationMs = Date.now() - (request.startTime || Date.now());
        const statusCode = resolveErrorStatusCode(reply.statusCode, error.statusCode);
        const txTimeout = isTransactionTimeout(error);

        recordProductionError(error);

        // Client errors are summarized, not logged one by one. Server errors
        // and transaction timeouts remain immediately visible.
        if (statusCode < 500 && !txTimeout) return;

        const module = txTimeout ? 'database' : 'http-error';
        const prefix = txTimeout ? 'db:tx-timeout' : 'http:error';
        const message = String(error.message || error).replace(/\s+/g, ' ').trim();
        logError({
            module,
            err: error,
            method,
            route,
            durationMs,
            statusCode,
            errorCode: error.code,
        }, `${prefix} method=${method} route=${route} status=${statusCode} duration=${durationMs}ms code=${error.code || 'unknown'} message=${message}`);
    });
}
