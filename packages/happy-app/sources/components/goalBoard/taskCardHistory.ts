import type { GoalTaskSession } from '@slopus/happy-wire';
import type { ProjectHistoryCursor } from '@/sync/projectGoals';

/** An unavailable first page does not prove that the task has no conversation. */
export async function readTaskCardHistory(
    read: (cursor?: ProjectHistoryCursor) => Promise<{ sessions: GoalTaskSession[]; nextCursor?: ProjectHistoryCursor }>,
    select: (sessions: GoalTaskSession[]) => GoalTaskSession | undefined,
) {
    const sessions: GoalTaskSession[] = [];
    let cursor: ProjectHistoryCursor | undefined;
    const seen = new Set<string>();
    do {
        const page = await read(cursor);
        sessions.push(...page.sessions);
        const conversation = select(sessions);
        if (conversation || !page.nextCursor) return { sessions, nextCursor: page.nextCursor, conversation };
        cursor = page.nextCursor;
        const key = JSON.stringify(cursor);
        if (seen.has(key) || seen.size >= 800) throw new Error('Task history pagination did not advance');
        seen.add(key);
    } while (cursor);
    return { sessions, nextCursor: undefined, conversation: undefined };
}
