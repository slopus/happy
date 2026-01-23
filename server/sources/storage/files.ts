import * as Minio from 'minio';
import { ensureLightFilesDir, getLightPublicUrl, readLightPublicFile, writeLightPublicFile } from '@/flavors/light/files';

export type ImageRef = {
    width: number;
    height: number;
    thumbhash: string;
    path: string;
}

export type PublicFilesBackend = {
    init(): Promise<void>;
    getPublicUrl(path: string): string;
    writePublicFile(path: string, data: Uint8Array): Promise<void>;
    readPublicFile?(path: string): Promise<Uint8Array>;
}

let backend: PublicFilesBackend | null = null;

export function initFilesS3FromEnv(env: NodeJS.ProcessEnv = process.env): void {
    const s3Host = requiredEnv(env, 'S3_HOST');
    const s3PortRaw = env.S3_PORT?.trim();
    let s3Port: number | undefined;
    if (s3PortRaw) {
        const parsed = parseInt(s3PortRaw, 10);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
            throw new Error(`Invalid S3_PORT: ${s3PortRaw}`);
        }
        s3Port = parsed;
    }
    const s3UseSSL = env.S3_USE_SSL ? env.S3_USE_SSL === 'true' : true;

    const s3bucket = requiredEnv(env, 'S3_BUCKET');
    const s3public = requiredEnv(env, 'S3_PUBLIC_URL');

    const s3client = new Minio.Client({
        endPoint: s3Host,
        port: s3Port,
        useSSL: s3UseSSL,
        accessKey: requiredEnv(env, 'S3_ACCESS_KEY'),
        secretKey: requiredEnv(env, 'S3_SECRET_KEY'),
    });

    backend = {
        async init() {
            const exists = await s3client.bucketExists(s3bucket);
            if (!exists) {
                throw new Error(`S3 bucket does not exist: ${s3bucket}`);
            }
        },
        getPublicUrl(path: string) {
            return `${s3public}/${path}`;
        },
        async writePublicFile(path: string, data: Uint8Array) {
            await s3client.putObject(s3bucket, path, Buffer.from(data));
        },
    };
}

export function initFilesLocalFromEnv(env: NodeJS.ProcessEnv = process.env): void {
    backend = {
        async init() {
            await ensureLightFilesDir(env);
        },
        getPublicUrl(path: string) {
            return getLightPublicUrl(env, path);
        },
        async writePublicFile(path: string, data: Uint8Array) {
            await writeLightPublicFile(env, path, data);
        },
        async readPublicFile(path: string) {
            return await readLightPublicFile(env, path);
        }
    };
}

export function hasPublicFileRead(): boolean {
    return Boolean(backend && backend.readPublicFile);
}

export async function loadFiles(): Promise<void> {
    if (!backend) {
        throw new Error('Files backend not initialized');
    }
    await backend.init();
}

export function getPublicUrl(path: string): string {
    if (!backend) {
        throw new Error('Files backend not initialized');
    }
    return backend.getPublicUrl(path);
}

export async function writePublicFile(path: string, data: Uint8Array): Promise<void> {
    if (!backend) {
        throw new Error('Files backend not initialized');
    }
    await backend.writePublicFile(path, data);
}

export async function readPublicFile(path: string): Promise<Uint8Array> {
    if (!backend?.readPublicFile) {
        throw new Error('Public file read is not supported');
    }
    return await backend.readPublicFile(path);
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
    const v = env[key]?.trim();
    if (!v) {
        throw new Error(`Missing required env var: ${key}`);
    }
    return v;
}
