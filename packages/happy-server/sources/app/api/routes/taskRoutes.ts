import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";

/**
 * Task CRUD routes.
 * A Task belongs to a Project and is executed by an Agent.
 * Each Task maps to a happy session for the actual agent conversation.
 */
export function taskRoutes(app: Fastify) {

    // List tasks for a project
    app.get('/v1/projects/:projectId/tasks', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ projectId: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const project = await db.project.findFirst({
            where: { id: request.params.projectId, accountId: userId }
        });
        if (!project) {
            return reply.code(404).send({ error: 'Project not found' });
        }
        const tasks = await db.task.findMany({
            where: { projectId: project.id },
            include: { agent: true },
            orderBy: { createdAt: 'desc' }
        });
        return tasks.map(t => ({
            id: t.id,
            projectId: t.projectId,
            title: t.title,
            description: t.description,
            status: t.status,
            happySessionId: t.happySessionId,
            agent: {
                id: t.agent.id,
                name: t.agent.name,
                avatar: t.agent.avatar,
                agentType: t.agent.agentType
            },
            createdAt: t.createdAt.getTime(),
            updatedAt: t.updatedAt.getTime(),
            finishedAt: t.finishedAt?.getTime() ?? null
        }));
    });

    // Get a single task
    app.get('/v1/tasks/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const task = await db.task.findFirst({
            where: { id: request.params.id },
            include: { agent: true, project: true }
        });
        if (!task || task.project.accountId !== userId) {
            return reply.code(404).send({ error: 'Task not found' });
        }
        return {
            task: {
                id: task.id,
                projectId: task.projectId,
                title: task.title,
                description: task.description,
                status: task.status,
                happySessionId: task.happySessionId,
                agent: {
                    id: task.agent.id,
                    name: task.agent.name,
                    avatar: task.agent.avatar,
                    agentType: task.agent.agentType
                },
                createdAt: task.createdAt.getTime(),
                updatedAt: task.updatedAt.getTime(),
                finishedAt: task.finishedAt?.getTime() ?? null
            }
        };
    });

    // Create a task
    app.post('/v1/projects/:projectId/tasks', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ projectId: z.string() }),
            body: z.object({
                agentId: z.string(),
                title: z.string().min(1),
                description: z.string().nullish()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const project = await db.project.findFirst({
            where: { id: request.params.projectId, accountId: userId }
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
        const body = request.body;
        const task = await db.task.create({
            data: {
                projectId: project.id,
                agentId: agent.id,
                title: body.title,
                description: body.description ?? null,
                status: 'running'
            },
            include: { agent: true }
        });
        return reply.code(201).send({
            task: {
                id: task.id,
                projectId: task.projectId,
                title: task.title,
                description: task.description,
                status: task.status,
                happySessionId: task.happySessionId,
                agent: {
                    id: task.agent.id,
                    name: task.agent.name,
                    avatar: task.agent.avatar,
                    agentType: task.agent.agentType
                },
                createdAt: task.createdAt.getTime(),
                updatedAt: task.updatedAt.getTime(),
                finishedAt: null
            }
        });
    });

    // Update task status
    app.post('/v1/tasks/:id/status', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                status: z.enum(['running', 'waiting_for_permission', 'done', 'failed'])
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const task = await db.task.findFirst({
            where: { id: request.params.id },
            include: { project: true }
        });
        if (!task || task.project.accountId !== userId) {
            return reply.code(404).send({ error: 'Task not found' });
        }
        const isFinishing = request.body.status === 'done' || request.body.status === 'failed';
        const updated = await db.task.update({
            where: { id: task.id },
            data: {
                status: request.body.status,
                ...(isFinishing && { finishedAt: new Date() })
            }
        });
        return {
            task: {
                id: updated.id,
                status: updated.status,
                updatedAt: updated.updatedAt.getTime(),
                finishedAt: updated.finishedAt?.getTime() ?? null
            }
        };
    });

    // Delete a task
    app.delete('/v1/tasks/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const task = await db.task.findFirst({
            where: { id: request.params.id },
            include: { project: true }
        });
        if (!task || task.project.accountId !== userId) {
            return reply.code(404).send({ error: 'Task not found' });
        }
        await db.task.delete({ where: { id: task.id } });
        return { ok: true };
    });
}
