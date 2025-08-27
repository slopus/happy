import * as Minio from 'minio';

export const s3client = new Minio.Client({
    endPoint: process.env.S3_HOST!,
    useSSL: true,
    accessKey: process.env.S3_ACCESS_KEY!,
    secretKey: process.env.S3_SECRET_KEY!,
});

export const s3bucket = process.env.S3_BUCKET!;

export const s3host = process.env.S3_HOST!

export async function loadFiles() {
    await s3client.bucketExists(s3bucket); // Throws if bucket does not exist or is not accessible
}

export type ImageRef = {
    width: number;
    height: number;
    thumbhash: string;
    path: string;
}