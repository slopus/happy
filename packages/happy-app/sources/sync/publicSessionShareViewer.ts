import type { PublicSessionSnapshotV1 } from './publicSessionShareTypes';

const DEFAULT_PUBLIC_ORIGIN = process.env.EXPO_PUBLIC_HAPPY_SERVER_URL || 'https://47.115.228.20:8443';

function publicOrigin(): string {
    const currentOrigin = typeof globalThis.location?.origin === 'string' ? globalThis.location.origin : null;
    const origin = currentOrigin && /^https?:\/\//i.test(currentOrigin) ? currentOrigin : DEFAULT_PUBLIC_ORIGIN;
    return origin.replace(/\/$/, '');
}

async function expectPublicJson<T>(response: Response, operation: string): Promise<T> {
    if (!response.ok) throw new Error(`${operation} failed: ${response.status}`);
    return response.json() as Promise<T>;
}

export async function getPublicSessionShareSnapshot(publicId: string): Promise<{
    snapshot: PublicSessionSnapshotV1;
    publishedAt: number;
}> {
    const response = await fetch(
        `${publicOrigin()}/v1/public/session-shares/${encodeURIComponent(publicId)}`,
        { headers: { Accept: 'application/json' } },
    );
    return expectPublicJson(response, 'Get public session snapshot');
}

export function getPublicSessionAttachmentUrl(publicId: string, attachmentId: string): string {
    return `${publicOrigin()}/v1/public/session-shares/${encodeURIComponent(publicId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
