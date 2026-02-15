// Image upload utility for native (iOS/Android).
//
// Picks images from gallery via expo-image-picker, resizes via
// expo-image-manipulator, and uploads to the CLI machine via RPC writeFile.

import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { HappyError } from '@/utils/errors';
import {
    MAX_IMAGES,
    MAX_DIMENSION,
    JPEG_QUALITY,
    MAX_BASE64_SIZE,
    isValidImageBase64,
    uploadImage,
    type MultiImageUploadResult,
} from '@/utils/imageUpload.shared';

export { MAX_IMAGES } from '@/utils/imageUpload.shared';
export type { MultiImageUploadResult } from '@/utils/imageUpload.shared';
export { uploadImage as uploadBase64Image } from '@/utils/imageUpload.shared';

/** Resize image URI via expo-image-manipulator, return JPEG base64 */
async function resizeAndEncode(uri: string, width: number, height: number): Promise<string> {
    const context = ImageManipulator.manipulate(uri);

    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        if (width >= height) {
            context.resize({ width: MAX_DIMENSION });
        } else {
            context.resize({ height: MAX_DIMENSION });
        }
    }

    const ref = await context.renderAsync();
    const result = await ref.saveAsync({
        base64: true,
        compress: JPEG_QUALITY,
        format: SaveFormat.JPEG,
    });

    if (!result.base64) {
        throw new HappyError('Failed to process image', false);
    }

    if (!isValidImageBase64(result.base64)) {
        throw new HappyError('Invalid image format', false);
    }

    if (result.base64.length > MAX_BASE64_SIZE) {
        throw new HappyError('Image is too large to send', false);
    }

    return result.base64;
}

/** Pick multiple images from gallery, resize, and upload each. Returns paths + failure count, or null if canceled. */
export async function pickAndUploadImages(sessionId: string, currentCount: number): Promise<MultiImageUploadResult | null> {
    const remaining = MAX_IMAGES - currentCount;
    if (remaining <= 0) return null;

    const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: JPEG_QUALITY,
        allowsMultipleSelection: true,
        selectionLimit: remaining,
    });
    if (result.canceled || !result.assets?.length) return null;

    const results = await Promise.allSettled(
        result.assets.map(async (asset) => {
            const base64 = await resizeAndEncode(asset.uri, asset.width, asset.height);
            return uploadImage(sessionId, base64);
        })
    );

    const paths: string[] = [];
    let failedCount = 0;
    for (const r of results) {
        if (r.status === 'fulfilled') {
            paths.push(r.value);
        } else {
            console.warn('Image upload failed:', r.reason instanceof Error ? r.reason.message : r.reason);
            failedCount++;
        }
    }

    return { paths, failedCount };
}

/** Convert a Blob to resized base64 — web only, stub on native. */
export async function blobToResizedBase64(_blob: Blob): Promise<string> {
    throw new HappyError('Image paste is not supported on this platform', false);
}
