import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { devEncrypt, devDecrypt, isDevEncryptionAvailable } from "../utils/devEncryption";
import { buildNewMessageUpdate, eventRouter } from "@/app/events/eventRouter";
import { allocateSessionSeq, allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";

function slugify(text: string): string {
    return text.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
}

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

    // Run a task: spawn an agent session on the daemon
    app.post('/v1/tasks/:id/run', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                dangerouslySkipPermissions: z.boolean().optional()
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const task = await db.task.findFirst({
            where: { id: request.params.id },
            include: { project: true, agent: true }
        });
        if (!task || task.project.accountId !== userId) {
            return reply.code(404).send({ error: 'Task not found' });
        }
        if (task.happySessionId) {
            return reply.code(409).send({ error: 'Task already has a session' });
        }

        // Find an online machine with a daemon control port
        const machines = await db.machine.findMany({
            where: { accountId: userId, active: true }
        });
        const machine = machines.find(m => {
            const info = m.hostInfo as any;
            return info?.daemonPort;
        });
        if (!machine) {
            return reply.code(503).send({ error: 'No online machine with daemon available' });
        }

        const hostInfo = machine.hostInfo as any;
        const daemonPort = hostInfo.daemonPort;
        const workspaceRoot = hostInfo.workspaceRoot;

        let directory: string;
        if (task.project.workingDirectory) {
            directory = task.project.workingDirectory;
        } else if (workspaceRoot) {
            const projectSlug = slugify(task.project.name);
            const taskSlug = slugify(task.title) + '-' + task.id.slice(-6);
            directory = `${workspaceRoot}/${projectSlug}/${taskSlug}`;
        } else {
            return reply.code(400).send({ error: 'No workspace root configured on machine and no working directory on project. Run: make machine-info ROOT=/path' });
        }
        const agentTypeMap: Record<string, string> = { 'claude-code': 'claude' };
        const agentType = agentTypeMap[task.agent.agentType] || task.agent.agentType;

        try {
            const yolo = (request.body as any)?.dangerouslySkipPermissions === true;
            const spawnRes = await fetch(`http://127.0.0.1:${daemonPort}/spawn-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    directory,
                    agent: agentType,
                    dangerouslySkipPermissions: yolo,
                    environmentVariables: {
                        HAPPY_TASK_TITLE: task.title,
                        ...(task.description ? { HAPPY_TASK_DESCRIPTION: task.description } : {}),
                    },
                }),
            });
            const result = await spawnRes.json() as any;

            if (!spawnRes.ok || !result.success) {
                log({ module: 'task-run' }, `Spawn failed: ${JSON.stringify(result)}`);
                await db.task.update({ where: { id: task.id }, data: { status: 'failed' } });
                return reply.code(502).send({ error: result.error || result.actionRequired || 'Spawn failed' });
            }

            const updated = await db.task.update({
                where: { id: task.id },
                data: { happySessionId: result.sessionId }
            });

            log({ module: 'task-run' }, `Task ${task.id} spawned session ${result.sessionId} on machine ${machine.id}`);

            return {
                task: {
                    id: updated.id,
                    status: updated.status,
                    happySessionId: updated.happySessionId,
                }
            };
        } catch (e: any) {
            log({ module: 'task-run', level: 'error' }, `Failed to call daemon: ${e.message}`);
            return reply.code(502).send({ error: `Cannot reach daemon: ${e.message}` });
        }
    });

    // Get chat messages for a task (decrypted)
    app.get('/v1/tasks/:id/chat', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            querystring: z.object({
                after_seq: z.coerce.number().int().min(0).default(0)
            })
        }
    }, async (request, reply) => {
        if (!isDevEncryptionAvailable()) {
            return reply.code(503).send({ error: 'Dev encryption not available' });
        }
        const userId = request.userId;
        const task = await db.task.findFirst({
            where: { id: request.params.id },
            include: { project: true }
        });
        if (!task || task.project.accountId !== userId) {
            return reply.code(404).send({ error: 'Task not found' });
        }
        if (!task.happySessionId) {
            return reply.send({ messages: [] });
        }

        const messages = await db.sessionMessage.findMany({
            where: {
                sessionId: task.happySessionId,
                seq: { gt: request.query.after_seq }
            },
            orderBy: { seq: 'asc' },
            take: 200,
            select: { seq: true, content: true, createdAt: true }
        });

        const decoded = [];
        let agentStatus: 'working' | 'waiting' | 'done' | 'idle' = 'idle';
        for (const msg of messages) {
            const content = msg.content as any;
            if (!content?.c) continue;
            const plain = devDecrypt(content.c);
            if (!plain) continue;

            const p = plain as any;
            let role = p.role || 'unknown';
            let text = '';

            if (role === 'user' && p.content?.type === 'text') {
                text = p.content.text;
                agentStatus = 'working';
            } else if (role === 'agent' && p.content?.type === 'output') {
                const data = p.content.data;
                if (typeof data === 'string') {
                    text = data;
                } else if (data?.type === 'assistant' && data?.message?.content) {
                    const parts = Array.isArray(data.message.content) ? data.message.content : [data.message.content];
                    text = parts.map((c: any) => c.text || c.input || JSON.stringify(c)).join('\n');
                } else {
                    text = JSON.stringify(data, null, 2);
                }
                agentStatus = 'working';
            } else if (role === 'session') {
                const ev = p.content;
                if (ev?.ev?.t === 'text' && ev?.ev?.text) {
                    role = ev.role === 'user' ? 'user' : 'agent';
                    text = ev.ev.text;
                    agentStatus = 'working';
                } else if (ev?.ev?.t === 'tool-call-start') {
                    role = 'agent';
                    const name = ev.ev.name || 'tool';
                    const args = ev.ev.args ? JSON.stringify(ev.ev.args) : '';
                    text = `[Tool: ${name}] ${args}`;
                    agentStatus = 'working';
                } else if (ev?.ev?.t === 'tool-call-end') {
                    continue;
                } else if (ev?.ev?.t === 'turn-end') {
                    agentStatus = ev.ev.status === 'completed' ? 'done' : 'waiting';
                    role = 'system';
                    text = ev.ev.status === 'completed' ? 'Agent finished this turn.' : `Agent status: ${ev.ev.status}`;
                } else if (ev?.ev?.t === 'turn-start') {
                    agentStatus = 'working';
                    continue;
                } else {
                    continue;
                }
            } else {
                continue;
            }

            if (!text) continue;

            decoded.push({
                seq: msg.seq,
                role,
                text,
                createdAt: msg.createdAt.getTime()
            });
        }

        // Auto-update task status if agent is done and task is still running
        if (agentStatus === 'done' && task.status === 'running') {
            await db.task.update({
                where: { id: task.id },
                data: { status: 'done', finishedAt: new Date() }
            });
        }

        return reply.send({ messages: decoded, agentStatus });
    });

    // Send a chat message to a task's agent session
    app.post('/v1/tasks/:id/chat', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                text: z.string().min(1),
                permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).optional()
            })
        }
    }, async (request, reply) => {
        if (!isDevEncryptionAvailable()) {
            return reply.code(503).send({ error: 'Dev encryption not available' });
        }
        const userId = request.userId;
        const task = await db.task.findFirst({
            where: { id: request.params.id },
            include: { project: true }
        });
        if (!task || task.project.accountId !== userId) {
            return reply.code(404).send({ error: 'Task not found' });
        }
        if (!task.happySessionId) {
            return reply.code(400).send({ error: 'Task has no active session' });
        }

        const userMessage = {
            role: 'user' as const,
            content: { type: 'text' as const, text: request.body.text },
            meta: {
                sentFrom: 'happy-app',
                permissionMode: request.body.permissionMode || 'default'
            }
        };

        const encrypted = devEncrypt(userMessage);
        if (!encrypted) {
            return reply.code(500).send({ error: 'Encryption failed' });
        }

        const sessionId = task.happySessionId;
        const msgSeq = await allocateSessionSeq(sessionId);
        const localId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        const msg = await db.sessionMessage.create({
            data: {
                sessionId,
                seq: msgSeq,
                content: { t: 'encrypted', c: encrypted },
                localId
            },
            select: { id: true, seq: true, localId: true, createdAt: true, updatedAt: true }
        });

        const updSeq = await allocateUserSeq(userId);
        const updatePayload = buildNewMessageUpdate({
            ...msg,
            content: { t: 'encrypted' as const, c: encrypted }
        }, sessionId, updSeq, randomKeyNaked(12));

        eventRouter.emitUpdate({
            userId,
            payload: updatePayload,
            recipientFilter: { type: 'all-interested-in-session', sessionId }
        });

        return reply.send({ ok: true, seq: msg.seq });
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
