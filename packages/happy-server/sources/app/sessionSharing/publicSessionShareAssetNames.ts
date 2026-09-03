import { z } from 'zod';
import { isReservedPublicSessionAssetName } from './publicSessionCoverClaims';

export function normalizePublicSessionAssetName(name: string): string {
    const basename = name.split(/[\\/]/).at(-1) ?? '';
    const safeName = basename.replace(/[\u0000-\u001f\u007f"]/g, '_');
    return safeName || 'attachment';
}

export const publicSessionUserAssetNameSchema = z.string()
    .min(1)
    .max(500)
    .transform(normalizePublicSessionAssetName)
    .refine((name) => !isReservedPublicSessionAssetName(name), 'Reserved attachment name');
