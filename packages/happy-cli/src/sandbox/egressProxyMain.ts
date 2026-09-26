/** Standalone abp-proxy systemd entry. No Happy configuration or credentials. */
import { userInfo } from 'node:os';
import { readFileSync, lstatSync } from 'node:fs';
import { createEgressProxy, DEFAULT_DOMAINS } from './egressProxy';

if (userInfo().username !== 'abp-proxy') throw new Error('Egress proxy must run as abp-proxy');
const policy = '/etc/aplus/claude-sandbox.json';
let allowedDomains = DEFAULT_DOMAINS;
try {
    const stat = lstatSync(policy);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('untrusted egress policy');
    const parsed = JSON.parse(readFileSync(policy, 'utf8')) as { allowedDomains?: unknown };
    if (!Array.isArray(parsed.allowedDomains) || parsed.allowedDomains.length > 64 || parsed.allowedDomains.some(domain => typeof domain !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain))) throw new Error('invalid egress policy');
    allowedDomains = parsed.allowedDomains;
} catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('egress policy unavailable');
}
createEgressProxy({ allowedDomains }).listen(3128, '127.0.0.1');
