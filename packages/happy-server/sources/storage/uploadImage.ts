import { randomKey } from "@/utils/randomKey";
import { processImage } from "./processImage";
import { s3bucket, s3client, s3host } from "./files";
import { db } from "./db";

export async function uploadImage(userId: string, directory: string, prefix: string, url: string, src: Buffer) {

    // Check if image already exists
    const existing = await db.uploadedFile.findFirst({
        where: {
            reuseKey: 'image-url:' + url
        }
    });

    if (existing && existing.thumbhash && existing.width && existing.height) {
        return {
            path: existing.path,
            thumbhash: existing.thumbhash,
            width: existing.width,
            height: existing.height
        };
    }

    // Process image
    const processed = await processImage(src);
    const key = randomKey(prefix);
    let filename = `${key}.${processed.format === 'png' ? 'png' : 'jpg'}`;
    await s3client.putObject(s3bucket, 'public/users/' + userId + '/' + directory + '/' + filename, src);
    await db.uploadedFile.create({
        data: {
            accountId: userId,
            path: `public/users/${userId}/${directory}/${filename}`,
            reuseKey: 'image-url:' + url,
            width: processed.width,
            height: processed.height,
            thumbhash: processed.thumbhash
        }
    });
    return {
        path: `public/users/${userId}/${directory}/${filename}`,
        thumbhash: processed.thumbhash,
        width: processed.width,
        height: processed.height
    }
}

export function resolveImageUrl(path: string) {
    return `https://${s3host}/${s3bucket}/${path}`;
}