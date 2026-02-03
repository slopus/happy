import { randomKey } from "@/utils/randomKey";
import { processImage } from "@/storage/processImage";
import { s3bucket, s3client, s3public } from "@/storage/files";
import { db } from "@/storage/db";

interface UploadChatImageResult {
    url: string;
    path: string;
    width: number;
    height: number;
    thumbhash: string;
    mimeType: string;
}

/**
 * Uploads a chat image to S3 and returns the public URL and metadata.
 *
 * Images are stored in public/users/{userId}/chat/{sessionId}/ directory.
 * The function processes the image to extract dimensions and generate a thumbhash
 * for efficient preview rendering, then uploads to S3 and records in the database.
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
    // Process image to get dimensions and thumbhash
    const processed = await processImage(imageBuffer);

    // Generate unique filename
    const key = randomKey("img");
    const extension = mimeType === "image/png" ? "png" : "jpg";
    const filename = `${key}.${extension}`;
    const path = `public/users/${userId}/chat/${sessionId}/${filename}`;

    // Upload to S3
    await s3client.putObject(s3bucket, path, imageBuffer, imageBuffer.length, {
        "Content-Type": mimeType,
    });

    // Record in database
    await db.uploadedFile.create({
        data: {
            accountId: userId,
            path,
            width: processed.width,
            height: processed.height,
            thumbhash: processed.thumbhash,
        },
    });

    return {
        url: `${s3public}/${path}`,
        path,
        width: processed.width,
        height: processed.height,
        thumbhash: processed.thumbhash,
        mimeType,
    };
}
