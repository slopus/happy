import * as fs from "fs";
import * as path from "path";
import { Fastify } from "../types";
import { getLocalFilesDir, isLocalStorage, isPublicFilePath, s3bucket, s3client } from "@/storage/files";

const PRESIGNED_TTL_SECONDS = 15 * 60;

export function isReservedSessionSharePath(filePath: string): boolean {
    return filePath === 'private/session-shares'
        || filePath.startsWith('private/session-shares/')
        || filePath === 'public/session-shares'
        || filePath.startsWith('public/session-shares/');
}

export function fileRoutes(app: Fastify) {
    app.get('/files/*', async function (request, reply) {
        const filePath = (request.params as any)['*'];
        if (typeof filePath !== "string" || filePath.includes("..") || isReservedSessionSharePath(filePath)) {
            return reply.code(403).send('Forbidden');
        }

        if (isLocalStorage()) {
            const baseDir = path.resolve(getLocalFilesDir());
            const fullPath = path.resolve(baseDir, filePath);
            if (!fullPath.startsWith(baseDir + path.sep)) {
                return reply.code(403).send('Forbidden');
            }
            if (!fs.existsSync(fullPath)) {
                return reply.code(404).send('Not found');
            }
            const stream = fs.createReadStream(fullPath);
            return reply.send(stream);
        }

        if (!isPublicFilePath(filePath)) {
            return reply.code(404).send('Not found');
        }

        const url = await s3client.presignedGetObject(s3bucket, filePath, PRESIGNED_TTL_SECONDS);
        return reply.redirect(url);
    });
}
