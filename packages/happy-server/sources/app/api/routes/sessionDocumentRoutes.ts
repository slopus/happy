import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { s3bucket, s3client, s3public } from "@/storage/files";
import { randomKey } from "@/utils/randomKey";
import { log } from "@/utils/log";

const MAX_FILE_SIZE = 32 * 1024 * 1024; // 32MB (matches Claude API limit)

const ALLOWED_TYPES: Record<string, string> = {
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'text/markdown': 'md',
    'text/html': 'html',
    'text/xml': 'xml',
    'application/json': 'json',
    'application/xml': 'xml',
    'text/x-python': 'py',
    'text/javascript': 'js',
    'text/typescript': 'ts',
    'text/x-java': 'java',
    'text/x-c': 'c',
    'text/x-c++': 'cpp',
    'text/x-go': 'go',
    'text/x-rust': 'rs',
    'text/x-ruby': 'rb',
    'text/x-php': 'php',
    'text/x-swift': 'swift',
    'text/x-kotlin': 'kt',
    'text/x-yaml': 'yaml',
    'application/x-yaml': 'yaml',
    'application/yaml': 'yaml',
};

// Map file extensions to MIME types (for when browser sends octet-stream)
const EXT_TO_MIME: Record<string, string> = {
    'pdf': 'application/pdf',
    'txt': 'text/plain',
    'csv': 'text/csv',
    'md': 'text/markdown',
    'html': 'text/html',
    'xml': 'text/xml',
    'json': 'application/json',
    'yaml': 'application/yaml',
    'yml': 'application/yaml',
    'py': 'text/x-python',
    'js': 'text/javascript',
    'ts': 'text/typescript',
    'jsx': 'text/javascript',
    'tsx': 'text/typescript',
    'java': 'text/x-java',
    'c': 'text/x-c',
    'h': 'text/x-c',
    'cpp': 'text/x-c++',
    'go': 'text/x-go',
    'rs': 'text/x-rust',
    'rb': 'text/x-ruby',
    'php': 'text/x-php',
    'swift': 'text/x-swift',
    'kt': 'text/x-kotlin',
    'sh': 'text/x-shellscript',
    'sql': 'text/x-sql',
    'toml': 'text/plain',
    'ini': 'text/plain',
    'cfg': 'text/plain',
    'env': 'text/plain',
    'log': 'text/plain',
};

// Resolve actual MIME type: if browser sent octet-stream, infer from filename
function resolveContentType(contentType: string, fileName?: string): string {
    if (contentType && contentType !== 'application/octet-stream' && contentType !== '') {
        return contentType;
    }
    if (fileName) {
        const ext = fileName.split('.').pop()?.toLowerCase();
        if (ext && ext in EXT_TO_MIME) {
            return EXT_TO_MIME[ext];
        }
    }
    // Fallback: treat unknown files as plain text (safe for Claude)
    return 'text/plain';
}

// Also allow any text/* type not explicitly listed
function isAllowedType(contentType: string): boolean {
    return contentType in ALLOWED_TYPES || contentType.startsWith('text/');
}

function getExtension(contentType: string, fileName?: string): string {
    // Try to get extension from filename first
    if (fileName) {
        const ext = fileName.split('.').pop();
        if (ext && ext.length <= 10) return ext;
    }
    return ALLOWED_TYPES[contentType] || 'txt';
}

export function sessionDocumentRoutes(app: Fastify) {

    // POST /v1/sessions/:id/documents - Upload a document for a chat session
    app.post('/v1/sessions/:id/documents', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            querystring: z.object({
                fileName: z.string().optional(),
            }),
        },
        config: {
            rawBody: true,
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const sessionId = request.params.id;

        // Verify session belongs to user
        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Get raw body as buffer
        const body = request.body as Buffer;
        if (!body || body.length === 0) {
            return reply.code(400).send({ error: 'No document data provided' });
        }

        if (body.length > MAX_FILE_SIZE) {
            return reply.code(413).send({ error: 'Document too large (max 32MB)' });
        }

        // Resolve and validate content type
        const queryFileName = (request.query as any).fileName;
        const contentType = resolveContentType(request.headers['content-type'] || '', queryFileName);
        if (!isAllowedType(contentType)) {
            return reply.code(400).send({
                error: `Unsupported document type: ${contentType}. Allowed: PDF and text-based files.`
            });
        }

        try {
            const ext = getExtension(contentType, queryFileName);
            const key = randomKey('doc');
            const fileName = queryFileName || `${key}.${ext}`;
            const s3Path = `chat-documents/${userId}/${sessionId}/${key}.${ext}`;

            await s3client.putObject(s3bucket, s3Path, body, body.length, {
                'Content-Type': contentType,
                'Content-Disposition': `inline; filename="${fileName}"`,
            });

            const publicUrl = `${s3public}/${s3Path}`;

            log({ module: 'session-document', userId, sessionId }, `Document uploaded: ${s3Path} (${body.length} bytes)`);

            return reply.send({
                url: publicUrl,
                mediaType: contentType,
                fileName,
                fileSize: body.length,
            });
        } catch (error: any) {
            log({ module: 'session-document', level: 'error', userId, sessionId }, `Failed to upload document: ${error.message}`);
            return reply.code(500).send({ error: 'Failed to process document' });
        }
    });
}
