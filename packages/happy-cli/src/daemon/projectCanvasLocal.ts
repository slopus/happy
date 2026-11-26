import { createHmac, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Metadata } from '@/api/types';
import type { createProjectGoalService } from '@/modules/goalBoard/projectService';
import { within } from '@/modules/goalBoard/catalog';
import { canReadCanvas, canvasToolError, operateProjectCanvas, ProjectCanvasLocalRequest } from '@/modules/goalBoard/projectCanvasTools';

export function projectCanvasControlProof(token: string) {
    return createHmac('sha256', token).update('paws-project-canvas-local-v1').digest('hex');
}

export function createProjectCanvasControlHandler(token: string, handle: (request: ProjectCanvasLocalRequest) => Promise<CallToolResult>) {
    const expected = Buffer.from('PawsCanvas ' + projectCanvasControlProof(token));
    return async (authorization: string | undefined, body: unknown) => {
        const measured = Buffer.from(authorization ?? '');
        if (measured.length !== expected.length || !timingSafeEqual(measured, expected)) {
            return { status: 401, result: canvasToolError(new Error('Project canvas authentication failed')) };
        }
        try {
            return { status: 200, result: await handle(ProjectCanvasLocalRequest.parse(body)) };
        } catch (error) {
            return { status: 200, result: canvasToolError(error) };
        }
    };
}

export async function invokeBoundProjectCanvas(service: Pick<ReturnType<typeof createProjectGoalService>, 'canvas' | 'projects'>,
    request: ProjectCanvasLocalRequest, session?: Pick<Metadata, 'path' | 'goalBoard'>): Promise<CallToolResult> {
    if ('projectPath' in request) {
        if (!canReadCanvas(request.command.action)) throw new Error('External project canvas tools are read-only');
        return operateProjectCanvas(service.canvas, request.projectPath, request.command);
    }
    if (!session?.path) throw new Error('Open a project-bound Paws conversation to use the canvas tools');
    const scope = await realpath(session.goalBoard?.featurePath ?? session.path);
    const { projects } = await service.projects();
    const matches = projects.filter(project => within(project.projectPath, scope));
    if (matches.length !== 1) throw new Error('This conversation has no unique project canvas');
    return operateProjectCanvas(service.canvas, matches[0].projectPath, request.command, session.path);
}
