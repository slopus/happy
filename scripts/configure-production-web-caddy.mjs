import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PUBLIC_SHARE_CADDY_BLOCK_START = '# paws-public-session-share:start';
export const PUBLIC_SHARE_CADDY_BLOCK_END = '# paws-public-session-share:end';
export const WEB_OSS_CADDY_BLOCK_START = '# paws-web-oss:start';
export const WEB_OSS_CADDY_BLOCK_END = '# paws-web-oss:end';
export const PRODUCTION_CADDY_GRACE_PERIOD = '10s';
export const PRODUCTION_WEB_OSS_HOST = 'happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com';
export const PRODUCTION_WEB_OSS_ORIGIN = `https://${PRODUCTION_WEB_OSS_HOST}`;
const REQUIRED_BACKEND_PATHS = ['/v1/*', '/v2/*', '/v3/*', '/v4/*', '/files/*', '/health'];

const PUBLIC_SHARE_CADDY_LINES = [
    PUBLIC_SHARE_CADDY_BLOCK_START,
    '@public_session_share path /share/*',
    'header @public_session_share {',
    '    Cache-Control "no-store"',
    `    Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' ${PRODUCTION_WEB_OSS_ORIGIN}; style-src 'self' 'unsafe-inline' ${PRODUCTION_WEB_OSS_ORIGIN}; img-src 'self' data: blob: https: http:; media-src 'self' blob: https: http:; connect-src 'self' https: http:; font-src 'self' data: ${PRODUCTION_WEB_OSS_ORIGIN}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"`,
    '    X-Robots-Tag "noindex, nofollow, noarchive"',
    '    X-Content-Type-Options "nosniff"',
    '    Referrer-Policy "no-referrer"',
    '}',
    PUBLIC_SHARE_CADDY_BLOCK_END,
];

const WEB_OSS_CADDY_LINES = [
    WEB_OSS_CADDY_BLOCK_START,
    '@paws_web_asset path /_expo/* /assets/* /.well-known/* /canvaskit.wasm /favicon.ico /favicon-active.ico /metadata.json',
    `redir @paws_web_asset ${PRODUCTION_WEB_OSS_ORIGIN}{uri} 302`,
    'handle {',
    '    rewrite * /web/current/index.html',
    `    reverse_proxy ${PRODUCTION_WEB_OSS_ORIGIN} {`,
    `        header_up Host ${PRODUCTION_WEB_OSS_HOST}`,
    '        header_down -Content-Disposition',
    '        header_down Content-Type "text/html; charset=utf-8"',
    '    }',
    '}',
    WEB_OSS_CADDY_BLOCK_END,
];

function braceDelta(line) {
    const content = line.split('#', 1)[0];
    return (content.match(/{/g) ?? []).length - (content.match(/}/g) ?? []).length;
}

function findManagedRange(lines, startMarker, endMarker) {
    const start = lines.findIndex((line) => line.trim() === startMarker);
    const end = lines.findIndex((line) => line.trim() === endMarker);
    if ((start < 0) !== (end < 0) || (start >= 0 && end < start)) {
        throw new Error(`Existing managed Caddy block is incomplete: ${startMarker}`);
    }
    return start < 0 ? null : { start, end };
}

function findBlockEnd(lines, start) {
    let depth = 0;
    for (let index = start; index < lines.length; index += 1) {
        depth += braceDelta(lines[index]);
        if (index > start && depth === 0) return index;
    }
    throw new Error(`Caddy block is unbalanced at line ${start + 1}`);
}

function configureGracePeriod(lines) {
    const firstDirective = lines.findIndex((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0 && !trimmed.startsWith('#');
    });

    if (firstDirective < 0 || lines[firstDirective].trim() !== '{') {
        lines.unshift(
            '{',
            `\tgrace_period ${PRODUCTION_CADDY_GRACE_PERIOD}`,
            '}',
            '',
        );
        return;
    }

    let globalEnd = -1;
    let depth = 0;
    for (let index = firstDirective; index < lines.length; index += 1) {
        depth += braceDelta(lines[index]);
        if (index > firstDirective && depth === 0) {
            globalEnd = index;
            break;
        }
    }
    if (globalEnd < 0) throw new Error('Caddy global options block is unbalanced');

    const gracePeriod = lines.findIndex(
        (line, index) => index > firstDirective && index < globalEnd && /^\s*grace_period\s+/.test(line),
    );
    if (gracePeriod >= 0) {
        const indentation = lines[gracePeriod].match(/^\s*/)?.[0] ?? '\t';
        lines[gracePeriod] = `${indentation}grace_period ${PRODUCTION_CADDY_GRACE_PERIOD}`;
        return;
    }

    const firstOption = lines.slice(firstDirective + 1, globalEnd).find((line) => line.trim().length > 0);
    const indentation = firstOption?.match(/^\s*/)?.[0] ?? '\t';
    lines.splice(firstDirective + 1, 0, `${indentation}grace_period ${PRODUCTION_CADDY_GRACE_PERIOD}`);
}

