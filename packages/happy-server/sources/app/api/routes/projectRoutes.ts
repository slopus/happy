import { z } from "zod";
import { Fastify } from "../types";
import { Context } from "@/context";
import { projectCreate } from "@/app/project/projectCreate";
import { projectList } from "@/app/project/projectList";
import { projectGet } from "@/app/project/projectGet";
import { projectUpdate } from "@/app/project/projectUpdate";
import { projectDelete } from "@/app/project/projectDelete";
import { ProjectError } from "@/app/project/types";

const ProjectConfigSchema = z.object({
    workspaceDir: z.string().optional(),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    sandboxConfig: z.object({
        enabled: z.boolean(),
        sessionIsolation: z.string(),
        extraWritePaths: z.array(z.string()),
        denyReadPaths: z.array(z.string()),
        denyWritePaths: z.array(z.string()),
        networkMode: z.string(),
        allowedDomains: z.array(z.string())
    }).optional(),
    devServerPort: z.number().optional(),
    machineId: z.string().optional()
}).optional();

export function projectRoutes(app: Fastify) {

    app.post('/v1/projects', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string().optional(),
                name: z.string(),
                description: z.string().default(''),
                color: z.string().default('#6366f1'),
                config: ProjectConfigSchema,
                isDefault: z.boolean().default(false)
            })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await projectCreate(ctx, request.body);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ project: formatProject(result.value) });
    });

    app.get('/v1/projects', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const projects = await projectList(ctx);
        return reply.send({
            projects: projects.map(p => ({
                ...formatProject(p),
                membership: p.membership
            }))
        });
    });

    app.get('/v1/projects/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await projectGet(ctx, request.params.id);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ project: formatProject(result.value) });
    });

    app.post('/v1/projects/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                name: z.string().optional(),
                description: z.string().optional(),
                color: z.string().optional(),
                config: ProjectConfigSchema
            })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await projectUpdate(ctx, request.params.id, request.body);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ project: formatProject(result.value) });
    });

    app.delete('/v1/projects/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await projectDelete(ctx, request.params.id);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ success: true });
    });
}

function formatProject(project: {
    id: string;
    accountId: string;
    name: string;
    description: string;
    color: string;
    config: unknown;
    giteaRepo?: string | null;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
}) {
    return {
        id: project.id,
        accountId: project.accountId,
        name: project.name,
        description: project.description,
        color: project.color,
        config: project.config,
        giteaRepo: project.giteaRepo ?? null,
        isDefault: project.isDefault,
        createdAt: project.createdAt.getTime(),
        updatedAt: project.updatedAt.getTime()
    };
}

function errorToStatus(error: ProjectError): number {
    switch (error) {
        case 'project-not-found':
        case 'member-not-found':
        case 'user-not-found':
            return 404;
        case 'access-denied':
        case 'not-owner':
            return 403;
        case 'id-taken':
            return 409;
        default:
            return 400;
    }
}
