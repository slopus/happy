import { extname, isAbsolute } from 'node:path';

export type MediaArtifactDescriptor = {
    kind: 'audio' | 'video';
    mimeType: string;
};

const MEDIA_TYPES: Readonly<Record<string, MediaArtifactDescriptor>> = {
    '.mp4': { kind: 'video', mimeType: 'video/mp4' },
    '.m4v': { kind: 'video', mimeType: 'video/x-m4v' },
    '.mov': { kind: 'video', mimeType: 'video/quicktime' },
    '.webm': { kind: 'video', mimeType: 'video/webm' },
    '.mp3': { kind: 'audio', mimeType: 'audio/mpeg' },
    '.m4a': { kind: 'audio', mimeType: 'audio/mp4' },
    '.aac': { kind: 'audio', mimeType: 'audio/aac' },
    '.wav': { kind: 'audio', mimeType: 'audio/wav' },
    '.flac': { kind: 'audio', mimeType: 'audio/flac' },
    '.ogg': { kind: 'audio', mimeType: 'audio/ogg' },
    '.opus': { kind: 'audio', mimeType: 'audio/opus' },
};

/** Validate a local MCP artifact and preserve a player-compatible MIME type. */
export function resolveMediaArtifact(filePath: string, requestedMimeType?: string): MediaArtifactDescriptor {
    if (!isAbsolute(filePath)) throw new Error('send_file requires an absolute local file path');
    const extension = extname(filePath).toLowerCase();
    const byExtension = MEDIA_TYPES[extension];
    const explicit = requestedMimeType?.trim().toLowerCase();

    if (explicit) {
        const kind = explicit.startsWith('video/')
            ? 'video'
            : explicit.startsWith('audio/')
                ? 'audio'
                : null;
        if (!kind) throw new Error(`Unsupported media type: ${requestedMimeType}`);
        if (byExtension && byExtension.kind !== kind) {
            throw new Error(`Media type ${requestedMimeType} does not match ${extension}`);
        }
        return { kind, mimeType: explicit };
    }

    if (!byExtension) throw new Error(`Unsupported media file: ${extension || '(no extension)'}`);
    return byExtension;
}
