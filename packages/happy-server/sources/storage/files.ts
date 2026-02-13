import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'minio';

const useLocalStorage = !process.env.S3_HOST;
const dataDir = process.env.DATA_DIR || './data';
const localFilesDir = path.join(dataDir, 'files');

// S3 config (only used when S3_HOST is set)
let s3client: any = null;
let s3bucket: string = '';
let s3host: string = '';
let s3public: string = '';

if (!useLocalStorage) {
    const s3Port = process.env.S3_PORT ? parseInt(process.env.S3_PORT, 10) : undefined;
    const s3UseSSL = process.env.S3_USE_SSL ? process.env.S3_USE_SSL === 'true' : true;
    const s3Region = process.env.S3_REGION || 'us-east-1';
    s3client = new Client({
        endPoint: process.env.S3_HOST!,
        port: s3Port,
        useSSL: s3UseSSL,
        accessKey: process.env.S3_ACCESS_KEY!,
        secretKey: process.env.S3_SECRET_KEY!,
        region: s3Region,
    });
    s3bucket = process.env.S3_BUCKET!;
    s3host = process.env.S3_HOST!;
    s3public = process.env.S3_PUBLIC_URL!;
}

export { s3client, s3bucket, s3host };

export async function loadFiles() {
    if (useLocalStorage) {
        fs.mkdirSync(localFilesDir, { recursive: true });
        return;
    }
    await s3client.bucketExists(s3bucket);
}

export function getPublicUrl(filePath: string) {
    if (useLocalStorage) {
        const baseUrl = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || '3005'}`;
        return `${baseUrl}/files/${filePath}`;
    }
    return `${s3public}/${filePath}`;
}

export function isLocalStorage() {
    return useLocalStorage;
}

export function getLocalFilesDir() {
    return localFilesDir;
}

export async function putLocalFile(filePath: string, data: Buffer) {
    const fullPath = path.join(localFilesDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, data);
}

export type ImageRef = {
    width: number;
    height: number;
    thumbhash: string;
    path: string;
}
