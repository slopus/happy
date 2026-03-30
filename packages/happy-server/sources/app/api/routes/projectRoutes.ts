import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";

/**
 * Project CRUD routes.
 * Projects bind a working directory to a set of agents from the global pool.
 */
export function projectRoutes(app: Fastify) {

    // List all projects for the current user
    app.get('/v1/projects', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const projects = await db.project.findMany({
            where: { accountId: userId },
            include: { projectAgents: { include: { agent: true } } },
            orderBy: { updatedAt: 'desc' }
        });
        return projects.map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            workingDirectory: p.workingDirectory,
            machineId: p.machineId,
            agents: p.projectAgents.map(pa => ({
                id: pa.agent.id,
                name: pa.agent.name,
                avatar: pa.agent.avatar,
                agentType: pa.agent.agentType
            })),
            createdAt: p.createdAt.getTime(),
            updatedAt: p.updatedAt.getTime()
        }));
    });

    // Get a single project with its agents
    app.get('/v1/projects/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const project = await db.project.findFirst({
            where: { id: request.params.id, accountId: userId },
            include: { projectAgents: { include: { agent: true } } }
        });
        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        return {
            project: {
                id: project.id,
                name: project.name,
                description: project.description,
                workingDirectory: project.workingDirectory,
                machineId: project.machineId,
                agents: project.projectAgents.map(pa => ({
                    id: pa.agent.id,
                    name: pa.agent.name,
                    avatar: pa.agent.avatar,
                    agentType: pa.agent.agentType
                })),
                createdAt: project.createdAt.getTime(),
                updatedAt: project.updatedAt.getTime()
            }
        };
    });

    // Create a project
    app.post('/v1/projects', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                name: z.string().min(1),
                description: z.string().nullish(),
                workingDirectory: z.string().nullish(),
                machineId: z.string().nullish(),
                agentIds: z.array(z.string()).optional()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const body = request.body;
        const project = await db.project.create({
            data: {
                accountId: userId,
                name: body.name,
                description: body.description ?? null,
                workingDirectory: body.workingDirectory ?? null,
                machineId: body.machineId ?? null,
                ...(body.agentIds && body.agentIds.length > 0 && {
                    projectAgents: {
                        create: body.agentIds.map(agentId => ({ agentId }))
                    }
                })
            },
            include: { projectAgents: { include: { agent: true } } }
        });
        return reply.code(201).send({
            project: {
                id: project.id,
                name: project.name,
                description: project.description,
                workingDirectory: project.workingDirectory,
                machineId: project.machineId,
                agents: project.projectAgents.map(pa => ({
                    id: pa.agent.id,
                    name: pa.agent.name,
                    avatar: pa.agent.avatar,
                    agentType: pa.agent.agentType
                })),
                createdAt: project.createdAt.getTime(),
                updatedAt: project.updatedAt.getTime()
            }
        });
    });

    // Update a project
    app.post('/v1/projects/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                name: z.string().min(1).optional(),
                description: z.string().nullish(),
                workingDirectory: z.string().nullish(),
                machineId: z.string().nullish()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const existing = await db.project.findFirst({
            where: { id: request.params.id, accountId: userId }
        });
        if (!existing) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        const body = request.body;
        const project = await db.project.update({
            where: { id: request.params.id },
            data: {
                ...(body.name !== undefined && { name: body.name }),
                ...(body.description !== undefined && { description: body.description ?? null }),
                ...(body.workingDirectory !== undefined && { workingDirectory: body.workingDirectory ?? null }),
                ...(body.machineId !== undefined && { machineId: body.machineId ?? null })
            },
            include: { projectAgents: { include: { agent: true } } }
        });
        return {
            project: {
                id: project.id,
                name: project.name,
                description: project.description,
                workingDirectory: project.workingDirectory,
                machineId: project.machineId,
                agents: project.projectAgents.map(pa => ({
                    id: pa.agent.id,
                    name: pa.agent.name,
                    avatar: pa.agent.avatar,
                    agentType: pa.agent.agentType
                })),
                createdAt: project.createdAt.getTime(),
                updatedAt: project.updatedAt.getTime()
            }
        };
    });

    // Add an agent to a project
    app.post('/v1/projects/:id/agents', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({ agentId: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const project = await db.project.findFirst({
            where: { id: request.params.id, accountId: userId }
        });
        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        const agent = await db.agent.findFirst({
            where: { id: request.body.agentId, accountId: userId }
        });
        if (!agent) {
            return reply.code(404).send({ error: 'Agent not found' });
        }
        await db.projectAgent.upsert({
            where: { projectId_agentId: { projectId: project.id, agentId: agent.id } },
            create: { projectId: project.id, agentId: agent.id },
            update: {}
        });
        return { ok: true };
    });

    // Remove an agent from a project
    app.delete('/v1/projects/:id/agents/:agentId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string(), agentId: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const project = await db.project.findFirst({
            where: { id: request.params.id, accountId: userId }
        });
        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        await db.projectAgent.deleteMany({
            where: { projectId: project.id, agentId: request.params.agentId }
        });
        return { ok: true };
    });

    // Delete a project
    app.delete('/v1/projects/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const existing = await db.project.findFirst({
            where: { id: request.params.id, accountId: userId }
        });
        if (!existing) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        await db.project.delete({ where: { id: request.params.id } });
        return { ok: true };
    });
}
