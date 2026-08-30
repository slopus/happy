export type PublicSessionAttachmentKind = 'image' | 'audio' | 'video' | 'file';

export type PublicSessionBlockV1 =
    | { type: 'text'; markdown: string }
    | { type: 'thinking'; markdown: string }
    | { type: 'tool'; name: string; status: 'running' | 'completed' | 'failed'; title?: string; body?: string }
    | {
        type: 'attachment';
        attachmentId: string;
        kind: PublicSessionAttachmentKind;
        name: string;
        mimeType: string;
        size: number;
    };

export type PublicSessionMessageV1 = {
    id: string;
    role: 'user' | 'assistant' | 'system';
    createdAt: number;
    blocks: PublicSessionBlockV1[];
};

export type PublicSessionSnapshotV1 = {
    version: 1;
    title: string;
    sharedAt: number;
    messages: PublicSessionMessageV1[];
};

export type PublicSessionAttachmentJob = {
    attachmentId: string;
    sourceRef: string;
    encrypted: boolean;
    kind: PublicSessionAttachmentKind;
    name: string;
    mimeType: string;
    size: number;
};

export type PublicSessionShareState = {
    active: boolean;
    publicId: string | null;
    publishedAt: number | null;
};
