import { describe, expect, it } from 'vitest';
import { getRequestPath, isOAuthMetadataDiscoveryPath } from './startHappyServer';

describe('startHappyServer request path helpers', () => {
    it('parses request paths from relative and absolute URLs', () => {
        expect(getRequestPath('/.well-known/oauth-authorization-server')).toBe('/.well-known/oauth-authorization-server');
        expect(getRequestPath('http://127.0.0.1:1234/.well-known/oauth-protected-resource/mcp')).toBe('/.well-known/oauth-protected-resource/mcp');
    });

    it('falls back to root path when request URL is missing', () => {
        expect(getRequestPath(undefined)).toBe('/');
    });

    it('detects OAuth metadata discovery paths', () => {
        expect(isOAuthMetadataDiscoveryPath('/.well-known/oauth-authorization-server')).toBe(true);
        expect(isOAuthMetadataDiscoveryPath('/.well-known/oauth-authorization-server/')).toBe(true);
        expect(isOAuthMetadataDiscoveryPath('/.well-known/oauth-protected-resource')).toBe(true);
        expect(isOAuthMetadataDiscoveryPath('/.well-known/oauth-protected-resource/mcp')).toBe(true);
    });

    it('does not match non OAuth discovery paths', () => {
        expect(isOAuthMetadataDiscoveryPath('/')).toBe(false);
        expect(isOAuthMetadataDiscoveryPath('/mcp')).toBe(false);
        expect(isOAuthMetadataDiscoveryPath('/.well-known/openid-configuration')).toBe(false);
    });
});
