import { describe, expect, it } from 'vitest';
import { mergeRemoteProxyConfig, toRemoteProxyConfig } from '@/proxy';
import { DEFAULT_PROXY_CONFIG, type ProxyConfig } from '@/proxy/types';

const stored: ProxyConfig = {
    mode: 'manual',
    manual: { protocol: 'http', host: 'proxy.corp', port: 3128, username: 'alice', password: 'hunter2' },
    noProxy: ['internal.corp'],
    useForChildProcesses: true,
};

describe('proxy configuration over the relay', () => {
    it('never sends the proxy password to a remote client', () => {
        const remote = toRemoteProxyConfig(stored);
        expect(remote.manual).toEqual({
            protocol: 'http',
            host: 'proxy.corp',
            port: 3128,
            username: 'alice',
            hasPassword: true,
        });
        expect(JSON.stringify(remote)).not.toContain('hunter2');
    });

    it('keeps the stored password when a remote update omits it', () => {
        const merged = mergeRemoteProxyConfig({ mode: 'manual', manual: { protocol: 'socks5h', host: '127.0.0.1', port: 1080 } }, stored);
        expect(merged.manual).toEqual({
            protocol: 'socks5h',
            host: '127.0.0.1',
            port: 1080,
            username: 'alice',
            password: 'hunter2',
        });
    });

    it('clears the password when a remote update sends an empty one', () => {
        const merged = mergeRemoteProxyConfig({ manual: { password: '' } }, stored);
        expect(merged.manual?.password).toBe('');
    });

    it('keeps the manual endpoint when switching away from manual mode', () => {
        const merged = mergeRemoteProxyConfig({ mode: 'system' }, stored);
        expect(merged.mode).toBe('system');
        expect(merged.manual?.host).toBe('proxy.corp');
    });

    it('applies a full remote update for a fresh configuration', () => {
        const merged = mergeRemoteProxyConfig(
            { mode: 'pac', pacUrl: 'http://wpad/wpad.dat', noProxy: ['a.com'], useForChildProcesses: false },
            { ...DEFAULT_PROXY_CONFIG },
        );
        expect(merged).toEqual({
            mode: 'pac',
            pacUrl: 'http://wpad/wpad.dat',
            noProxy: ['a.com'],
            useForChildProcesses: false,
            manual: undefined,
        });
    });

    it('rejects an invalid remote update', () => {
        expect(() => mergeRemoteProxyConfig({ mode: 'nonsense' }, stored)).toThrow();
    });
});
