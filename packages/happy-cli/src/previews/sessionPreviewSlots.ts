/** Tracks live and in-flight Cloudflare tunnel previews for one Happy session. */
import type { InteractivePreviewEvent } from '@slopus/happy-wire';
import type { CloudflarePreview } from './cloudflarePreview';

export const MAX_SESSION_TUNNEL_PREVIEWS = 3;

type PreviewMode = 'tunnel' | 'hosted';

export type SessionPreviewStatus = {
    limit: number;
    used: number;
    remaining: number;
    publishing: number;
    previews: Array<Pick<InteractivePreviewEvent, 'id' | 'title' | 'url' | 'publishedAt' | 'expiresAt'>>;
};

/** Counts only this session's live tunnels and tunnel publications. Hosted previews do not occupy a tunnel slot. */
export class SessionPreviewSlots {
    private readonly active = new Map<string, CloudflarePreview>();
    private readonly publishing = new Map<string, PreviewMode>();

    constructor(private readonly reportExpired: (preview: InteractivePreviewEvent) => void) {}

    hasPublication(previewId: string): boolean {
        return this.publishing.has(previewId);
    }

    get(previewId: string): CloudflarePreview | undefined {
        return this.active.get(previewId);
    }

    status(): SessionPreviewStatus {
        const previews = [...this.active.values()].map(({ preview }) => ({
            id: preview.id,
            title: preview.title,
            url: preview.url,
            publishedAt: preview.publishedAt,
            expiresAt: preview.expiresAt,
        }));
        const publishingTunnels = [...this.publishing.values()].filter((mode) => mode === 'tunnel').length;
        const used = previews.length + publishingTunnels;
        return { limit: MAX_SESSION_TUNNEL_PREVIEWS, used, remaining: Math.max(0, MAX_SESSION_TUNNEL_PREVIEWS - used), publishing: publishingTunnels, previews };
    }

    reserve(previewId: string, mode: PreviewMode): boolean {
        if (this.publishing.has(previewId)) return false;
        if (mode === 'tunnel' && this.status().remaining === 0) return false;
        this.publishing.set(previewId, mode);
        return true;
    }

    finishPublication(previewId: string): void {
        this.publishing.delete(previewId);
    }

    add(previewId: string, preview: CloudflarePreview): void {
        this.active.set(previewId, preview);
        this.finishPublication(previewId);
    }

    expired(previewId: string, event: InteractivePreviewEvent): void {
        this.active.delete(previewId);
        this.reportExpired(event);
    }

    close(previewId: string): boolean {
        const running = this.active.get(previewId);
        if (!running) return false;
        running.stop();
        this.active.delete(previewId);
        return true;
    }

    stopAll(): void {
        for (const previewId of [...this.active.keys()]) this.close(previewId);
    }
}
