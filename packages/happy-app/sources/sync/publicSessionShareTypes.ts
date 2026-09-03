import type {
    PublicSessionBlock,
    PublicSessionSnapshot,
    PublicSessionSnapshotV1 as WirePublicSessionSnapshotV1,
    PublicSessionSnapshotV2,
    PublicShareAssetKind,
} from '@slopus/happy-wire';

export type PublicSessionAttachmentKind = PublicShareAssetKind;
export type PublicSessionBlockV1 = PublicSessionBlock;
export type PublicSessionSnapshotV1 = WirePublicSessionSnapshotV1;
export type { PublicSessionSnapshot };
export type PublicSessionMessageV1 = PublicSessionSnapshotV1['messages'][number];

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
    appearance?: PublicSessionSnapshotV2['appearance'];
};
