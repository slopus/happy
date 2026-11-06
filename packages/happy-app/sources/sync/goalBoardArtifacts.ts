import { GoalBoardArtifactResponseSchema, type GoalArtifact, type GoalBoardArtifactResponse } from '@slopus/happy-wire';
import { assertAccountRuntime, getRuntimeAccountSelection } from '@/auth/accountRuntime';
import { getServerUrl } from './serverConfig';
import { apiSocket } from './apiSocket';
import { attachmentCacheGeneration } from './attachmentCacheContext';

export type GoalArtifactResponse = Extract<GoalBoardArtifactResponse, { success: true }>;
export type GoalArtifactRequest = { sessionId: string; featurePath: string; taskId: string; artifact: GoalArtifact };
type ArtifactRPC = (sessionId: string, method: string, input: { featurePath: string; taskId: string; artifactId: string }) => Promise<unknown>;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
function assertCurrent(signal?: AbortSignal) {
    if (signal?.aborted) {
        const error = new Error('Artifact request cancelled');
        error.name = 'AbortError';
        throw error;
    }
}
function captureContext(): string {
    assertAccountRuntime();
    return JSON.stringify([getServerUrl(), getRuntimeAccountSelection()?.generation ?? null, attachmentCacheGeneration()]);
}
export function goalArtifactIdentity(input: GoalArtifactRequest): string {
    const { artifact } = input;
    return JSON.stringify([input.sessionId, input.featurePath, input.taskId, artifact.id, artifact.kind, artifact.path, artifact.url, artifact.name, artifact.size, artifact.modifiedAt, artifact.available]);
}

/** Holds original text/attachment descriptors only. Playback sources retain their existing renderer ownership. */
export class GoalArtifactCache {
    private entries = new Map<string, { response: GoalArtifactResponse; bytes: number }>();
    private bytes = 0;
    private context: string | null = null;
    constructor(private rpc: ArtifactRPC, private limits: { maxEntries?: number; maxBytes?: number } = {}) {}
    async open(input: GoalArtifactRequest, signal?: AbortSignal): Promise<GoalArtifactResponse> {
        assertCurrent(signal);
        const context = captureContext();
        if (context !== this.context) {
            this.entries.clear(); this.bytes = 0; this.context = context;
        }
        if (!input.artifact.available) throw new Error('Artifact is unavailable');
        const key = goalArtifactIdentity(input);
        const cached = this.entries.get(key);
        if (cached) {
            this.entries.delete(key); this.entries.set(key, cached);
            return cached.response;
        }
        const raw = await this.rpc(input.sessionId, 'goalBoardArtifact', {
            featurePath: input.featurePath, taskId: input.taskId, artifactId: input.artifact.id,
        });
        assertCurrent(signal);
        if (context !== captureContext()) throw new Error('Artifact context expired');
        const parsed = GoalBoardArtifactResponseSchema.safeParse(raw);
        if (!parsed.success) throw new Error('Invalid artifact response');
        if (!parsed.data.success) throw new Error(parsed.data.error);
        const response = parsed.data;
        if (response.kind === 'text' && new TextEncoder().encode(response.content).byteLength > MAX_TEXT_BYTES) {
            throw new Error('Artifact exceeds the 2 MiB text limit');
        }
        const bytes = response.kind === 'text' ? response.content.length * 2 + 512 : JSON.stringify(response).length * 2;
        const maxBytes = this.limits.maxBytes ?? 8 * 1024 * 1024;
        const maxEntries = this.limits.maxEntries ?? 16;
        if (bytes <= maxBytes && maxEntries > 0) {
            const previous = this.entries.get(key);
            if (previous) this.bytes -= previous.bytes;
            this.entries.delete(key); this.entries.set(key, { response, bytes }); this.bytes += bytes;
            while (this.entries.size > maxEntries || this.bytes > maxBytes) {
                const oldest = this.entries.keys().next().value!;
                this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
            }
        }
        return response;
    }
}
const artifacts = new GoalArtifactCache((sessionId, method, input) => apiSocket.sessionRPC(sessionId, method, input));
export const openGoalArtifact = (input: GoalArtifactRequest, signal?: AbortSignal) => artifacts.open(input, signal);
