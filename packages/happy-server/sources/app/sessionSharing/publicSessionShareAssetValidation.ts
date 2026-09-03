import * as crypto from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import type { PublicSessionCover, PublicSessionSnapshot } from './publicSessionShareSchemas';

const MAX_COVER_INPUT_PIXELS = 60_000_000;
const MAX_COVER_INPUT_DIMENSION = 20_000;

const MIME_BY_FORMAT = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
} as const;

export type PublicSessionShareAssetDescriptor = {
    assetId: string;
    kind: string;
    mimeType: string;
    size: number;
    name?: string;
};

export type StoredPublicSessionShareAsset = {
    id: string;
    kind: string;
    mimeType: string;
    size: number;
    sha256: string;
    storagePath: string;
};

export class PublicSessionCoverValidationError extends Error {
    override readonly name = 'PublicSessionCoverValidationError';

    constructor() {
        super('Shared cover validation failed');
    }
}

export function collectPublicSessionShareAssetManifest(snapshot: PublicSessionSnapshot): PublicSessionShareAssetDescriptor[] {
    const assets: PublicSessionShareAssetDescriptor[] = [];
    for (const message of snapshot.messages) {
        for (const block of message.blocks) {
            if (block.type !== 'attachment') continue;
            assets.push({
                assetId: block.attachmentId,
                kind: block.kind,
                mimeType: block.mimeType,
                size: block.size,
                name: block.name,
            });
        }
    }
    if (snapshot.version === 2 && snapshot.appearance.cover) {
        assets.push({
            assetId: snapshot.appearance.cover.assetId,
            kind: 'image',
            mimeType: snapshot.appearance.cover.mimeType,
            size: snapshot.appearance.cover.size,
        });
    }
    return assets;
}

export function manifestMetadataMatches(
    descriptor: PublicSessionShareAssetDescriptor,
    asset: StoredPublicSessionShareAsset & { name: string },
): boolean {
    return (descriptor.name === undefined || descriptor.name === asset.name)
        && descriptor.mimeType === asset.mimeType
        && descriptor.kind === asset.kind
        && descriptor.size === asset.size;
}

export function assertSafeDecodedCoverMetadata(metadata: Partial<Metadata>, cover: PublicSessionCover): void {
    const format = metadata.format as keyof typeof MIME_BY_FORMAT | undefined;
    const decodedMimeType = metadata.format === 'heif' && metadata.compression === 'av1'
        ? 'image/avif'
        : format
            ? MIME_BY_FORMAT[format]
            : undefined;
    const oriented = metadata.autoOrient;
    const pages = metadata.pages ?? 1;
    if (!format
        || decodedMimeType !== cover.mimeType
        || !metadata.width
        || !metadata.height
        || metadata.width > MAX_COVER_INPUT_DIMENSION
        || metadata.height > MAX_COVER_INPUT_DIMENSION
        || metadata.width * metadata.height > MAX_COVER_INPUT_PIXELS
        || pages !== 1
        || !oriented?.width
        || !oriented.height
        || oriented.width * oriented.height > MAX_COVER_INPUT_PIXELS
        || oriented.width !== cover.width
        || oriented.height !== cover.height) {
        throw new PublicSessionCoverValidationError();
    }
}

export async function validateUploadedPublicSessionCover(options: {
    cover: PublicSessionCover;
    asset: StoredPublicSessionShareAsset;
    readBytes: (storagePath: string, maxBytes: number) => Promise<Buffer>;
}): Promise<void> {
    try {
        const bytes = await options.readBytes(options.asset.storagePath, options.cover.size);
        if (bytes.length !== options.cover.size
            || bytes.length !== options.asset.size
            || crypto.createHash('sha256').update(bytes).digest('hex') !== options.asset.sha256) {
            throw new PublicSessionCoverValidationError();
        }
        const image = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_COVER_INPUT_PIXELS, animated: true });
        assertSafeDecodedCoverMetadata(await image.metadata(), options.cover);
        await image.rotate().resize(1, 1, { fit: 'fill' }).toBuffer();
    } catch (error) {
        if (error instanceof PublicSessionCoverValidationError) throw error;
        throw new PublicSessionCoverValidationError();
    }
}
