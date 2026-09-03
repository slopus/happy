import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MCP_APP_SANDBOX_CADDY_BLOCK_START = '# paws-mcp-app-sandbox:start';
export const MCP_APP_SANDBOX_CADDY_BLOCK_END = '# paws-mcp-app-sandbox:end';

function normalizeHttpsOrigin(raw, label) {
    if (!raw || raw.trim() !== raw || /[\s;'"\\?#]/u.test(raw)) {
        throw new Error(`${label} must be an exact HTTPS origin`);
    }
    let url;
    try { url = new URL(raw); } catch { throw new Error(`${label} must be an exact HTTPS origin`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
        || url.search || url.hash || !url.hostname || url.hostname.includes('*') || url.hostname.endsWith('.')) {
        throw new Error(`${label} must be an exact HTTPS origin`);
    }
    return url.origin;
}

function scanCaddyfile(source) {
    const tokens = [];
    const comments = [];
    let index = 0;
    let line = 0;
    const emit = (text, tokenLine, quoted = false) => tokens.push({ text, line: tokenLine, quoted });
    while (index < source.length) {
        const character = source[index];
        if (/\s/u.test(character)) {
            if (character === '\n') line += 1;
            index += 1;
            continue;
        }
        if (character === '#') {
            const end = source.indexOf('\n', index);
            comments.push({ line, text: source.slice(index, end < 0 ? source.length : end).trim() });
            index = end < 0 ? source.length : end;
            continue;
        }

        const tokenLine = line;
        if (character === '"' || character === '`') {
            const quote = character;
            let escaped = false;
            let closed = false;
            index += 1;
            while (index < source.length) {
                const quotedCharacter = source[index];
                if (quote === '"' && !escaped && quotedCharacter === '\\') {
                    escaped = true;
                    index += 1;
                    continue;
                }
                if (quote === '"' && escaped) {
                    escaped = false;
                    if (quotedCharacter === '\n') line += 1;
                    index += 1;
                    continue;
                }
                if (quotedCharacter === quote) {
                    index += 1;
                    emit('', tokenLine, true);
                    closed = true;
                    break;
                }
                if (quotedCharacter === '\n') line += 1;
                index += 1;
            }
            if (!closed) {
                throw new Error(escaped
                    ? 'Caddyfile contains an unterminated escape in a quoted value'
                    : 'Caddyfile contains an unterminated quoted value');
            }
            continue;
        }

        if (source.startsWith('<<', index)) {
            const openerEnd = source.indexOf('\n', index);
            const opener = source.slice(index, openerEnd < 0 ? source.length : openerEnd);
            const markerMatch = /^<<([A-Za-z0-9_][A-Za-z0-9_-]*)$/u.exec(opener);
            if (!markerMatch) throw new Error('Caddyfile contains a malformed heredoc token');
            const marker = markerMatch[1];
            index = openerEnd < 0 ? source.length : openerEnd + 1;
            if (openerEnd >= 0) line += 1;
            let closed = false;
            const bodyLines = [];
            while (index <= source.length) {
                const closeLineEnd = source.indexOf('\n', index);
                const physicalEnd = closeLineEnd < 0 ? source.length : closeLineEnd;
                let markerStart = index;
                while (markerStart < physicalEnd && /[^\S\n]/u.test(source[markerStart])) markerStart += 1;
                const markerEnd = markerStart + marker.length;
                if (source.startsWith(marker, markerStart)
                    && (markerEnd === physicalEnd || /[^\S\n]/u.test(source[markerEnd]))) {
                    const padding = source.slice(index, markerStart);
                    if (bodyLines.some((bodyLine) => bodyLine !== '' && !bodyLine.startsWith(padding))) {
                        throw new Error('Caddyfile heredoc has mismatched leading whitespace for its closing marker');
                    }
                    emit('', tokenLine, true);
                    index = markerEnd;
                    closed = true;
                    break;
                }
                if (closeLineEnd < 0) break;
                bodyLines.push(source.slice(index, physicalEnd));
                index = closeLineEnd + 1;
                line += 1;
            }
            if (!closed) throw new Error('Caddyfile contains an unterminated heredoc');
            continue;
        }

        const start = index;
        let escaped = false;
        while (index < source.length && !/\s/u.test(source[index])) {
            const tokenCharacter = source[index];
            if (!escaped && tokenCharacter === '\\') {
                escaped = true;
                index += 1;
                continue;
            }
            escaped = false;
            index += 1;
        }
        if (escaped && index === source.length) throw new Error('Caddyfile contains an unterminated escape');
        emit(source.slice(start, index), tokenLine);
    }
    return { tokens, comments };
}

function blockEnd(tokens, start, label) {
    let depth = 0;
    for (let index = start; index < tokens.length; index += 1) {
        if (!tokens[index].quoted && tokens[index].text === '{') depth += 1;
        if (!tokens[index].quoted && tokens[index].text === '}') depth -= 1;
        if (index > start && depth === 0) return index;
        if (depth < 0) break;
    }
    throw new Error(`${label} is unbalanced`);
}

function findManagedRange(lines, comments) {
    const starts = [];
    const ends = [];
    for (const comment of comments) {
        if (lines[comment.line]?.trim() === MCP_APP_SANDBOX_CADDY_BLOCK_START
            && comment.text === MCP_APP_SANDBOX_CADDY_BLOCK_START) starts.push(comment.line);
        if (lines[comment.line]?.trim() === MCP_APP_SANDBOX_CADDY_BLOCK_END
            && comment.text === MCP_APP_SANDBOX_CADDY_BLOCK_END) ends.push(comment.line);
    }
    if (starts.length === 0 && ends.length === 0) return null;
    if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
        throw new Error('Existing managed MCP App sandbox Caddy block is incomplete or duplicated');
    }
    return { start: starts[0], end: ends[0] };
}

function managedLines(indentation) {
    return [
        MCP_APP_SANDBOX_CADDY_BLOCK_START,
        'route {',
        '    @paws_mcp_app_host path /mcp-app-sandbox/host /mcp-app-sandbox/host.js',
        '    reverse_proxy @paws_mcp_app_host localhost:3005',
        '    respond 404',
        '}',
        MCP_APP_SANDBOX_CADDY_BLOCK_END,
    ].map((line) => `${indentation}${line}`);
}

export function configureProductionMcpAppSandboxCaddy(source, options) {
    const sandboxOrigin = normalizeHttpsOrigin(options?.sandboxOrigin, 'Sandbox origin');
    const rawParents = options?.parentOrigins;
    if (!Array.isArray(rawParents) || rawParents.length === 0) {
        throw new Error('At least one Paws parent origin is required');
    }
    const parentOrigins = [...new Set(rawParents.map((origin) => normalizeHttpsOrigin(origin, 'Parent origin')))];
    if (parentOrigins.includes(sandboxOrigin)) {
        throw new Error('Sandbox origin must use a different origin from every Paws parent origin');
    }

    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const withoutCrLf = source.replaceAll('\r\n', '');
    if (withoutCrLf.includes('\r') || (newline === '\r\n' && withoutCrLf.includes('\n'))) {
        throw new Error('Caddyfile contains mixed or unsupported line endings');
    }
    const hadFinalNewline = source.endsWith(newline);
    const lines = source.split(newline);
    const scan = scanCaddyfile(source.replaceAll('\r\n', '\n'));
    const globalManagedRange = findManagedRange(lines, scan.comments);
    const sandboxHost = new URL(sandboxOrigin).host;
    const acceptedSiteLabels = new Set([sandboxHost, sandboxOrigin]);
    const siteStarts = [];
    let nesting = 0;
    for (const [index, token] of scan.tokens.entries()) {
        const structuralOpen = !token.quoted && token.text === '{';
        const structuralClose = !token.quoted && token.text === '}';
        const next = scan.tokens[index + 1];
        const previous = scan.tokens[index - 1];
        if (nesting === 0 && acceptedSiteLabels.has(token.text) && !token.quoted
            && (!previous || previous.line < token.line)
            && next && !next.quoted && next.text === '{' && next.line === token.line
            && (!scan.tokens[index + 2] || scan.tokens[index + 2].line > token.line)) {
            siteStarts.push({ line: token.line, braceIndex: index + 1 });
        }
        if (structuralOpen) nesting += 1;
        if (structuralClose) nesting -= 1;
        if (nesting < 0) throw new Error('Caddyfile contains unbalanced structural braces');
    }
    if (nesting !== 0) throw new Error('Caddyfile contains unbalanced structural braces');
    if (siteStarts.length !== 1) {
        throw new Error(siteStarts.length === 0
            ? `Caddy site block not found for already-provisioned sandbox: ${sandboxHost}`
            : `Multiple Caddy site blocks found for sandbox: ${sandboxHost}`);
    }
    const siteStart = siteStarts[0].line;
    const siteEndToken = blockEnd(scan.tokens, siteStarts[0].braceIndex, `Sandbox Caddy site ${sandboxHost}`);
    const siteEnd = scan.tokens[siteEndToken].line;
    if (globalManagedRange
        && (globalManagedRange.start <= siteStart || globalManagedRange.end >= siteEnd)) {
        throw new Error('Existing managed MCP App sandbox Caddy block is outside the sandbox site');
    }

    for (let index = siteStart + 1; index < siteEnd; index += 1) {
        if (globalManagedRange && index >= globalManagedRange.start && index <= globalManagedRange.end) continue;
        const trimmed = lines[index].trim();
        if (trimmed !== '' && !trimmed.startsWith('#')) {
            throw new Error('Provisioned sandbox site must contain only comments outside the managed block');
        }
    }

    if (globalManagedRange) {
        const existingIndent = lines[globalManagedRange.start].match(/^\s*/u)?.[0] ?? '';
        const expected = managedLines(existingIndent);
        const actual = lines.slice(globalManagedRange.start, globalManagedRange.end + 1);
        if (actual.length !== expected.length || actual.some((line, index) => line !== expected[index])) {
            throw new Error('Existing managed MCP App sandbox Caddy block was modified');
        }
        lines.splice(globalManagedRange.start, globalManagedRange.end - globalManagedRange.start + 1, ...expected);
    } else {
        const siteIndent = lines.slice(siteStart + 1, siteEnd)
            .find((line) => line.trim().length > 0)?.match(/^\s*/u)?.[0]
            ?? `${lines[siteStart].match(/^\s*/u)?.[0] ?? ''}    `;
        const prefix = siteEnd > siteStart + 1 && lines[siteEnd - 1].trim() !== '' ? [''] : [];
        lines.splice(siteEnd, 0, ...prefix, ...managedLines(siteIndent));
    }
    let result = lines.join(newline);
    if (hadFinalNewline && !result.endsWith(newline)) result += newline;
    if (!hadFinalNewline && result.endsWith(newline)) result = result.slice(0, -newline.length);
    return result;
}

export async function runConfigureProductionMcpAppSandboxCaddy(args = process.argv.slice(2)) {
    const [inputPath, outputPath, sandboxOrigin, parentOriginsRaw] = args;
    if (!inputPath || !outputPath || !sandboxOrigin || !parentOriginsRaw) {
        throw new Error('Usage: node scripts/configure-production-mcp-app-sandbox-caddy.mjs <input> <output> <sandbox-origin> <comma-separated-parent-origins>');
    }
    const source = await readFile(inputPath, 'utf8');
    const configured = configureProductionMcpAppSandboxCaddy(source, {
        sandboxOrigin,
        parentOrigins: parentOriginsRaw.split(',').map((origin) => origin.trim()),
    });
    if (configured === source) {
        process.stdout.write('unchanged\n');
        return 'unchanged';
    }
    const temporaryPath = join(dirname(outputPath), `.paws-mcp-app-caddy-${process.pid}-${Date.now()}.tmp`);
    try {
        await writeFile(temporaryPath, configured, { encoding: 'utf8', mode: 0o600 });
        await rename(temporaryPath, outputPath);
    } finally {
        await rm(temporaryPath, { force: true });
    }
    process.stdout.write('changed\n');
    return 'changed';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await runConfigureProductionMcpAppSandboxCaddy().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : 'MCP App sandbox Caddy configuration failed'}\n`);
        process.exitCode = 1;
    });
}
