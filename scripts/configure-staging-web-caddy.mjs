import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const STAGING_WEB_BLOCK_START = '# paws-web-staging:start';
export const STAGING_WEB_BLOCK_END = '# paws-web-staging:end';
export const STAGING_WEB_ORIGIN = 'https://47.115.228.20:8444';
const PREVIOUS_MANAGED_BLOCK_SHA256 = '6cddf75112fa26a8ebca1baa97d72a4a8a60fdc34cc0a0463dec1481aa728fd9';

const STAGING_WEB_BLOCK = `${STAGING_WEB_BLOCK_START}
47.115.228.20:8444 {
    tls /etc/caddy/ip-letsencrypt-fullchain.pem /etc/caddy/ip-letsencrypt-key.pem
    encode zstd gzip
    header {
        X-Robots-Tag "noindex, nofollow, noarchive"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        Cache-Control "no-store"
    }
    @immutable_static path /_expo/* /assets/* /desktop-skins/* /agent-party/assets/*
    header @immutable_static Cache-Control "public, max-age=31536000, immutable" {
        match status 2xx
    }
    @public_session_share path /share/*
    header @public_session_share {
        Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; media-src 'self' blob: https: http:; connect-src 'self' https: http:; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
    }
    @party_invalid_origin {
        path /agent-party/api/* /agent-party/revision
        header Origin *
        not header Origin ${STAGING_WEB_ORIGIN}
    }
    @party_missing_mutation_origin {
        path /agent-party/api/* /agent-party/revision
        method POST PATCH PUT DELETE
        not header Origin ${STAGING_WEB_ORIGIN}
    }
    @paws_agent_party_api path /agent-party/api/* /agent-party/revision
    handle @paws_agent_party_api {
        respond @party_invalid_origin 403
        respond @party_missing_mutation_origin 403
        reverse_proxy 127.0.0.1:3847 {
            header_up Host 47.115.228.20:8443
            header_up Origin https://47.115.228.20:8443
        }
    }
    @paws_agent_party_assets path /agent-party/assets/*
    handle @paws_agent_party_assets {
        root * /var/www/paws-web-staging/current
        file_server
    }
    @paws_agent_party_app path /agent-party /agent-party/*
    header @paws_agent_party_app Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    handle @paws_agent_party_app {
        root * /var/www/paws-web-staging/current
        try_files {path} /agent-party/index.html
        file_server
    }
    @backend path /v1/* /v2/* /v3/* /v4/* /files/* /health /socket.io/* /socket/*
    handle @backend {
        reverse_proxy 100.116.134.122:3305 {
            stream_close_delay 5m
        }
    }
    @validate {
        path /
        header Accept *text/plain*
    }
    handle @validate {
        reverse_proxy 100.116.134.122:3305 {
            stream_close_delay 5m
        }
    }
    @static_asset path /_expo/* /assets/* /desktop-skins/* /.well-known/* /canvaskit.wasm /favicon.ico /favicon-active.ico /metadata.json
    handle @static_asset {
        root * /var/www/paws-web-staging/current
        file_server
    }
    handle {
        root * /var/www/paws-web-staging/current
        try_files {path} /index.html
        file_server
    }
}
${STAGING_WEB_BLOCK_END}`;

/** Add an isolated site without editing any existing production Caddy lines. */
export function configureStagingWebCaddy(source) {
    const startCount = source.split(STAGING_WEB_BLOCK_START).length - 1;
    const endCount = source.split(STAGING_WEB_BLOCK_END).length - 1;
    if (startCount !== endCount || startCount > 1) {
        throw new Error('Existing staging Caddy block is incomplete or duplicated');
    }
    if (startCount === 1) {
        const start = source.indexOf(STAGING_WEB_BLOCK_START);
        const end = source.indexOf(STAGING_WEB_BLOCK_END, start) + STAGING_WEB_BLOCK_END.length;
        const current = source.slice(start, end);
        if (current === STAGING_WEB_BLOCK) return source;
        if (createHash('sha256').update(current).digest('hex') === PREVIOUS_MANAGED_BLOCK_SHA256) {
            return source.slice(0, start) + STAGING_WEB_BLOCK + source.slice(end);
        }
        if (current !== STAGING_WEB_BLOCK) {
            throw new Error('Existing staging Caddy block differs from the expected configuration');
        }
    }
    if (/^\s*[^\n#]*:8444\s*\{/m.test(source)) {
        throw new Error('Port 8444 is already used by an unmanaged Caddy site');
    }
    return `${source.trimEnd()}\n\n${STAGING_WEB_BLOCK}\n`;
}

async function main() {
    const [inputPath, outputPath] = process.argv.slice(2);
    if (!inputPath || !outputPath) {
        throw new Error('Usage: node scripts/configure-staging-web-caddy.mjs <input> <output>');
    }
    const source = await readFile(inputPath, 'utf8');
    const configured = configureStagingWebCaddy(source);
    await writeFile(outputPath, configured, 'utf8');
    process.stdout.write(configured === source ? 'unchanged\n' : 'changed\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
