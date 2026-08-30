import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PUBLIC_SHARE_CADDY_BLOCK_START = '# paws-public-session-share:start';
export const PUBLIC_SHARE_CADDY_BLOCK_END = '# paws-public-session-share:end';

const PUBLIC_SHARE_CADDY_LINES = [
    PUBLIC_SHARE_CADDY_BLOCK_START,
    '@public_session_share path /share/*',
    'header @public_session_share {',
    '    Cache-Control "no-store"',
    '    Content-Security-Policy "default-src \'self\'; script-src \'self\' \'unsafe-inline\' https://happy-app-ota-jacky.oss-cn-hangzhou.aliyuncs.com; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob: https: http:; media-src \'self\' blob: https: http:; connect-src \'self\' https: http:; font-src \'self\' data:; object-src \'none\'; base-uri \'none\'; frame-ancestors \'none\'; form-action \'none\'"',
    '    X-Robots-Tag "noindex, nofollow, noarchive"',
    '    X-Content-Type-Options "nosniff"',
    '    Referrer-Policy "no-referrer"',
    '}',
    PUBLIC_SHARE_CADDY_BLOCK_END,
];

function braceDelta(line) {
    const content = line.split('#', 1)[0];
    return (content.match(/{/g) ?? []).length - (content.match(/}/g) ?? []).length;
}

export function configureProductionWebCaddy(source, siteAddress = '47.115.228.20:8443') {
    const hadFinalNewline = source.endsWith('\n');
    const lines = source.replace(/\r\n/g, '\n').split('\n');
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
    const managedStart = siteLines.findIndex((line) => line.trim() === PUBLIC_SHARE_CADDY_BLOCK_START);
    const managedEnd = siteLines.findIndex((line) => line.trim() === PUBLIC_SHARE_CADDY_BLOCK_END);
    if ((managedStart < 0) !== (managedEnd < 0) || (managedStart >= 0 && managedEnd < managedStart)) {
        throw new Error('Existing public-share Caddy managed block is incomplete');
    }
    if (managedStart >= 0) siteLines.splice(managedStart, managedEnd - managedStart + 1);

    const backendIndex = siteLines.findIndex((line) => /^\s*@backend\s+path\s+/.test(line));
    if (backendIndex < 0) throw new Error(`@backend path matcher not found in ${siteAddress}`);
    const indentation = siteLines[backendIndex].match(/^\s*/)?.[0] ?? '\t';
    const backendTokens = siteLines[backendIndex].trim().split(/\s+/);
    siteLines[backendIndex] = `${indentation}${backendTokens.filter((token) => token !== '/share/*').join(' ')}`;
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
    await writeFile(outputPath, configureProductionWebCaddy(source, siteAddress), 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
