import type { AuthCredentials } from '@/auth/tokenStorage';
import { z } from 'zod';
import { getHappyClientId } from './apiSocket';
import { ApiSessionSnapshotSchema, type ApiSessionSnapshot } from './apiTypes';
import { getServerUrl } from './serverConfig';

export interface FetchSessionSnapshotPageOptions {
    cursor?: string;
    limit?: number;
    changedSince?: number;
}

const sessionSnapshotResponseSchema = z.object({
    session: ApiSessionSnapshotSchema,
});

const sessionSnapshotsResponseSchema = z.object({
    sessions: z.array(ApiSessionSnapshotSchema),
});

const sessionSnapshotPageResponseSchema = sessionSnapshotsResponseSchema.extend({
    nextCursor: z.string().nullable(),
    hasNext: z.boolean(),
});

function buildSessionHeaders(credentials: AuthCredentials) {
    return {
        Authorization: `Bearer ${credentials.token}`,
        'Content-Type': 'application/json',
        'X-Happy-Client': getHappyClientId(),
    };
}

export async function fetchSessionSnapshot(
    credentials: AuthCredentials,
    sessionId: string,
): Promise<ApiSessionSnapshot | null> {
    const response = await fetch(`${getServerUrl()}/v2/sessions/${encodeURIComponent(sessionId)}`, {
        headers: buildSessionHeaders(credentials),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
        throw new Error(`Failed to fetch session ${sessionId}: ${response.status}`);
    }
    return sessionSnapshotResponseSchema.parse(await response.json()).session;
}

export async function fetchActiveSessionSnapshots(
    credentials: AuthCredentials,
    limit: number,
): Promise<ApiSessionSnapshot[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    const response = await fetch(`${getServerUrl()}/v2/sessions/active?${query}`, {
        headers: buildSessionHeaders(credentials),
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch active sessions: ${response.status}`);
    }
    return sessionSnapshotsResponseSchema.parse(await response.json()).sessions;
}

export async function fetchSessionSnapshotPage(
    credentials: AuthCredentials,
    options: FetchSessionSnapshotPageOptions,
): Promise<{ sessions: ApiSessionSnapshot[]; nextCursor: string | null; hasNext: boolean }> {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.changedSince !== undefined) query.set('changedSince', String(options.changedSince));
    const queryString = query.toString();
    const response = await fetch(`${getServerUrl()}/v2/sessions${queryString ? `?${queryString}` : ''}`, {
        headers: buildSessionHeaders(credentials),
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch session page: ${response.status}`);
    }
    return sessionSnapshotPageResponseSchema.parse(await response.json());
}
