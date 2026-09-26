/** Fail-closed checks for the fixed launcher, identity and live owner firewall rules. */
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { userInfo } from 'node:os';
import { DENIED_IPV4, DENIED_IPV6 } from './egressProxy';
import { MandatorySandboxError } from './sandboxPolicy';

export const SANDBOX_LAUNCHER = '/usr/local/libexec/abp/claude-sbx-launch';
export const FIREWALL_READER = '/usr/local/libexec/abp/abp-firewall-read';

export function firewallRules(family: 4 | 6, sandboxUid: number, proxyUid: number): string[] {
    const sbx = `-A OUTPUT -m owner --uid-owner ${sandboxUid}`;
    const proxy = `-A OUTPUT -m owner --uid-owner ${proxyUid}`;
    const rules = family === 4 ? [`-A OUTPUT -d 127.0.0.1/32 -p tcp -m owner --uid-owner ${sandboxUid} -m tcp --dport 3128 -j ACCEPT`] : [];
    rules.push(`${sbx} -j REJECT`);
    // Replies on the listener are necessary; this does not permit new local connections.
    if (family === 4) rules.push(`-A OUTPUT -d 127.0.0.1/32 -p tcp -m owner --uid-owner ${proxyUid} -m tcp --sport 3128 -m conntrack --ctstate ESTABLISHED -j ACCEPT`);
    for (const cidr of family === 4 ? DENIED_IPV4 : DENIED_IPV6) rules.push(`-A OUTPUT -d ${cidr} -m owner --uid-owner ${proxyUid} -j REJECT`);
    rules.push(`-A OUTPUT${family === 6 ? ' -d 2000::/3' : ''} -p tcp -m owner --uid-owner ${proxyUid} -m tcp --dport 443 -j ACCEPT`, `${proxy} -j REJECT`);
    return rules;
}
export function assertFirewallRules(raw: string, family: 4 | 6, sandboxUid: number, proxyUid: number): void {
    const rules = raw.split('\n').filter(line => line.startsWith('-A OUTPUT ')).map(line => line.replace(/ --reject-with (?:icmp-port-unreachable|icmp6-port-unreachable)$/, ''));
    const expected = firewallRules(family, sandboxUid, proxyUid);
    if (expected.some((line, index) => rules[index] !== line)) throw new MandatorySandboxError('capability-unavailable', 'owner firewall rules absent or shadowed');
}
export function assertRootOwned(path: string): void {
    let current = path;
    while (current !== '/') {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new MandatorySandboxError('capability-unavailable', 'untrusted sandbox installation');
        current = dirname(current);
    }
}
export function checkSandboxPrerequisites(mcpSocketPath?: string, happyHome?: string): void {
    try {
        for (const path of [SANDBOX_LAUNCHER, FIREWALL_READER, realpathSync('/usr/bin/bwrap'), realpathSync('/usr/bin/sudo'), realpathSync('/usr/bin/node')]) assertRootOwned(path);
        const command = (path: string, args: string[]) => execFileSync(path, args, { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        const uid = Number(command('/usr/bin/id', ['-u', 'agent-sbx']));
        const proxyUid = Number(command('/usr/bin/id', ['-u', 'abp-proxy']));
        const agent = userInfo();
        if (!uid || !proxyUid || uid === proxyUid || agent.uid === uid || agent.uid === proxyUid || agent.username !== 'agent') throw new Error();
        const groups = command('/usr/bin/id', ['-Gn', 'agent-sbx']).split(' ');
        if (groups.some(group => !['agent-sbx', 'abp-work'].includes(group))) throw new Error();
        if (happyHome && !realpathSync(happyHome).startsWith(realpathSync(agent.homedir) + '/')) {
            const privateHome = lstatSync(happyHome);
            if (!privateHome.isDirectory() || privateHome.uid !== agent.uid || (privateHome.mode & 0o077)) throw new Error();
        }
        const home = lstatSync(agent.homedir);
        if (!home.isDirectory() || home.uid !== agent.uid || (home.mode & 0o077)) throw new Error();
        if (mcpSocketPath) {
            const parent = lstatSync(dirname(mcpSocketPath));
            const socket = lstatSync(mcpSocketPath);
            const gid = Number(command('/usr/bin/id', ['-g', 'agent-sbx']));
            if (!socket.isSocket() || socket.uid !== agent.uid || socket.gid !== gid || (socket.mode & 0o777) !== 0o660 || parent.uid !== agent.uid || parent.gid !== gid || (parent.mode & 0o777) !== 0o710) throw new Error();
        }
        const tables = command(FIREWALL_READER, []).split('*filter\n').slice(1);
        if (tables.length !== 2) throw new Error();
        assertFirewallRules(tables[0], 4, uid, proxyUid);
        assertFirewallRules(tables[1], 6, uid, proxyUid);
        command('/usr/bin/sudo', ['-n', '-l', '-u', 'agent-sbx', SANDBOX_LAUNCHER, '0']);
    } catch (error) {
        if (error instanceof MandatorySandboxError) throw error;
        throw new MandatorySandboxError('capability-unavailable', 'sandbox identity, permissions, sudo, bwrap or live firewall check failed');
    }
}
export async function checkProxyReachable(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: 3128 });
        const fail = () => { socket.destroy(); reject(new MandatorySandboxError('capability-unavailable', 'CONNECT proxy unavailable')); };
        socket.setTimeout(2000, fail).on('error', fail);
        socket.once('connect', () => socket.write('CONNECT denied.invalid:443 HTTP/1.1\r\n\r\n'));
        let reply = '';
        socket.on('data', data => { reply += data; if (reply.length > 1024) fail(); });
        socket.on('end', () => { if (reply.startsWith('HTTP/1.1 403 Forbidden\r\n')) resolve(); else fail(); });
    });
}
