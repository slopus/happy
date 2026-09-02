import {
    PluginCatalogItemSchema,
    PluginCatalogResponseSchema,
    PluginConnectionTestResultSchema,
    PluginFieldKeySchema,
    PluginInstallRequestSchema,
    PluginInstallationStatusSchema,
    PluginSecretRevealResponseSchema,
} from '@slopus/happy-wire';
import type {
    PluginCatalogItem,
    PluginCatalogResponse,
    PluginConnectionTestResult,
    PluginInstallationStatus,
} from '@slopus/happy-wire';
import { z } from 'zod';

import { pluginRegistry } from '@/modules/plugins/pluginRegistry';
import type { Fastify } from '@/app/api/types';

interface PluginRoutesDependency {
    list: (accountId: string) => Promise<PluginCatalogResponse>;
    get: (accountId: string, pluginId: string) => Promise<PluginCatalogItem>;
    install: (accountId: string, pluginId: string, request: z.infer<typeof PluginInstallRequestSchema>) => Promise<PluginInstallationStatus>;
    revealSecret: (accountId: string, pluginId: string, fieldKey: string) => Promise<string>;
    testConnection: (accountId: string, pluginId: string, request: z.infer<typeof PluginInstallRequestSchema>) => Promise<PluginConnectionTestResult>;
    uninstall: (accountId: string, pluginId: string) => Promise<PluginInstallationStatus>;
}

const pluginParamsSchema = z.object({ pluginId: z.string().min(1).max(100) });
const pluginSecretParamsSchema = pluginParamsSchema.extend({ fieldKey: PluginFieldKeySchema });
const errorSchema = z.object({ error: z.string(), message: z.string() });

function errorStatus(error: unknown): 400 | 404 | 409 | 500 {
    const code = (error as { code?: unknown })?.code;
    if (code === 'plugin_not_found') return 404;
    if (code === 'version_mismatch') return 409;
    if (
        code === 'invalid_configuration'
        || code === 'invalid_permission_grant'
        || code === 'plugin_not_installed'
        || code === 'connection_test_unsupported'
    ) return 400;
    return 500;
}

function sendError(reply: any, error: unknown) {
    const code = typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : 'internal_error';
    const message = error instanceof Error ? error.message : 'Plugin operation failed';
    return reply.code(errorStatus(error)).send({ error: code, message });
}

export function pluginRoutes(
    app: Fastify,
    registry: PluginRoutesDependency = pluginRegistry,
) {
    app.get('/v1/plugins', {
        preHandler: app.authenticate,
        schema: { response: { 200: PluginCatalogResponseSchema } },
    }, async (request, reply) => reply.send(await registry.list(request.userId)));

    app.get('/v1/plugins/:pluginId', {
        preHandler: app.authenticate,
        schema: {
            params: pluginParamsSchema,
            response: { 200: PluginCatalogItemSchema, 400: errorSchema, 404: errorSchema, 500: errorSchema },
        },
    }, async (request, reply) => {
        try {
            return reply.send(await registry.get(request.userId, request.params.pluginId));
        } catch (error) {
            return sendError(reply, error);
        }
    });

    app.put('/v1/plugins/:pluginId', {
        preHandler: app.authenticate,
        schema: {
            params: pluginParamsSchema,
            body: PluginInstallRequestSchema,
            response: {
                200: PluginInstallationStatusSchema,
                400: errorSchema,
                404: errorSchema,
                409: errorSchema,
                500: errorSchema,
            },
        },
    }, async (request, reply) => {
        try {
            return reply.send(await registry.install(request.userId, request.params.pluginId, request.body));
        } catch (error) {
            return sendError(reply, error);
        }
    });

    app.post('/v1/plugins/:pluginId/test-connection', {
        preHandler: app.authenticate,
        schema: {
            params: pluginParamsSchema,
            body: PluginInstallRequestSchema,
            response: {
                200: PluginConnectionTestResultSchema,
                400: errorSchema,
                404: errorSchema,
                409: errorSchema,
                500: errorSchema,
            },
        },
    }, async (request, reply) => {
        try {
            return reply.send(await registry.testConnection(
                request.userId,
                request.params.pluginId,
                request.body,
            ));
        } catch (error) {
            return sendError(reply, error);
        }
    });

    app.post('/v1/plugins/:pluginId/secrets/:fieldKey/reveal', {
        preHandler: app.authenticate,
        schema: {
            params: pluginSecretParamsSchema,
            response: {
                200: PluginSecretRevealResponseSchema,
                400: errorSchema,
                404: errorSchema,
                409: errorSchema,
                500: errorSchema,
            },
        },
    }, async (request, reply) => {
        try {
            const value = await registry.revealSecret(
                request.userId,
                request.params.pluginId,
                request.params.fieldKey,
            );
            return reply.header('Cache-Control', 'no-store').send({ value });
        } catch (error) {
            return sendError(reply, error);
        }
    });

    app.delete('/v1/plugins/:pluginId', {
        preHandler: app.authenticate,
        schema: {
            params: pluginParamsSchema,
            response: {
                200: PluginInstallationStatusSchema,
                400: errorSchema,
                404: errorSchema,
                500: errorSchema,
            },
        },
    }, async (request, reply) => {
        try {
            return reply.send(await registry.uninstall(request.userId, request.params.pluginId));
        } catch (error) {
            return sendError(reply, error);
        }
    });
}
