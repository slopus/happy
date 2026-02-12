import sharp from "sharp";
import { randomKey } from "@/utils/randomKey";
import { processImage } from "@/storage/processImage";
import { s3bucket, s3client, s3public } from "@/storage/files";
import { db } from "@/storage/db";

const MAX_DIMENSION = 1024;
const MAX_SIZE_BYTES = 128 * 1024; // 128KB
const JPEG_QUALITY = 80;

interface UploadChatImageResult {
    url: string;
    path: string;
    width: number;
    height: number;
    thumbhash: string;
    mimeType: string;
}

/**
 * Compress image server-side as a safety net.
 * Only compresses if the image exceeds size or dimension limits.
 * Images already within limits are passed through unchanged.
 */
async function compressForUpload(imageBuffer: Buffer, mimeType: string): Promise<{ buffer: Buffer; width: number; height: number; mimeType: string }> {
    const meta = await sharp(imageBuffer).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;

    const needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
    const needsCompress = imageBuffer.length > MAX_SIZE_BYTES;

    // Skip compression if image is already within limits
    if (!needsResize && !needsCompress) {
        return { buffer: imageBuffer, width, height, mimeType };
    }

    let pipeline = sharp(imageBuffer);

    if (needsResize) {
        pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true });
    }

    const output = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer({ resolveWithObject: true });

    return {
        buffer: output.data,
        width: output.info.width,
        height: output.info.height,
        mimeType: "image/jpeg",
    };
}

/**
 * Uploads a chat image to S3 and returns the public URL and metadata.
 *
 * Images are stored in public/users/{userId}/chat/{sessionId}/ directory.
 * The function compresses the image (resize to 1024px max + JPEG quality),
 * generates a thumbhash for preview rendering, then uploads to S3 and
 * records in the database.
 *
 * @param userId - The ID of the user uploading the image
 * @param sessionId - The chat session ID for organizing uploads
 * @param imageBuffer - The raw image data as a Buffer
 * @param mimeType - The MIME type of the image (image/png or image/jpeg)
 * @returns Upload result with URL, path, dimensions, thumbhash, and mime type
 */
export async function chatImageUpload(
    userId: string,
    sessionId: string,
    imageBuffer: Buffer,
    mimeType: string
): Promise<UploadChatImageResult> {
    // Compress image server-side if needed (resize + JPEG quality)
    const compressed = await compressForUpload(imageBuffer, mimeType);

    // Process image to get thumbhash
    const processed = await processImage(compressed.buffer);

    // Generate unique filename
    const key = randomKey("img");
    const extension = compressed.mimeType === "image/png" ? "png" : "jpg";
    const filename = `${key}.${extension}`;
    const path = `public/users/${userId}/chat/${sessionId}/${filename}`;

    // Upload to S3
    await s3client.putObject(s3bucket, path, compressed.buffer, compressed.buffer.length, {
        "Content-Type": compressed.mimeType,
    });

    // Record in database
    await db.uploadedFile.create({
        data: {
            accountId: userId,
            path,
            width: compressed.width,
            height: compressed.height,
            thumbhash: processed.thumbhash,
        },
    });

    return {
        url: `${s3public}/${path}`,
        path,
        width: compressed.width,
        height: compressed.height,
        thumbhash: processed.thumbhash,
        mimeType: compressed.mimeType,
    };
}
