/** CONNECT-only egress. Resolve once, validate every answer, and dial a numeric address. */
import { lookup } from 'node:dns/promises';
import { createConnection, createServer, isIP, type Server, type Socket } from 'node:net';

export const DEFAULT_DOMAINS = ['api.anthropic.com', 'claude.ai', 'platform.claude.com'];
export const DENIED_IPV4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3'];
export const DENIED_IPV6 = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'];

export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) {
        const numeric = address.split('.').reduce((n, byte) => n * 256 + Number(byte), 0);
        return !DENIED_IPV4.some(cidr => {
            const [base, bits] = cidr.split('/');
            const value = base.split('.').reduce((n, byte) => n * 256 + Number(byte), 0);
            const size = 2 ** (32 - Number(bits));
            return Math.floor(numeric / size) === Math.floor(value / size);
        });
    }
    // Only native global unicast 2000::/3; excludes mapped, NAT64, ULA and zones.
    if (family !== 6 || address.includes('%') || address.includes('.')) return false;
    const [left, right] = address.split('::');
    const a = left ? left.split(':') : [];
    const b = right ? right.split(':') : [];
    const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
    const value = words.reduce((n, word) => (n << 16n) | BigInt(parseInt(word, 16)), 0n);
    if (value >> 125n !== 1n) return false;
    return !DENIED_IPV6.some(cidr => {
        const [base, bits] = cidr.split('/');
        const parts = base.split('::')[0].split(':');
        const start = [...parts, ...Array(8 - parts.length).fill('0')].reduce((n, word) => (n << 16n) | BigInt(parseInt(word, 16)), 0n);
        const shift = BigInt(128 - Number(bits));
        return value >> shift === start >> shift;
    });
}

type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export async function resolveConnectTarget(authority: string, domains: readonly string[], resolve: Lookup = host => lookup(host, { all: true, verbatim: true })): Promise<{ host: string; family: number; port: number }> {
    const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):443$/i.exec(authority);
    if (!match || isIP(match[1]) || !domains.includes(match[1].toLowerCase())) throw new Error('destination denied');
    const addresses = await resolve(match[1]);
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) throw new Error('destination denied');
    return { host: addresses[0].address, family: addresses[0].family, port: 443 };
}

export function createEgressProxy(options: { allowedDomains?: string[]; lookup?: Lookup; connect?: typeof createConnection } = {}): Server {
    return createServer(client => {
        let buffer = Buffer.alloc(0);
        let upstream: Socket | undefined;
        const close = () => { client.destroy(); upstream?.destroy(); };
        client.on('error', close).on('close', () => upstream?.destroy());
        client.setTimeout(10_000, close);
        const deny = () => client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        const header = (data: Buffer) => {
            buffer = Buffer.concat([buffer, data]);
            const end = buffer.indexOf('\r\n\r\n');
            if (buffer.length > 16384 && (end < 0 || end > 16384)) { deny(); client.removeListener('data', header); return; }
            if (end < 0) return;
            client.pause(); client.removeListener('data', header);
            const lines = buffer.subarray(0, end).toString('ascii').split('\r\n');
            const match = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/.exec(lines[0]);
            if (!match || lines.slice(1).some(line => !/^[A-Za-z0-9-]+: [\x20-\x7e]*$/.test(line) || /^(content-length|transfer-encoding):/i.test(line))) { deny(); return; }
            void resolveConnectTarget(match[1], options.allowedDomains ?? DEFAULT_DOMAINS, options.lookup).then(target => {
                if (client.destroyed) return;
                upstream = (options.connect ?? createConnection)(target);
                upstream.setTimeout(10_000, close);
                upstream.on('error', close).on('close', () => client.destroy());
                upstream.once('connect', () => {
                    client.setTimeout(120_000); upstream!.setTimeout(120_000);
                    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    upstream!.write(buffer.subarray(end + 4));
                    buffer = Buffer.alloc(0);
                    client.pipe(upstream!).pipe(client); client.resume();
                });
            }).catch(deny);
        };
        client.on('data', header);
    });
}
