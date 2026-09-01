import type { PublicSessionSnapshot } from '@slopus/happy-wire';
import type { ShareSource } from '../records';

export type TranscriptCandidate = {
    provider: Extract<ShareSource, 'codex' | 'claude-code'>;
    path: string;
    cwd?: string;
    modifiedAt?: number;
};

type ResolvedAttachmentSource =
    | { path: string; bytes?: never }
    | { path?: never; bytes: Buffer };

export type ResolvedAttachment = ResolvedAttachmentSource & {
    attachmentId: string;
    name: string;
    mimeType: string;
    kind: 'image' | 'audio' | 'video' | 'file';
    size: number;
    sha256: string;
};

export type ConvertedSnapshot = {
    snapshot: PublicSessionSnapshot;
    attachments: ResolvedAttachment[];
    unresolvedAttachments: string[];
};

export type TranscriptInspection = {
    candidate: TranscriptCandidate;
    title: string;
    messageCount: number;
    attachmentCount: number;
    attachmentBytes: number;
    unresolvedAttachments: string[];
};

export interface TranscriptAdapter {
    readonly provider: TranscriptCandidate['provider'];
    convert(candidate: TranscriptCandidate): Promise<ConvertedSnapshot>;
}
