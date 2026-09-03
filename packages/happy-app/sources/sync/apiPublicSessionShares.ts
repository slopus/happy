import type { AuthCredentials } from '@/auth/tokenStorage';
import type { PublicSessionCover, PublicSessionSnapshot } from '@slopus/happy-wire';
import { z } from 'zod';
import { getServerUrl } from './serverConfig';
import type {
    PublicSessionAttachmentKind,
    PublicSessionShareState,
} from './publicSessionShareTypes';
export {
    getPublicSessionAttachmentUrl,
    getPublicSessionShareSnapshot,
} from './publicSessionShareViewer';

type Draft = { generation: string; publicId: string };
export type PreparedPublicSessionShareAsset = {
    assetId: string;
    method: 'PUT';
    uploadUrl: string;
};

function httpsUrlForHosts(hosts: readonly string[]) {
    return z.string().url().max(2_000).refine((value) => {
        try {
            const url = new URL(value);
            return url.protocol === 'https:'
                && hosts.includes(url.hostname.toLowerCase())
                && !url.username
                && !url.password
                && (!url.port || url.port === '443');
        } catch {
            return false;
        }
    }, 'Untrusted Pexels URL');
}

const publicSessionCoverCandidateSchema = z.object({
    provider: z.literal('pexels'),
    photoId: z.number().int().positive(),
    previewUrl: httpsUrlForHosts(['images.pexels.com']),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    averageColor: z.string().regex(/^#[0-9a-f]{6}$/i).nullable(),
    attribution: z.object({
        photographer: z.string().min(1).max(200),
        photographerUrl: httpsUrlForHosts(['pexels.com', 'www.pexels.com']),
        photoUrl: httpsUrlForHosts(['pexels.com', 'www.pexels.com']),
    }).strict(),
}).strict();

export type PublicSessionCoverCandidate = z.infer<typeof publicSessionCoverCandidateSchema>;

function ownerHeaders(credentials: AuthCredentials, json = false): Record<string, string> {
    return {
        Authorization: `Bearer ${credentials.token}`,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
    };
}

async function expectJson<T>(response: Response, operation: string): Promise<T> {
    if (!response.ok) throw new Error(`${operation} failed: ${response.status}`);
    return response.json() as Promise<T>;
}

function rewriteUploadUrlToServer(url: string): string {
    try {
        const target = new URL(url);
        const server = new URL(getServerUrl());
        target.protocol = server.protocol;
        target.hostname = server.hostname;
        target.port = server.port;
        return target.toString();
    } catch {
        return url;
    }
}

export async function getPublicSessionShare(credentials: AuthCredentials, sessionId: string): Promise<PublicSessionShareState> {
    const response = await fetch(`${getServerUrl()}/v1/sessions/${encodeURIComponent(sessionId)}/share`, {
        headers: ownerHeaders(credentials),
    });
    return expectJson(response, 'Get public session share');
}

export async function createPublicSessionShareDraft(credentials: AuthCredentials, sessionId: string): Promise<Draft> {
    const response = await fetch(`${getServerUrl()}/v1/sessions/${encodeURIComponent(sessionId)}/share/drafts`, {
        method: 'POST',
        headers: ownerHeaders(credentials),
    });
    return expectJson(response, 'Create public session share draft');
}

export async function getRandomPublicSessionCover(
    credentials: AuthCredentials,
    sessionId: string,
): Promise<PublicSessionCoverCandidate> {
    const response = await fetch(
        `${getServerUrl()}/v1/sessions/${encodeURIComponent(sessionId)}/share/covers/random`,
        { headers: ownerHeaders(credentials) },
    );
    return publicSessionCoverCandidateSchema.parse(
        await expectJson<unknown>(response, 'Get random public session cover'),
    );
}

export async function clonePublicSessionCover(
    credentials: AuthCredentials,
    sessionId: string,
    generation: string,
    assetId: string,
): Promise<PublicSessionCover> {
    const response = await fetch(
        `${getServerUrl()}/v1/sessions/${encodeURIComponent(sessionId)}/share/drafts/${encodeURIComponent(generation)}/covers/clone`,
        {
            method: 'POST',
            headers: ownerHeaders(credentials, true),
            body: JSON.stringify({ assetId }),
        },
    );
    return expectJson(response, 'Clone public session cover');
}

export async function importPublicSessionPexelsCover(
    credentials: AuthCredentials,
    sessionId: string,
    generation: string,
    assetId: string,
    photoId: number,
): Promise<PublicSessionCover> {
    const response = await fetch(
        `${getServerUrl()}/v1/sessions/${encodeURIComponent(sessionId)}/share/drafts/${encodeURIComponent(generation)}/covers/import`,
        {
            method: 'POST',
            headers: ownerHeaders(credentials, true),
            body: JSON.stringify({ assetId, photoId }),
        },
    );
    return expectJson(response, 'Import public session Pexels cover');
}

export async function preparePublicSessionShareAsset(
    credentials: AuthCredentials,
    sessionId: string,
    generation: string,
    asset: { attachmentId: string; name: string; mimeType: string; kind: PublicSessionAttachmentKind; size: number },
    sha256: string,
): Promise<PreparedPublicSessionShareAsset> {
    const response = await fetch(
        `${getServerUrl()}/v1/sessions/${encodeURIComponent(sessionId)}/share/drafts/${encodeURIComponent(generation)}/assets`,
        {
            method: 'POST',
            headers: ownerHeaders(credentials, true),
            body: JSON.stringify({
                attachmentId: asset.attachmentId,
                name: asset.name,
                mimeType: asset.mimeType,
                kind: asset.kind,
                size: asset.size,
                sha256,
            }),
        },
    );
    const result = await expectJson<PreparedPublicSessionShareAsset>(response, 'Prepare public session share asset');
    return { ...result, uploadUrl: rewriteUploadUrlToServer(result.uploadUrl) };
}

export async function uploadPublicSessionShareAsset(
    upload: PreparedPublicSessionShareAsset,
    data: Uint8Array,
    credentials: AuthCredentials,
): Promise<void> {
    if (new URL(upload.uploadUrl).origin !== new URL(getServerUrl()).origin) {
        throw new Error('Upload public session share asset failed: untrusted upload origin');
    }
    const headers: Record<string, string> = {
        Authorization: `Bearer ${credentials.token}`,
        'Content-Type': 'application/octet-stream',
    };
    const bytes = new Uint8Array(data);
    const response = await fetch(upload.uploadUrl, {
        method: upload.method,
        headers,
        body: bytes.buffer,
    });
    if (!response.ok) throw new Error(`Upload public session share asset failed: ${response.status}`);
}

export async function publishPublicSessionShareDraft(
    credentials: AuthCredentials,
    sessionId: string,
    generation: string,
    snapshot: PublicSessionSnapshot,
): Promise<{ publicId: string; publishedAt: number }> {
    const response = await fetch(
        `${getServerUrl()}/v1/sessions/${encodeURIComponent(sessionId)}/share/drafts/${encodeURIComponent(generation)}/publish`,
        {
            method: 'PUT',
            headers: ownerHeaders(credentials, true),
            body: JSON.stringify({ snapshot }),
        },
    );
    return expectJson(response, 'Publish public session share');
}

export async function revokePublicSessionShare(credentials: AuthCredentials, sessionId: string): Promise<void> {
    const response = await fetch(`${getServerUrl()}/v1/sessions/${encodeURIComponent(sessionId)}/share`, {
        method: 'DELETE',
        headers: ownerHeaders(credentials),
    });
    if (!response.ok) throw new Error(`Revoke public session share failed: ${response.status}`);
}

export function getPublicSessionShareUrl(publicId: string): string {
    const currentOrigin = typeof globalThis.location?.origin === 'string' ? globalThis.location.origin : null;
    const origin = currentOrigin && /^https?:\/\//i.test(currentOrigin) ? currentOrigin : getServerUrl();
    return `${origin.replace(/\/$/, '')}/share/${encodeURIComponent(publicId)}`;
}
