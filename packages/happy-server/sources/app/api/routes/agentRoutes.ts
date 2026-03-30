import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";

/**
 * Agent CRUD routes.
 * Agents are global per-user configurations that can be reused across projects.
 */
export function agentRoutes(app: Fastify) {

    // List all agents for the current user
    app.get('/v1/agents', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const agents = await db.agent.findMany({
            where: { accountId: userId },
            orderBy: { updatedAt: 'desc' }
        });
        return agents.map(a => ({
            id: a.id,
            name: a.name,
            avatar: a.avatar,
            agentType: a.agentType,
            systemPrompt: a.systemPrompt,
            model: a.model,
            permissionMode: a.permissionMode,
            allowedTools: a.allowedTools,
            disallowedTools: a.disallowedTools,
            mcpServers: a.mcpServers,
            environmentVariables: a.environmentVariables,
            maxTurns: a.maxTurns,
            autoTerminate: a.autoTerminate,
            createdAt: a.createdAt.getTime(),
            updatedAt: a.updatedAt.getTime()
        }));
    });

    // Get a single agent
    app.get('/v1/agents/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const agent = await db.agent.findFirst({
            where: { id: request.params.id, accountId: userId }
        });
        if (!agent) {
            return reply.code(404).send({ error: 'Agent not found' });
        }
        return {
            agent: {
                id: agent.id,
                name: agent.name,
                avatar: agent.avatar,
                agentType: agent.agentType,
                systemPrompt: agent.systemPrompt,
                model: agent.model,
                permissionMode: agent.permissionMode,
                allowedTools: agent.allowedTools,
                disallowedTools: agent.disallowedTools,
                mcpServers: agent.mcpServers,
                environmentVariables: agent.environmentVariables,
                maxTurns: agent.maxTurns,
                autoTerminate: agent.autoTerminate,
                createdAt: agent.createdAt.getTime(),
                updatedAt: agent.updatedAt.getTime()
            }
        };
    });

    // Create a new agent
    app.post('/v1/agents', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                name: z.string().min(1),
                avatar: z.string().nullish(),
                agentType: z.string().min(1),
                systemPrompt: z.string().nullish(),
                model: z.string().nullish(),
                permissionMode: z.string().nullish(),
                allowedTools: z.array(z.string()).nullish(),
                disallowedTools: z.array(z.string()).nullish(),
                mcpServers: z.any().nullish(),
                environmentVariables: z.record(z.string()).nullish(),
                maxTurns: z.number().int().positive().nullish(),
                autoTerminate: z.boolean().optional()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const body = request.body;
        const agent = await db.agent.create({
            data: {
                accountId: userId,
                name: body.name,
                avatar: body.avatar ?? null,
                agentType: body.agentType,
                systemPrompt: body.systemPrompt ?? null,
                model: body.model ?? null,
                permissionMode: body.permissionMode ?? null,
                allowedTools: body.allowedTools ?? undefined,
                disallowedTools: body.disallowedTools ?? undefined,
                mcpServers: body.mcpServers ?? undefined,
                environmentVariables: body.environmentVariables ?? undefined,
                maxTurns: body.maxTurns ?? null,
                autoTerminate: body.autoTerminate ?? false
            }
        });
        return reply.code(201).send({
            agent: {
                id: agent.id,
                name: agent.name,
                avatar: agent.avatar,
                agentType: agent.agentType,
                systemPrompt: agent.systemPrompt,
                model: agent.model,
                permissionMode: agent.permissionMode,
                allowedTools: agent.allowedTools,
                disallowedTools: agent.disallowedTools,
                mcpServers: agent.mcpServers,
                environmentVariables: agent.environmentVariables,
                maxTurns: agent.maxTurns,
                autoTerminate: agent.autoTerminate,
                createdAt: agent.createdAt.getTime(),
                updatedAt: agent.updatedAt.getTime()
            }
        });
    });

    // Update an agent
    app.post('/v1/agents/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                name: z.string().min(1).optional(),
                avatar: z.string().nullish(),
                agentType: z.string().min(1).optional(),
                systemPrompt: z.string().nullish(),
                model: z.string().nullish(),
                permissionMode: z.string().nullish(),
                allowedTools: z.array(z.string()).nullish(),
                disallowedTools: z.array(z.string()).nullish(),
                mcpServers: z.any().nullish(),
                environmentVariables: z.record(z.string()).nullish(),
                maxTurns: z.number().int().positive().nullish(),
                autoTerminate: z.boolean().optional()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const existing = await db.agent.findFirst({
            where: { id: request.params.id, accountId: userId }
        });
        if (!existing) {
            return reply.code(404).send({ error: 'Agent not found' });
        }
        const body = request.body;
        const agent = await db.agent.update({
            where: { id: request.params.id },
            data: {
                ...(body.name !== undefined && { name: body.name }),
                ...(body.avatar !== undefined && { avatar: body.avatar ?? null }),
                ...(body.agentType !== undefined && { agentType: body.agentType }),
                ...(body.systemPrompt !== undefined && { systemPrompt: body.systemPrompt ?? null }),
                ...(body.model !== undefined && { model: body.model ?? null }),
                ...(body.permissionMode !== undefined && { permissionMode: body.permissionMode ?? null }),
                ...(body.allowedTools !== undefined && { allowedTools: body.allowedTools ?? undefined }),
                ...(body.disallowedTools !== undefined && { disallowedTools: body.disallowedTools ?? undefined }),
                ...(body.mcpServers !== undefined && { mcpServers: body.mcpServers ?? undefined }),
                ...(body.environmentVariables !== undefined && { environmentVariables: body.environmentVariables ?? undefined }),
                ...(body.maxTurns !== undefined && { maxTurns: body.maxTurns ?? null }),
                ...(body.autoTerminate !== undefined && { autoTerminate: body.autoTerminate })
            }
        });
        return {
            agent: {
                id: agent.id,
                name: agent.name,
                avatar: agent.avatar,
                agentType: agent.agentType,
                systemPrompt: agent.systemPrompt,
                model: agent.model,
                permissionMode: agent.permissionMode,
                allowedTools: agent.allowedTools,
                disallowedTools: agent.disallowedTools,
                mcpServers: agent.mcpServers,
                environmentVariables: agent.environmentVariables,
                maxTurns: agent.maxTurns,
                autoTerminate: agent.autoTerminate,
                createdAt: agent.createdAt.getTime(),
                updatedAt: agent.updatedAt.getTime()
            }
        };
    });

    // Delete an agent
    app.delete('/v1/agents/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const existing = await db.agent.findFirst({
            where: { id: request.params.id, accountId: userId }
        });
        if (!existing) {
            return reply.code(404).send({ error: 'Agent not found' });
        }
        await db.agent.delete({ where: { id: request.params.id } });
        return { ok: true };
    });
}
