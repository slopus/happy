import type { FastifyInstance } from "fastify";
import type { UiConfig } from "@/app/api/uiConfig";
import { extname, resolve, sep } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { warn } from "@/utils/log";

type AnyFastifyInstance = FastifyInstance<any, any, any, any, any>;

export function enableServeUi(app: AnyFastifyInstance, ui: UiConfig) {
    const uiDir = ui.dir;
    if (!uiDir) {
        return;
    }

    const root = resolve(uiDir);

    async function sendUiFile(relPath: string, reply: any) {
        const candidate = resolve(root, relPath);
        if (!(candidate === root || candidate.startsWith(root + sep))) {
            return reply.code(404).send({ error: 'Not found' });
        }

        const bytes = await readFile(candidate);
        const ext = extname(candidate).toLowerCase();

        if (ext === '.html') {
            reply.header('content-type', 'text/html; charset=utf-8');
            reply.header('cache-control', 'no-cache');
        } else if (ext === '.js') {
            reply.header('content-type', 'text/javascript; charset=utf-8');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (ext === '.css') {
            reply.header('content-type', 'text/css; charset=utf-8');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (ext === '.json') {
            reply.header('content-type', 'application/json; charset=utf-8');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (ext === '.svg') {
            reply.header('content-type', 'image/svg+xml');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (ext === '.ico') {
            reply.header('content-type', 'image/x-icon');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (ext === '.wasm') {
            reply.header('content-type', 'application/wasm');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (ext === '.ttf') {
            reply.header('content-type', 'font/ttf');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (ext === '.woff') {
            reply.header('content-type', 'font/woff');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (ext === '.woff2') {
            reply.header('content-type', 'font/woff2');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (ext === '.png') {
            reply.header('content-type', 'image/png');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (ext === '.jpg' || ext === '.jpeg') {
            reply.header('content-type', 'image/jpeg');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (ext === '.webp') {
            reply.header('content-type', 'image/webp');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else if (ext === '.gif') {
            reply.header('content-type', 'image/gif');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else {
            reply.header('content-type', 'application/octet-stream');
            reply.header('cache-control', 'public, max-age=31536000, immutable');
        }

        return reply.send(Buffer.from(bytes));
    }

    async function sendIndexHtml(reply: any) {
        const indexPath = resolve(root, 'index.html');
        let html: string;
        try {
            html = (await readFile(indexPath, 'utf-8')) + '\n<!-- Welcome to Happy Server! -->\n';
        } catch (err) {
            warn({ err, indexPath }, 'UI index.html not found (check UI build dir configuration)');
            reply.header('cache-control', 'no-cache');
            return reply.code(404).send({ error: 'Not found' });
        }
        reply.header('content-type', 'text/html; charset=utf-8');
        reply.header('cache-control', 'no-cache');
        return reply.send(html);
    }

    if (ui.mountRoot) {
        app.get('/', async (_request, reply) => await sendIndexHtml(reply));
        app.get('/ui', async (_request, reply) => reply.redirect('/', 302));
        app.get('/ui/', async (_request, reply) => reply.redirect('/', 302));
        app.get('/ui/*', async (request, reply) => {
            const raw = (request.params as { '*': string | undefined })['*'] || '';
            const decoded = decodeURIComponent(raw).replace(/^\/+/, '');
            return reply.redirect(`/${decoded}`, 302);
        });
    } else {
        const prefix = ui.prefix;
        app.get(prefix, async (_request, reply) => reply.redirect(`${prefix}/`, 302));
        app.get(`${prefix}/*`, async (request, reply) => {
            try {
                const raw = (request.params as { '*': string | undefined })['*'] || '';
                const decoded = decodeURIComponent(raw);
                const rel = decoded.replace(/^\/+/, '');

                const candidate = resolve(root, rel || 'index.html');
                if (!(candidate === root || candidate.startsWith(root + sep))) {
                    return reply.code(404).send({ error: 'Not found' });
                }

                let filePath = candidate;
                try {
                    const st = await stat(filePath);
                    if (st.isDirectory()) {
                        filePath = resolve(root, 'index.html');
                    }
                } catch {
                    filePath = resolve(root, 'index.html');
                }

                const relPath = filePath.slice(root.length + 1);
                if (relPath === 'index.html') {
                    return await sendIndexHtml(reply);
                }
                return await sendUiFile(relPath, reply);
            } catch {
                return reply.code(404).send({ error: 'Not found' });
            }
        });
    }

    // Expo export (metro) emits absolute URLs like `/_expo/...` and `/favicon.ico` even when served from a subpath.
    // To keep `/ui` working without rewriting builds, also serve these static assets from the root.
    app.get('/_expo/*', async (request, reply) => {
        try {
            const raw = (request.params as { '*': string | undefined })['*'] || '';
            const decoded = decodeURIComponent(raw).replace(/^\/+/, '');
            return await sendUiFile(`_expo/${decoded}`, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/assets/*', async (request, reply) => {
        try {
            const raw = (request.params as { '*': string | undefined })['*'] || '';
            const decoded = decodeURIComponent(raw).replace(/^\/+/, '');
            return await sendUiFile(`assets/${decoded}`, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/.well-known/*', async (request, reply) => {
        try {
            const raw = (request.params as { '*': string | undefined })['*'] || '';
            const decoded = decodeURIComponent(raw).replace(/^\/+/, '');
            return await sendUiFile(`.well-known/${decoded}`, reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/favicon.ico', async (_request, reply) => {
        try {
            return await sendUiFile('favicon.ico', reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/favicon-active.ico', async (_request, reply) => {
        try {
            return await sendUiFile('favicon-active.ico', reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/canvaskit.wasm', async (_request, reply) => {
        try {
            return await sendUiFile('canvaskit.wasm', reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
    app.get('/metadata.json', async (_request, reply) => {
        try {
            return await sendUiFile('metadata.json', reply);
        } catch {
            return reply.code(404).send({ error: 'Not found' });
        }
    });
}
