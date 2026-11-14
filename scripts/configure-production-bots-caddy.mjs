import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const BOTS_START = '# paws-bots-runtime:start';
export const BOTS_END = '# paws-bots-runtime:end';
const CERT = '/etc/caddy/ip-letsencrypt-fullchain.pem';
const KEY = '/etc/caddy/ip-letsencrypt-key.pem';
export const BOTS_BLOCK = `${BOTS_START}
47.115.228.20:8445 {
    tls ${CERT} ${KEY}
    reverse_proxy 100.116.134.122:3491 {
        flush_interval -1
    }
}
${BOTS_END}`;

/** Append only the dedicated Bots site, using the actual edge TLS configuration. */
export function configureProductionBotsCaddy(source, adapted) {
    if (typeof source !== 'string' || source.includes('\r')) throw Error('Expected LF Caddyfile');
    const servers = Object.values(adapted?.apps?.http?.servers ?? {});
    const parent = servers.filter(s => s.listen?.some(a => a.endsWith(':8443')));
    if (parent.length !== 1 || !parent[0].tls_connection_policies?.length) {
        throw Error('Expected one active TLS parent listener on 8443');
    }
    const certificates = adapted?.apps?.tls?.certificates?.load_files ?? [];
    if (!certificates.some(c => c.certificate === CERT && c.key === KEY)) {
        throw Error('Expected the existing production IP certificate pair; reconcile actual TLS first');
    }
    const starts = source.split(BOTS_START).length - 1;
    const ends = source.split(BOTS_END).length - 1;
    if (starts !== ends || starts > 1) throw Error('Incomplete or duplicate Bots markers');
    const runtime = servers.filter(s => s.listen?.some(a => a.endsWith(':8445')));
    if (!starts) {
        if (runtime.length || /(?:^|\s)(?:https?:\/\/)?[^\s]*:8445(?:\s|$)/mu.test(source)) {
            throw Error('Unmanaged listener on 8445');
        }
        return `${source}${source.endsWith('\n') ? '' : '\n'}\n${BOTS_BLOCK}\n`;
    }
    const start = source.indexOf(BOTS_START);
    const end = source.indexOf(BOTS_END, start) + BOTS_END.length;
    if (source.slice(start, end) !== BOTS_BLOCK) throw Error('Managed Bots block was modified');
    const without = source.slice(0, start) + source.slice(end);
    if (/:8445\b/u.test(without) || runtime.length !== 1 || runtime[0].routes?.length !== 1) {
        throw Error('Unexpected additional listener or route on 8445');
    }
    return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [input, adaptedPath, output] = process.argv.slice(2);
    if (!input || !adaptedPath || !output) throw Error('Usage: configure-production-bots-caddy.mjs <Caddyfile> <adapted.json> <output>');
    const source = await readFile(input, 'utf8');
    const result = configureProductionBotsCaddy(source, JSON.parse(await readFile(adaptedPath, 'utf8')));
    await writeFile(output, result, { mode: 0o600 });
    process.stdout.write(result === source ? 'unchanged\n' : 'changed\n');
}
