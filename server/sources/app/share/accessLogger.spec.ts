import { describe, it, expect, beforeEach, vi } from 'vitest';
import { logSessionShareAccess, logPublicShareAccess, getIpAddress, getUserAgent } from './accessLogger';
import { db } from '@/storage/db';

vi.mock('@/storage/db', () => ({
    db: {
        sessionShareAccessLog: {
            create: vi.fn()
        },
        publicShareAccessLog: {
            create: vi.fn()
        }
    }
}));

describe('accessLogger', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('logSessionShareAccess', () => {
        it('should log access with IP and user agent', async () => {
            await logSessionShareAccess('share-1', 'user-1', '192.168.1.1', 'Mozilla/5.0');

            expect(db.sessionShareAccessLog.create).toHaveBeenCalledWith({
                data: {
                    sessionShareId: 'share-1',
                    userId: 'user-1',
                    ipAddress: '192.168.1.1',
                    userAgent: 'Mozilla/5.0'
                }
            });
        });

        it('should log access without IP and user agent', async () => {
            await logSessionShareAccess('share-1', 'user-1');

            expect(db.sessionShareAccessLog.create).toHaveBeenCalledWith({
                data: {
                    sessionShareId: 'share-1',
                    userId: 'user-1',
                    ipAddress: null,
                    userAgent: null
                }
            });
        });
    });

    describe('logPublicShareAccess', () => {
        it('should log access with all fields', async () => {
            await logPublicShareAccess('public-1', 'user-1', '192.168.1.1', 'Mozilla/5.0');

            expect(db.publicShareAccessLog.create).toHaveBeenCalledWith({
                data: {
                    publicShareId: 'public-1',
                    userId: 'user-1',
                    ipAddress: '192.168.1.1',
                    userAgent: 'Mozilla/5.0'
                }
            });
        });

        it('should log anonymous access', async () => {
            await logPublicShareAccess('public-1', null);

            expect(db.publicShareAccessLog.create).toHaveBeenCalledWith({
                data: {
                    publicShareId: 'public-1',
                    userId: null,
                    ipAddress: null,
                    userAgent: null
                }
            });
        });

        it('should log access with consent (IP and UA present)', async () => {
            await logPublicShareAccess('public-1', null, '10.0.0.1', 'Chrome/100.0');

            expect(db.publicShareAccessLog.create).toHaveBeenCalledWith({
                data: {
                    publicShareId: 'public-1',
                    userId: null,
                    ipAddress: '10.0.0.1',
                    userAgent: 'Chrome/100.0'
                }
            });
        });
    });

    describe('getIpAddress', () => {
        it('should extract IP from x-forwarded-for header', () => {
            const headers = { 'x-forwarded-for': '203.0.113.1, 198.51.100.1' };
            const result = getIpAddress(headers);
            expect(result).toBe('203.0.113.1');
        });

        it('should handle x-forwarded-for as array', () => {
            const headers = { 'x-forwarded-for': ['203.0.113.1, 198.51.100.1'] };
            const result = getIpAddress(headers);
            expect(result).toBe('203.0.113.1');
        });

        it('should extract IP from x-real-ip header', () => {
            const headers = { 'x-real-ip': '203.0.113.5' };
            const result = getIpAddress(headers);
            expect(result).toBe('203.0.113.5');
        });

        it('should prefer x-forwarded-for over x-real-ip', () => {
            const headers = {
                'x-forwarded-for': '203.0.113.1',
                'x-real-ip': '203.0.113.5'
            };
            const result = getIpAddress(headers);
            expect(result).toBe('203.0.113.1');
        });

        it('should return undefined when no IP headers present', () => {
            const headers = {};
            const result = getIpAddress(headers);
            expect(result).toBeUndefined();
        });

        it('should trim whitespace from IP address', () => {
            const headers = { 'x-forwarded-for': '  203.0.113.1  , 198.51.100.1' };
            const result = getIpAddress(headers);
            expect(result).toBe('203.0.113.1');
        });
    });

    describe('getUserAgent', () => {
        it('should extract user agent from header', () => {
            const headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
            const result = getUserAgent(headers);
            expect(result).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
        });

        it('should handle user agent as array', () => {
            const headers = { 'user-agent': ['Mozilla/5.0'] };
            const result = getUserAgent(headers);
            expect(result).toBe('Mozilla/5.0');
        });

        it('should return undefined when no user agent header', () => {
            const headers = {};
            const result = getUserAgent(headers);
            expect(result).toBeUndefined();
        });

        it('should return undefined for empty user agent', () => {
            const headers = { 'user-agent': '' };
            const result = getUserAgent(headers);
            expect(result).toBeUndefined();
        });
    });
});
