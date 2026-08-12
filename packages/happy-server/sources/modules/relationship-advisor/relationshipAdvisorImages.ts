import * as fs from 'fs';
import * as path from 'path';

import { getLocalFilesDir, isLocalStorage, s3bucket, s3client } from '@/storage/files';

const ADVISOR_IMAGE_READ_TTL_SECONDS = 10 * 60;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
};

function assertOwnedImageRef(userId: string, ref: string) {
    const prefix = `advisor/${userId}/`;
    const filename = ref.startsWith(prefix) ? ref.slice(prefix.length) : '';
    if (!/^[a-f0-9-]{20,64}\.(?:jpg|png|webp)$/.test(filename)) {
        throw new Error('Invalid relationship advisor image reference');
    }
}

export async function deleteRelationshipAdvisorImages(userId: string, refs: string[]): Promise<void> {
    for (const ref of refs) assertOwnedImageRef(userId, ref);
    if (!isLocalStorage()) {
        await Promise.all(refs.map((ref) => s3client.removeObject(s3bucket, ref)));
        return;
    }
    for (const ref of refs) {
        fs.rmSync(path.join(getLocalFilesDir(), ref), { force: true });
    }
}

export async function resolveRelationshipAdvisorImageUrls(userId: string, refs: string[]): Promise<string[]> {
    for (const ref of refs) assertOwnedImageRef(userId, ref);

    if (!isLocalStorage()) {
        return Promise.all(refs.map((ref) => s3client.presignedGetObject(
            s3bucket,
            ref,
            ADVISOR_IMAGE_READ_TTL_SECONDS,
        )));
    }

    return refs.map((ref) => {
        const extension = path.extname(ref).toLowerCase();
        const mimeType = MIME_BY_EXTENSION[extension];
        const bytes = fs.readFileSync(path.join(getLocalFilesDir(), ref));
        return `data:${mimeType};base64,${bytes.toString('base64')}`;
    });
}
