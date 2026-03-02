import { z } from "zod";
import { Fastify } from "../types";
import { db } from "@/storage/db";
import { log } from "@/utils/log";

const SharedMessageSchema = z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string(),
});

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

export function shareRoutes(app: Fastify) {

    // POST /v1/share - Create a shared session (requires auth)
    app.post('/v1/share', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                title: z.string().max(200).default(''),
                sessionId: z.string().optional(),
                messages: z.array(SharedMessageSchema).min(1).max(5000),
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    url: z.string(),
                }),
                500: z.object({
                    error: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { title, sessionId, messages } = request.body;

        try {
            const shared = await db.sharedSession.create({
                data: {
                    accountId: userId,
                    sessionId: sessionId || null,
                    title,
                    messages: messages as any,
                },
            });

            const baseUrl = process.env.WEBAPP_URL || 'https://app.304.systems';
            const url = `${baseUrl}/s/${shared.id}`;

            return reply.send({ id: shared.id, url });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to create shared session: ${error}`);
            return reply.code(500).send({ error: 'Failed to create shared session' });
        }
    });

    // GET /v1/share/:id - Get a shared session (NO auth required - public)
    app.get('/v1/share/:id', {
        schema: {
            params: z.object({
                id: z.string(),
            }),
            response: {
                200: z.object({
                    id: z.string(),
                    title: z.string(),
                    messages: z.array(SharedMessageSchema),
                    createdAt: z.string(),
                }),
                404: z.object({
                    error: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        const { id } = request.params;

        try {
            const shared = await db.sharedSession.findUnique({
                where: { id },
            });

            if (!shared) {
                return reply.code(404).send({ error: 'Shared session not found' });
            }

            // Increment view count (fire and forget)
            db.sharedSession.update({
                where: { id },
                data: { viewCount: { increment: 1 } },
            }).catch(() => {});

            return reply.send({
                id: shared.id,
                title: shared.title,
                messages: shared.messages as any,
                createdAt: shared.createdAt.toISOString(),
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get shared session: ${error}`);
            return reply.code(404).send({ error: 'Shared session not found' });
        }
    });

    // GET /s/:id - Public HTML page for shared session (SSR)
    app.get('/s/:id', {
        schema: {
            params: z.object({
                id: z.string(),
            }),
        },
    }, async (request, reply) => {
        const { id } = request.params;

        try {
            const shared = await db.sharedSession.findUnique({
                where: { id },
            });

            // Disable JSON serializer for HTML responses
            reply.serializer((payload: any) => payload);

            if (!shared) {
                reply.type('text/html').code(404);
                return reply.send('<html><body><h1>Not found</h1><p>This shared chat does not exist.</p></body></html>');
            }

            // Increment view count
            db.sharedSession.update({
                where: { id },
                data: { viewCount: { increment: 1 } },
            }).catch(() => {});

            const messages = shared.messages as Array<{ role: string; text: string }>;
            const title = shared.title || 'Shared Chat';
            const date = shared.createdAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

            const messagesHtml = messages.map(m => {
                const escapedText = escapeHtml(m.text)
                    .replace(/\n/g, '<br>');
                const roleLabel = m.role === 'user' ? '👤 User' : '🤖 Assistant';
                const roleClass = m.role === 'user' ? 'user' : 'assistant';
                return `<div class="message ${roleClass}"><div class="role">${roleLabel}</div><div class="text">${escapedText}</div></div>`;
            }).join('\n');

            const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} — Happy</title>
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="Shared AI chat conversation">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d0d0d; color: #e0e0e0; line-height: 1.6; }
        .container { max-width: 720px; margin: 0 auto; padding: 24px 16px; }
        .header { margin-bottom: 32px; padding-bottom: 16px; border-bottom: 1px solid #222; }
        .header h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
        .header .meta { font-size: 13px; color: #888; }
        .message { margin-bottom: 20px; padding: 16px; border-radius: 12px; }
        .message.user { background: #1a1a2e; border-left: 3px solid #4a9eff; }
        .message.assistant { background: #1a1a1a; border-left: 3px solid #34c759; }
        .role { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; color: #888; }
        .text { white-space: pre-wrap; word-break: break-word; font-size: 15px; }
        .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #222; text-align: center; font-size: 13px; color: #555; }
        .footer a { color: #4a9eff; text-decoration: none; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>${escapeHtml(title)}</h1>
            <div class="meta">${date} · ${messages.length} messages</div>
        </div>
        ${messagesHtml}
        <div class="footer">Shared via <a href="https://app.304.systems">Happy</a></div>
    </div>
</body>
</html>`;

            reply.type('text/html');
            return reply.send(html);
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to render shared session: ${error}`);
            reply.type('text/html').code(500);
            return reply.send('<html><body><h1>Error</h1></body></html>');
        }
    });

    // DELETE /v1/share/:id - Delete a shared session (requires auth, only owner)
    app.delete('/v1/share/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string(),
            }),
            response: {
                200: z.object({ ok: z.literal(true) }),
                404: z.object({ error: z.string() }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        try {
            const shared = await db.sharedSession.findUnique({ where: { id } });

            if (!shared || shared.accountId !== userId) {
                return reply.code(404).send({ error: 'Shared session not found' });
            }

            await db.sharedSession.delete({ where: { id } });
            return reply.send({ ok: true });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to delete shared session: ${error}`);
            return reply.code(404).send({ error: 'Shared session not found' });
        }
    });
}
