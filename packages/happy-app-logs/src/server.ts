import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PORT = parseInt(process.env.PORT || '8787');

// Resolve happy home dir — same pattern as happy-cli/src/configuration.ts
let happyHome: string;
if (process.env.HAPPY_HOME_DIR) {
    happyHome = process.env.HAPPY_HOME_DIR.replace(/^~/, homedir());
} else {
    happyHome = join(homedir(), '.happy');
}

const logsDir = join(happyHome, 'app-logs');
mkdirSync(logsDir, { recursive: true });

const now = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const filename = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}.log`;
const logPath = join(logsDir, filename);
const stream = createWriteStream(logPath, { flags: 'a' });

function formatTime(iso: string): string {
    try {
        const d = new Date(iso);
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        const s = String(d.getSeconds()).padStart(2, '0');
        const ms = String(d.getMilliseconds()).padStart(3, '0');
        return `${h}:${m}:${s}.${ms}`;
    } catch {
        return iso;
    }
}

function setCors(res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk; });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

const server = createServer(async (req, res) => {
    setCors(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.method !== 'POST' || req.url !== '/logs') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":"not found"}');
        return;
    }

    try {
        const raw = await readBody(req);
        const { timestamp, level, message, source, platform } = JSON.parse(raw);

        const time = formatTime(timestamp || new Date().toISOString());
        const lvl = (level || 'info').toUpperCase().padEnd(5);
        const src = source || 'app';
        const plat = platform || '?';
        const line = `[${time}] [${lvl}] [${src}/${plat}] ${message}\n`;

        stream.write(line);
        process.stdout.write(line);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
    } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"error":"bad request"}');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`📱 App log receiver listening on http://0.0.0.0:${PORT}`);
    console.log(`📝 Writing to ${logPath}`);
});
