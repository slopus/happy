import { z } from 'zod';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { createProjectGoalService } from './projectService';
import type { GoalTaskSession } from '@slopus/happy-wire';

type HistoryCursor = { sessionId: string; updatedAt: number };

/** Merge already-authorized candidates with the durable local history page. */
export function mergeProjectPreviewHistory(local: { sessions: GoalTaskSession[]; nextCursor?: HistoryCursor }, candidates: GoalTaskSession[], cursor?: HistoryCursor) {
    // A byte-limited local page may contain fewer than 25 rows. Do not let old
    // candidates advance the cursor past local rows that have not been read yet.
    const boundary = local.nextCursor;
    // Candidates already returned on an earlier page must not replace a local
    // row before the cursor filter and thereby erase this page's continuation.
    const afterCursor = cursor ? candidates.filter(session => session.updatedAt < cursor.updatedAt || (session.updatedAt === cursor.updatedAt && session.sessionId.localeCompare(cursor.sessionId) < 0)) : candidates;
    const eligible = boundary ? afterCursor.filter(session => session.updatedAt > boundary.updatedAt || (session.updatedAt === boundary.updatedAt && session.sessionId.localeCompare(boundary.sessionId) >= 0)) : afterCursor;
    const ordered = [...new Map([...local.sessions, ...eligible].map(session => [session.sessionId, session])).values()]
        .sort((a, b) => b.updatedAt - a.updatedAt || b.sessionId.localeCompare(a.sessionId));
    const remaining = cursor ? ordered.filter(session => session.updatedAt < cursor.updatedAt || (session.updatedAt === cursor.updatedAt && session.sessionId.localeCompare(cursor.sessionId) < 0)) : ordered;
    const sessions = remaining.slice(0, 25);
    const last = sessions.at(-1);
    return { success: true as const, sessions, ...((remaining.length > sessions.length || local.nextCursor) && last ? { nextCursor: { sessionId: last.sessionId, updatedAt: last.updatedAt } } : {}) };
}

const emptyChat = z.object({
    featurePath: z.string().min(1).max(8192),
    taskId: z.string().min(1).max(2048),
    requestId: z.string().min(1).max(128),
    agent: z.enum(['codex', 'claude']),
    action: z.literal('chat'),
    codexSessionGrant: z.string().max(4096).optional(),
}).strict();

/** Opt-in for an authenticated preview bridge, never registered by the production daemon. */
export function registerProjectGoalPreviewChat(
    manager: Pick<RpcHandlerManager, 'registerHandler'>,
    service: Pick<ReturnType<typeof createProjectGoalService>, 'launch'>,
) {
    // The regular service validates the installed archive and canonical Task path,
    // persists the request claim and never calls send for action=chat.
    manager.registerHandler('previewGoalTaskLaunch', input => service.launch(emptyChat.parse(input)));
}

const deliverableConfirmation = z.object({
    featurePath: z.string().min(1).max(8192),
    taskId: z.string().min(1).max(2048),
    artifactId: z.string().min(1).max(2048),
    expectedRevision: z.string().regex(/^[a-f0-9]{24}$/),
    expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

/** Separate opt-in for human confirmation; does not enable file writes or execution. */
export function registerProjectGoalPreviewApproval(
    manager: Pick<RpcHandlerManager, 'registerHandler'>,
    service: Pick<ReturnType<typeof createProjectGoalService>, 'approve'>,
) {
    // Reuse canonical archive scope, byte/revision checks and durable receipts.
    manager.registerHandler('previewGoalTaskApprove', input => service.approve(deliverableConfirmation.parse(input)));
}
