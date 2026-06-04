import { z } from "zod";
import { Fastify } from "../types";
import { Context } from "@/context";
import { projectMemberInvite } from "@/app/project/projectMemberInvite";
import { projectMemberList } from "@/app/project/projectMemberList";
import { projectMemberRespond } from "@/app/project/projectMemberRespond";
import { projectMemberUpdate } from "@/app/project/projectMemberUpdate";
import { projectMemberRemove } from "@/app/project/projectMemberRemove";
import { projectMemberPending } from "@/app/project/projectMemberPending";
import { ProjectError } from "@/app/project/types";

const ProjectRoleSchema = z.enum(['owner', 'editor', 'viewer']);

export function projectMemberRoutes(app: Fastify) {

    app.post('/v1/projects/:projectId/members', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ projectId: z.string() }),
            // Either { username, role } (legacy) or { accountId, role }
            // (preferred — web-ui orchestrates by happy accountId to avoid
            // username-collision bugs).
            body: z.union([
                z.object({
                    username: z.string(),
                    role: ProjectRoleSchema.default('editor')
                }),
                z.object({
                    accountId: z.string(),
                    role: ProjectRoleSchema.default('editor')
                })
            ])
        }
    }, async (request, reply) => {
        const { projectId } = request.params;
        const body = request.body;
        const role = body.role;
        const target = 'accountId' in body
            ? { accountId: body.accountId }
            : { username: body.username };
        const ctx = Context.create(request.userId);

        const result = await projectMemberInvite(ctx, projectId, target, role);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ member: result.value });
    });

    app.get('/v1/projects/:projectId/members', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ projectId: z.string() })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await projectMemberList(ctx, request.params.projectId);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ members: result.value });
    });

    app.post('/v1/project-members/:memberId/respond', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ memberId: z.string() }),
            body: z.object({
                response: z.enum(['accepted', 'rejected'])
            })
        }
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const result = await projectMemberRespond(ctx, request.params.memberId, request.body.response);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ member: result.value });
    });

    app.post('/v1/projects/:projectId/members/:memberId/role', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                projectId: z.string(),
                memberId: z.string()
            }),
            body: z.object({ role: ProjectRoleSchema })
        }
    }, async (request, reply) => {
        const { projectId, memberId } = request.params;
        const ctx = Context.create(request.userId);
        const result = await projectMemberUpdate(ctx, projectId, memberId, request.body.role);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ member: result.value });
    });

    app.delete('/v1/projects/:projectId/members/:memberId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                projectId: z.string(),
                memberId: z.string()
            })
        }
    }, async (request, reply) => {
        const { projectId, memberId } = request.params;
        const ctx = Context.create(request.userId);
        const result = await projectMemberRemove(ctx, projectId, memberId);
        if (!result.ok) {
            return reply.code(errorToStatus(result.error)).send({ error: result.error });
        }
        return reply.send({ success: true });
    });

    app.get('/v1/project-members/pending', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const ctx = Context.create(request.userId);
        const invitations = await projectMemberPending(ctx);
        return reply.send({ invitations });
    });
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
        default:
            return 400;
    }
}
