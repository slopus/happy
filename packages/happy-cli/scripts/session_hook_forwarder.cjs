#!/usr/bin/env node
/**
 * Session Hook Forwarder
 *
 * This script is executed by Claude's SessionStart / Stop / SessionEnd hooks.
 * It reads JSON data from stdin and forwards it to Happy's hook server.
 *
 * Usage: echo '{"session_id":"..."}' | node session_hook_forwarder.cjs <port> [path]
 *
 * `path` defaults to /hook/session-start so existing SessionStart hook settings
 * files written by an older happy-cli keep working after an upgrade.
 */

const http = require('http');

const port = parseInt(process.argv[2], 10);
// Only the paths this forwarder is allowed to target — a settings file is
// user-editable, and this script is spawned by Claude on every hook.
const ALLOWED_PATHS = ['/hook/session-start', '/hook/stop', '/hook/session-end'];
const requestedPath = process.argv[3] || '/hook/session-start';
const path = ALLOWED_PATHS.includes(requestedPath) ? requestedPath : '/hook/session-start';

if (!port || isNaN(port)) {
    process.exit(1);
}

const chunks = [];

process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
});

process.stdin.on('end', () => {
    const body = Buffer.concat(chunks);
    
    const req = http.request({
        host: '127.0.0.1',
        port: port,
        method: 'POST',
        path: path,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length
        }
    }, (res) => {
        res.resume(); // Drain response
    });
    
    req.on('error', () => {
        // Silently ignore errors - don't break Claude
    });
    
    req.end(body);
});

process.stdin.resume();

