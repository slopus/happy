import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerUrl, setServerUrl } from './serverConfig';

describe('服务器地址配置', () => {
    beforeEach(() => {
        vi.stubEnv('EXPO_PUBLIC_HAPPY_SERVER_URL', '');
        delete (globalThis as { __HAPPY_CONFIG__?: { serverUrl?: string } }).__HAPPY_CONFIG__;
        setServerUrl(null);
    });

    it('默认使用自托管 API 的 HTTPS 地址', () => {
        expect(getServerUrl()).toBe('https://47.115.228.20:8443');
    });

    it('自动迁移短暂发布过的 HTTP 默认地址', () => {
        setServerUrl('http://47.115.228.20:3005');
        expect(getServerUrl()).toBe('https://47.115.228.20:8443');
    });

    it('保留用户手动配置的服务器地址', () => {
        setServerUrl('https://example.com:8443');
        expect(getServerUrl()).toBe('https://example.com:8443');
    });
});