export function configureProductionWebCaddy(source, siteAddress = '47.115.228.20:8443') {
    const hadFinalNewline = source.endsWith('\n');
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    configureGracePeriod(lines);
    const siteStart = lines.findIndex((line) => line.trim() === `${siteAddress} {`);
    if (siteStart < 0) throw new Error(`Caddy site block not found: ${siteAddress}`);

    let depth = 0;
    let siteEnd = -1;
    for (let index = siteStart; index < lines.length; index += 1) {
        depth += braceDelta(lines[index]);
        if (index > siteStart && depth === 0) {
            siteEnd = index;
            break;
        }
    }
    if (siteEnd < 0) throw new Error(`Caddy site block is unbalanced: ${siteAddress}`);

    const siteLines = lines.slice(siteStart + 1, siteEnd);
    const publicShareRange = findManagedRange(
        siteLines,
        PUBLIC_SHARE_CADDY_BLOCK_START,
        PUBLIC_SHARE_CADDY_BLOCK_END,
    );
    if (publicShareRange) {
        siteLines.splice(publicShareRange.start, publicShareRange.end - publicShareRange.start + 1);
    }

    const existingWebRange = findManagedRange(
        siteLines,
        WEB_OSS_CADDY_BLOCK_START,
        WEB_OSS_CADDY_BLOCK_END,
    );
    let webInsertionIndex;
    let webIndentation;
    if (existingWebRange) {
        webInsertionIndex = existingWebRange.start;
        webIndentation = siteLines[existingWebRange.start].match(/^\s*/)?.[0] ?? '\t';
        siteLines.splice(existingWebRange.start, existingWebRange.end - existingWebRange.start + 1);
    } else {
        const legacyHandleStart = siteLines.findIndex((line, index) => {
            if (!/^\s*handle\s*\{\s*$/.test(line)) return false;
            const end = findBlockEnd(siteLines, index);
            return siteLines.slice(index, end + 1).some((candidate) => candidate.includes('/var/www/happy-web'));
        });
        if (legacyHandleStart < 0) {
            throw new Error(`Legacy Web filesystem handler not found in ${siteAddress}`);
        }
        const legacyHandleEnd = findBlockEnd(siteLines, legacyHandleStart);
        webInsertionIndex = legacyHandleStart;
        webIndentation = siteLines[legacyHandleStart].match(/^\s*/)?.[0] ?? '\t';
        siteLines.splice(legacyHandleStart, legacyHandleEnd - legacyHandleStart + 1);
    }
    siteLines.splice(
        webInsertionIndex,
        0,
        ...WEB_OSS_CADDY_LINES.map((line) => `${webIndentation}${line}`),
    );

    const backendIndex = siteLines.findIndex((line) => /^\s*@backend\s+path\s+/.test(line));
    if (backendIndex < 0) throw new Error(`@backend path matcher not found in ${siteAddress}`);
    const indentation = siteLines[backendIndex].match(/^\s*/)?.[0] ?? '\t';
    const backendTokens = siteLines[backendIndex].trim().split(/\s+/);
    const additionalBackendPaths = backendTokens
        .slice(2)
        .filter((token) => token !== '/share/*' && !REQUIRED_BACKEND_PATHS.includes(token));
    siteLines[backendIndex] = `${indentation}@backend path ${[...REQUIRED_BACKEND_PATHS, ...additionalBackendPaths].join(' ')}`;
    siteLines.splice(
        backendIndex,
        0,
        ...PUBLIC_SHARE_CADDY_LINES.map((line) => `${indentation}${line}`),
    );

    lines.splice(siteStart + 1, siteEnd - siteStart - 1, ...siteLines);
    const result = lines.join('\n');
    return hadFinalNewline && !result.endsWith('\n') ? `${result}\n` : result;
}

async function main() {
    const [inputPath, outputPath, siteAddress] = process.argv.slice(2);
    if (!inputPath || !outputPath) {
        throw new Error('Usage: node scripts/configure-production-web-caddy.mjs <input> <output> [site-address]');
    }
    const source = await readFile(inputPath, 'utf8');
    const configured = configureProductionWebCaddy(source, siteAddress);
    await writeFile(outputPath, configured, 'utf8');
    process.stdout.write(configured === source ? 'unchanged\n' : 'changed\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
