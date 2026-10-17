/**
 * Operating system proxy detection.
 *
 * Reads the same settings the OS itself hands to proxy-aware applications:
 * `scutil --proxy` on macOS, the Internet Settings registry key on Windows and
 * the GNOME proxy schema on Linux. Parsers are exported separately so they can
 * be unit tested against captured command output.
 */
import { execFile } from 'node:child_process';

export type SystemProxyMode = 'off' | 'manual' | 'pac';

export interface SystemProxySettings {
    mode: SystemProxyMode;
    source: 'macos' | 'windows' | 'linux' | 'none';
    /** PAC script URL when mode is `pac`. */
    pacUrl?: string;
    /** HTTP proxy URL for plain HTTP destinations. */
    httpProxy?: string;
    /** Proxy URL for HTTPS destinations (CONNECT), usually the same endpoint. */
    httpsProxy?: string;
    /** SOCKS proxy URL, used when no HTTP proxy is configured. */
    socksProxy?: string;
    /** Hosts the OS itself wants bypassed. */
    exceptions: string[];
}

const NO_SYSTEM_PROXY: SystemProxySettings = { mode: 'off', source: 'none', exceptions: [] };

const DETECTION_TIMEOUT_MS = 3000;

function runCommand(command: string, args: string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
        execFile(command, args, { timeout: DETECTION_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
            resolve(error ? undefined : stdout);
        });
    });
}

function hostPort(host: string | undefined, port: string | undefined): string | undefined {
    if (!host) {
        return undefined;
    }
    return port ? `${host}:${port}` : host;
}

/** Parses `scutil --proxy` output. */
export function parseMacSystemProxy(output: string): SystemProxySettings {
    const values = new Map<string, string>();
    const exceptions: string[] = [];
    let insideExceptions = false;

    for (const rawLine of output.split('\n')) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        if (insideExceptions) {
            if (line === '}') {
                insideExceptions = false;
                continue;
            }
            const entry = line.match(/^\d+\s*:\s*(.+)$/);
            if (entry) {
                exceptions.push(entry[1].trim());
            }
            continue;
        }
        if (/^ExceptionsList\s*:\s*<array>/.test(line)) {
            insideExceptions = true;
            continue;
        }
        const pair = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
        if (pair) {
            values.set(pair[1], pair[2].trim());
        }
    }

    const pacEnabled = values.get('ProxyAutoConfigEnable') === '1';
    const pacUrl = pacEnabled ? values.get('ProxyAutoConfigURLString') : undefined;
    const httpEndpoint = values.get('HTTPEnable') === '1'
        ? hostPort(values.get('HTTPProxy'), values.get('HTTPPort'))
        : undefined;
    const httpsEndpoint = values.get('HTTPSEnable') === '1'
        ? hostPort(values.get('HTTPSProxy'), values.get('HTTPSPort'))
        : undefined;
    const socksEndpoint = values.get('SOCKSEnable') === '1'
        ? hostPort(values.get('SOCKSProxy'), values.get('SOCKSPort'))
        : undefined;
    const mode: SystemProxyMode = pacUrl ? 'pac' : httpEndpoint || httpsEndpoint || socksEndpoint ? 'manual' : 'off';

    return {
        mode,
        source: 'macos',
        pacUrl,
        httpProxy: httpEndpoint ? `http://${httpEndpoint}` : undefined,
        httpsProxy: httpsEndpoint ? `http://${httpsEndpoint}` : undefined,
        socksProxy: socksEndpoint ? `socks5://${socksEndpoint}` : undefined,
        exceptions,
    };
}

interface WindowsProxyValues {
    proxyEnable?: string;
    proxyServer?: string;
    proxyOverride?: string;
    autoConfigUrl?: string;
}

/** Parses `reg query` output for the Internet Settings key. */
export function parseWindowsSystemProxy(output: string): SystemProxySettings {
    const values: WindowsProxyValues = {};
    for (const rawLine of output.split('\n')) {
        const match = rawLine.match(/^\s*(\S+)\s+REG_(?:SZ|DWORD|EXPAND_SZ)\s+(.*?)\s*$/);
        if (!match) {
            continue;
        }
        const [, name, value] = match;
        if (name === 'ProxyEnable') {
            values.proxyEnable = value;
        } else if (name === 'ProxyServer') {
            values.proxyServer = value;
        } else if (name === 'ProxyOverride') {
            values.proxyOverride = value;
        } else if (name === 'AutoConfigURL') {
            values.autoConfigUrl = value;
        }
    }
    return buildWindowsProxySettings(values);
}

