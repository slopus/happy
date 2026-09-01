import type {
    PublicSessionBlock,
    PublicSessionSnapshot,
    PublicShareAssetKind,
} from '@slopus/happy-wire';

export type PublicSessionAttachmentKind = PublicShareAssetKind;
export type PublicSessionBlockV1 = PublicSessionBlock;
export type PublicSessionSnapshotV1 = PublicSessionSnapshot;
export type PublicSessionMessageV1 = PublicSessionSnapshot['messages'][number];

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
