import type { FastifyInstance } from "fastify";
import { extname } from "node:path";
import { hasPublicFileRead, readPublicFile } from "@/storage/files";
import { normalizePublicPath } from "@/flavors/light/files";

type AnyFastifyInstance = FastifyInstance<any, any, any, any, any>;

export function enablePublicFiles(app: AnyFastifyInstance) {
    if (!hasPublicFileRead()) {
        return;
    }

    app.get('/files/*', async (request, reply) => {
        try {
            const raw = (request.params as { '*': string | undefined })['*'] || '';
            const decoded = decodeURIComponent(raw);
            const path = normalizePublicPath(decoded);
            const bytes = await readPublicFile(path);

            const ext = extname(path).toLowerCase();
            if (ext === '.png') {
                reply.header('content-type', 'image/png');
            } else if (ext === '.jpg' || ext === '.jpeg') {
                reply.header('content-type', 'image/jpeg');
            } else if (ext === '.webp') {
                reply.header('content-type', 'image/webp');
            } else if (ext === '.gif') {
                reply.header('content-type', 'image/gif');
            } else {
                reply.header('content-type', 'application/octet-stream');
            }

            reply.header('cache-control', 'public, max-age=31536000, immutable');
            return reply.send(Buffer.from(bytes));
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
}
