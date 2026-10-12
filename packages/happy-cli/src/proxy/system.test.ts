import { describe, expect, it } from 'vitest';
import {
    buildWindowsProxySettings,
    parseLinuxSystemProxy,
    parseMacSystemProxy,
    parseWindowsSystemProxy,
} from '@/proxy/system';

const SCUTIL_MANUAL = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : 10.0.0.0/8
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : 127.0.0.1
}`;

const SCUTIL_PAC = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
  }
  ProxyAutoConfigEnable : 1
  ProxyAutoConfigURLString : http://wpad.example.com/proxy.pac
  HTTPEnable : 0
  HTTPProxy : 127.0.0.1
  HTTPPort : 7890
}`;

const SCUTIL_EMPTY = `<dictionary> {
  ExceptionsList : <array> {
  }
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 0
  ProxyAutoConfigEnable : 0
}`;

describe('macOS system proxy', () => {
    it('reads manual HTTP, HTTPS and SOCKS endpoints plus exceptions', () => {
        const settings = parseMacSystemProxy(SCUTIL_MANUAL);
        expect(settings.mode).toBe('manual');
        expect(settings.httpProxy).toBe('http://127.0.0.1:7890');
        expect(settings.httpsProxy).toBe('http://127.0.0.1:7890');
        expect(settings.socksProxy).toBe('socks5://127.0.0.1:1080');
        expect(settings.exceptions).toEqual(['*.local', '169.254/16', '10.0.0.0/8']);
    });

    it('prefers an enabled PAC script', () => {
        const settings = parseMacSystemProxy(SCUTIL_PAC);
        expect(settings.mode).toBe('pac');
        expect(settings.pacUrl).toBe('http://wpad.example.com/proxy.pac');
    });

    it('reports no proxy when every transport is disabled', () => {
        const settings = parseMacSystemProxy(SCUTIL_EMPTY);
        expect(settings.mode).toBe('off');
        expect(settings.httpProxy).toBeUndefined();
        expect(settings.socksProxy).toBeUndefined();
    });
});

const REG_MANUAL = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyOverride    REG_SZ    <local>;*.corp.example
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:1080`;

const REG_PAC = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    AutoConfigURL    REG_SZ    http://wpad/wpad.dat
    ProxyEnable    REG_DWORD    0x0`;

describe('Windows system proxy', () => {
    it('reads per-scheme proxy servers and the override list', () => {
        const settings = parseWindowsSystemProxy(REG_MANUAL);
        expect(settings.mode).toBe('manual');
        expect(settings.httpProxy).toBe('http://127.0.0.1:7890');
        expect(settings.httpsProxy).toBe('http://127.0.0.1:7890');
        expect(settings.socksProxy).toBe('socks5://127.0.0.1:1080');
        expect(settings.exceptions).toEqual(['<local>', '*.corp.example']);
    });

    it('accepts a bare host:port proxy server', () => {
        const settings = buildWindowsProxySettings({ proxyEnable: '0x1', proxyServer: '127.0.0.1:3128' });
        expect(settings.httpProxy).toBe('http://127.0.0.1:3128');
    });

    it('prefers an auto config URL and ignores disabled proxies', () => {
        const settings = parseWindowsSystemProxy(REG_PAC);
        expect(settings.mode).toBe('pac');
        expect(settings.pacUrl).toBe('http://wpad/wpad.dat');
        expect(settings.httpProxy).toBeUndefined();
    });
});

describe('Linux (GNOME) system proxy', () => {
    it('reads a manual proxy', () => {
        const settings = parseLinuxSystemProxy({
            mode: "'manual'",
            httpHost: "'127.0.0.1'",
            httpPort: '7890',
            httpsHost: "'127.0.0.1'",
            httpsPort: '7890',
            socksHost: "'127.0.0.1'",
            socksPort: '1080',
            ignoreHosts: "['localhost', '127.0.0.0/8', '*.internal']",
        });
        expect(settings.mode).toBe('manual');
        expect(settings.httpProxy).toBe('http://127.0.0.1:7890');
        expect(settings.socksProxy).toBe('socks5://127.0.0.1:1080');
        expect(settings.exceptions).toEqual(['localhost', '127.0.0.0/8', '*.internal']);
    });

    it('reads an automatic (PAC) proxy', () => {
        const settings = parseLinuxSystemProxy({
            mode: "'auto'",
            autoconfigUrl: "'http://wpad/wpad.dat'",
        });
        expect(settings.mode).toBe('pac');
        expect(settings.pacUrl).toBe('http://wpad/wpad.dat');
    });

    it('reports no proxy when the mode is none', () => {
        const settings = parseLinuxSystemProxy({ mode: "'none'", ignoreHosts: '@as []' });
        expect(settings.mode).toBe('off');
        expect(settings.exceptions).toEqual([]);
    });
});