/** Turns raw Windows Internet Settings values into resolved proxy URLs. */
export function buildWindowsProxySettings(values: WindowsProxyValues): SystemProxySettings {
    const exceptions = (values.proxyOverride ?? '')
        .split(';')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    const pacUrl = values.autoConfigUrl?.trim() || undefined;
    const enableValue = values.proxyEnable?.trim().toLowerCase();
    const enabled = enableValue === undefined || enableValue === '0x1' || enableValue === '1';

    let httpProxy: string | undefined;
    let httpsProxy: string | undefined;
    let socksProxy: string | undefined;

    if (enabled && values.proxyServer) {
        for (const entry of values.proxyServer.split(';')) {
            const [rawScheme, rawAddress] = entry.includes('=')
                ? entry.split('=', 2)
                : ['http', entry];
            const address = rawAddress?.trim();
            if (!address) {
                continue;
            }
            const scheme = rawScheme.trim().toLowerCase();
            if (scheme === 'http') {
                httpProxy = `http://${address}`;
            } else if (scheme === 'https') {
                httpsProxy = `http://${address}`;
            } else if (scheme === 'socks') {
                socksProxy = `socks5://${address}`;
            }
        }
    }

    const mode: SystemProxyMode = pacUrl ? 'pac' : httpProxy || httpsProxy || socksProxy ? 'manual' : 'off';
    return { mode, source: 'windows', pacUrl, httpProxy, httpsProxy, socksProxy, exceptions };
}

interface LinuxProxyValues {
    mode?: string;
    httpHost?: string;
    httpPort?: string;
    httpsHost?: string;
    httpsPort?: string;
    socksHost?: string;
    socksPort?: string;
    autoconfigUrl?: string;
    ignoreHosts?: string;
}

function gsettingsString(output: string | undefined): string | undefined {
    const value = output?.trim();
    if (!value || value === '@as []') {
        return undefined;
    }
    return value.replace(/^'(.*)'$/s, '$1');
}

/** Parses `gsettings get org.gnome.system.proxy*` values. */
export function parseLinuxSystemProxy(values: LinuxProxyValues): SystemProxySettings {
    const mode = gsettingsString(values.mode) ?? 'none';
    const exceptions = (gsettingsString(values.ignoreHosts) ?? '')
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((entry) => entry.trim().replace(/^'|'$/g, ''))
        .filter((entry) => entry.length > 0);

    if (mode === 'auto') {
        const pacUrl = gsettingsString(values.autoconfigUrl);
        return pacUrl
            ? { mode: 'pac', source: 'linux', pacUrl, exceptions }
            : { ...NO_SYSTEM_PROXY, source: 'linux', exceptions };
    }
    if (mode !== 'manual') {
        return { mode: 'off', source: 'linux', exceptions };
    }

    const httpHost = gsettingsString(values.httpHost);
    const httpsHost = gsettingsString(values.httpsHost);
    const socksHost = gsettingsString(values.socksHost);
    const httpPort = gsettingsString(values.httpPort);
    const httpsPort = gsettingsString(values.httpsPort);
    const socksPort = gsettingsString(values.socksPort);
    const httpProxy = httpHost ? `http://${hostPort(httpHost, httpPort)}` : undefined;
    const httpsProxy = httpsHost ? `http://${hostPort(httpsHost, httpsPort)}` : undefined;
    const socksProxy = socksHost ? `socks5://${hostPort(socksHost, socksPort)}` : undefined;

    return {
        mode: httpProxy || httpsProxy || socksProxy ? 'manual' : 'off',
        source: 'linux',
        httpProxy,
        httpsProxy,
        socksProxy,
        exceptions,
    };
}

async function detectMacSystemProxy(): Promise<SystemProxySettings> {
    const output = await runCommand('scutil', ['--proxy']);
    return output ? parseMacSystemProxy(output) : NO_SYSTEM_PROXY;
}

async function detectWindowsSystemProxy(): Promise<SystemProxySettings> {
    const output = await runCommand('reg', [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ]);
    return output ? parseWindowsSystemProxy(output) : NO_SYSTEM_PROXY;
}

async function detectLinuxSystemProxy(): Promise<SystemProxySettings> {
    const [mode, httpHost, httpPort, httpsHost, httpsPort, socksHost, socksPort, autoconfigUrl, ignoreHosts] =
        await Promise.all([
            runCommand('gsettings', ['get', 'org.gnome.system.proxy', 'mode']),
            runCommand('gsettings', ['get', 'org.gnome.system.proxy.http', 'host']),
            runCommand('gsettings', ['get', 'org.gnome.system.proxy.http', 'port']),
            runCommand('gsettings', ['get', 'org.gnome.system.proxy.https', 'host']),
            runCommand('gsettings', ['get', 'org.gnome.system.proxy.https', 'port']),
            runCommand('gsettings', ['get', 'org.gnome.system.proxy.socks', 'host']),
            runCommand('gsettings', ['get', 'org.gnome.system.proxy.socks', 'port']),
            runCommand('gsettings', ['get', 'org.gnome.system.proxy.auto', 'url']),
            runCommand('gsettings', ['get', 'org.gnome.system.proxy', 'ignore-hosts']),
        ]);

    return parseLinuxSystemProxy({
        mode,
        httpHost,
        httpPort,
        httpsHost,
        httpsPort,
        socksHost,
        socksPort,
        autoconfigUrl,
        ignoreHosts,
    });
}

/** Reads the operating system's proxy configuration. */
export async function detectSystemProxy(platform: NodeJS.Platform = process.platform): Promise<SystemProxySettings> {
    try {
        if (platform === 'darwin') {
            return await detectMacSystemProxy();
        }
        if (platform === 'win32') {
            return await detectWindowsSystemProxy();
        }
        return await detectLinuxSystemProxy();
    } catch {
        return NO_SYSTEM_PROXY;
    }
}
