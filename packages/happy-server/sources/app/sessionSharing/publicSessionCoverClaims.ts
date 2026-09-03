import { z } from 'zod';
import {
    publicSessionCoverAttributionSchema,
    type PublicSessionSnapshot,
} from './publicSessionShareSchemas';
import { deletePublicShareAsset } from './publicSessionShareStorage';
import type { ImportedPublicSessionCover } from './publicSessionCoverProvider';
import { log } from '@/utils/log';

const PUBLIC_SHARE_INTERNAL_ASSET_NAME_PREFIX = '__paws_internal__:';
const LEGACY_PEXELS_INTERNAL_ASSET_NAME_PREFIXES = ['pexels-cover-v1:', 'pexels-cover-pending:'];
const PEXELS_COVER_METADATA_PREFIX = `${PUBLIC_SHARE_INTERNAL_ASSET_NAME_PREFIX}pexels-cover-v1:`;
const PEXELS_COVER_CLAIM_PREFIX = `${PUBLIC_SHARE_INTERNAL_ASSET_NAME_PREFIX}pexels-claim-v1:`;
const CLONE_COVER_CLAIM_PREFIX = `${PUBLIC_SHARE_INTERNAL_ASSET_NAME_PREFIX}clone-claim-v1:`;
const MAX_INTERNAL_ASSET_NAME_BYTES = 4 * 1024;

const persistedPexelsCoverMetadataSchema = z.object({
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    attribution: publicSessionCoverAttributionSchema,
}).strict();
const pexelsCoverClaimSchema = z.object({
    photoId: z.number().int().positive(),
    token: z.string().uuid(),
    leaseUntil: z.number().int().positive(),
}).strict();
const cloneCoverClaimSchema = z.object({
    token: z.string().uuid(),
    leaseUntil: z.number().int().positive(),
}).strict();

export const PEXELS_COVER_CLAIM_LEASE_MS = 2 * 60 * 1000;
export const CLONE_COVER_CLAIM_LEASE_MS = 2 * 60 * 1000;
export const PEXELS_PENDING_SHA256 = '0'.repeat(64);

export type PersistedPexelsCoverMetadata = z.infer<typeof persistedPexelsCoverMetadataSchema>;

export function isReservedPublicSessionAssetName(name: string): boolean {
    return name.startsWith(PUBLIC_SHARE_INTERNAL_ASSET_NAME_PREFIX)
        || LEGACY_PEXELS_INTERNAL_ASSET_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function encodeInternalAssetName(prefix: string, value: unknown): string | null {
    const encoded = `${prefix}${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    return Buffer.byteLength(encoded, 'utf8') <= MAX_INTERNAL_ASSET_NAME_BYTES ? encoded : null;
}

function decodeInternalAssetName<T>(name: string, prefix: string, schema: z.ZodType<T>): T | null {
    if (!name.startsWith(prefix) || Buffer.byteLength(name, 'utf8') > MAX_INTERNAL_ASSET_NAME_BYTES) return null;
    const encoded = name.slice(prefix.length);
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    try {
        const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
        if (Buffer.from(decoded, 'utf8').toString('base64url') !== encoded) return null;
        return schema.parse(JSON.parse(decoded));
    } catch {
        return null;
    }
}

export function encodePersistedPexelsCoverMetadata(imported: ImportedPublicSessionCover): string | null {
    const parsed = persistedPexelsCoverMetadataSchema.safeParse({
        width: imported.width,
        height: imported.height,
        attribution: imported.attribution,
    });
    return parsed.success ? encodeInternalAssetName(PEXELS_COVER_METADATA_PREFIX, parsed.data) : null;
}

export function decodePersistedPexelsCoverMetadata(name: string): PersistedPexelsCoverMetadata | null {
    return decodeInternalAssetName(name, PEXELS_COVER_METADATA_PREFIX, persistedPexelsCoverMetadataSchema);
}

export function encodePexelsCoverClaim(photoId: number, token: string, leaseUntil: number): string {
    const name = encodeInternalAssetName(PEXELS_COVER_CLAIM_PREFIX, { photoId, token, leaseUntil });
    if (!name) throw new Error('Pexels cover claim exceeds internal metadata limit');
    return name;
}

export function decodePexelsCoverClaim(name: string): z.infer<typeof pexelsCoverClaimSchema> | null {
    return decodeInternalAssetName(name, PEXELS_COVER_CLAIM_PREFIX, pexelsCoverClaimSchema);
}

export function encodeCloneCoverClaim(token: string, leaseUntil: number): string {
    const name = encodeInternalAssetName(CLONE_COVER_CLAIM_PREFIX, { token, leaseUntil });
    if (!name) throw new Error('Clone cover claim exceeds internal metadata limit');
    return name;
}

export function decodeCloneCoverClaim(name: string): z.infer<typeof cloneCoverClaimSchema> | null {
    return decodeInternalAssetName(name, CLONE_COVER_CLAIM_PREFIX, cloneCoverClaimSchema);
}

export function canonicalImportedCoverResponse(
    assetId: string,
    mimeType: string,
    size: number,
    metadata: PersistedPexelsCoverMetadata,
) {
    return {
        assetId,
        mimeType,
        size,
        width: metadata.width,
        height: metadata.height,
        attribution: metadata.attribution,
    };
}

export function coverMatchesPersistedAssetMetadata(
    cover: NonNullable<Extract<PublicSessionSnapshot, { version: 2 }>['appearance']['cover']>,
    assetName: string,
): boolean {
    const persisted = decodePersistedPexelsCoverMetadata(assetName);
    if (!persisted) return !isReservedPublicSessionAssetName(assetName) && cover.attribution === undefined;
    const attribution = cover.attribution;
    return Boolean(
        attribution
        && cover.width === persisted.width
        && cover.height === persisted.height
        && attribution.photoId === persisted.attribution.photoId
        && attribution.photographer === persisted.attribution.photographer
        && attribution.photographerUrl === persisted.attribution.photographerUrl
        && attribution.photoUrl === persisted.attribution.photoUrl,
    );
}

type ClaimIdentity = {
    id: string;
    shareId: string;
    generation: string;
    name: string;
    storagePath: string;
};

export function publicSessionCoverClaimWhere(identity: ClaimIdentity) {
    return { ...identity, uploadedAt: null as null };
}

export async function cleanupPublicSessionCoverObjectWhenPossible(
    storagePath: string,
    details: { shareId: string; generation: string; assetId: string },
    options: {
        module: string;
        message: string;
        isReferenced?: () => Promise<boolean>;
    },
): Promise<boolean> {
    try {
        if (options.isReferenced && await options.isReferenced()) return false;
        await deletePublicShareAsset(storagePath);
        return true;
    } catch (error) {
        log({ module: options.module, level: 'error', ...details, error }, options.message);
        return false;
    }
}
