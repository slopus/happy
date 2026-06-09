/**
 * Tests for rewriteLocationHeader — specs/preview-relay-escape-plug Phase A.
 *
 * Server-side `Location: /admin` 응답 헤더는 브라우저가 iframe 의 현재
 * origin (relay host) 기준으로 follow → escape. relay 가 prefix 부착
 * 으로 차단.
 */
import { describe, it, expect } from 'vitest';
import { rewriteLocationHeader } from '@/modules/preview/rewriteLocationHeader';

const PREFIX = '/v1/preview/abc/30000';

describe('rewriteLocationHeader', () => {
    describe('absolute path → prefix 부착', () => {
        it('root path', () => {
            expect(rewriteLocationHeader('/admin', PREFIX)).toBe(
                '/v1/preview/abc/30000/admin',
            );
        });

        it('nested path + query + hash', () => {
            expect(
                rewriteLocationHeader('/dashboard/x?a=1&b=2#section', PREFIX),
            ).toBe('/v1/preview/abc/30000/dashboard/x?a=1&b=2#section');
        });

        it('just slash', () => {
            expect(rewriteLocationHeader('/', PREFIX)).toBe(
                '/v1/preview/abc/30000/',
            );
        });
    });

    describe('idempotent — 이미 prefix 시작', () => {
        it('정확한 prefix 시작', () => {
            expect(
                rewriteLocationHeader('/v1/preview/abc/30000/admin', PREFIX),
            ).toBe('/v1/preview/abc/30000/admin');
        });

        it('prefix 만 (그대로)', () => {
            expect(
                rewriteLocationHeader('/v1/preview/abc/30000', PREFIX),
            ).toBe('/v1/preview/abc/30000');
        });
    });

    describe('상대 경로 → 그대로 통과', () => {
        it('확장자 없는 단순 이름', () => {
            expect(rewriteLocationHeader('admin', PREFIX)).toBe('admin');
        });

        it('명시적 상대 경로', () => {
            expect(rewriteLocationHeader('./admin', PREFIX)).toBe('./admin');
        });

        it('상위 디렉토리', () => {
            expect(rewriteLocationHeader('../admin', PREFIX)).toBe('../admin');
        });
    });

    describe('cross-origin / protocol-relative → 그대로 통과', () => {
        it('https absolute URL', () => {
            expect(
                rewriteLocationHeader('https://google.com/login', PREFIX),
            ).toBe('https://google.com/login');
        });

        it('http absolute URL', () => {
            expect(
                rewriteLocationHeader('http://example.com/x', PREFIX),
            ).toBe('http://example.com/x');
        });

        it('protocol-relative', () => {
            expect(rewriteLocationHeader('//cdn.example/x', PREFIX)).toBe(
                '//cdn.example/x',
            );
        });
    });

    describe('dev-server self URL → preview path 로 정규화', () => {
        it('0.0.0.0 absolute URL 은 prefix 안의 path 로 변환', () => {
            expect(
                rewriteLocationHeader('http://0.0.0.0:30021/cases/1?step=2#chat', PREFIX),
            ).toBe('/v1/preview/abc/30000/cases/1?step=2#chat');
        });

        it('localhost absolute URL 은 prefix 안의 path 로 변환', () => {
            expect(
                rewriteLocationHeader('http://localhost:30021/cases/1', PREFIX),
            ).toBe('/v1/preview/abc/30000/cases/1');
        });

        it('subdomain mode(prefix 없음) 에서는 path-only Location 으로 변환', () => {
            expect(
                rewriteLocationHeader('http://127.0.0.1:30021/cases/1', ''),
            ).toBe('/cases/1');
        });

        it('protocol-relative loopback URL 도 path-only 로 변환', () => {
            expect(
                rewriteLocationHeader('//0.0.0.0:30021/cases/1', PREFIX),
            ).toBe('/v1/preview/abc/30000/cases/1');
        });
    });

    describe('edge cases', () => {
        it('빈 문자열은 그대로', () => {
            expect(rewriteLocationHeader('', PREFIX)).toBe('');
        });

        it('비슷한 prefix 접두 (실제 prefix 아님)', () => {
            // /v1/preview/abc/30000xyz/... 같은 longer port 처럼 보이지만
            // 슬래시 boundary 가 없어 idempotent 처리 대상 아님 → prefix 부착
            expect(
                rewriteLocationHeader('/v1/preview/abc/30000xyz', PREFIX),
            ).toBe('/v1/preview/abc/30000/v1/preview/abc/30000xyz');
        });

        it('prefix 가 빈 문자열이면 absolute path 는 그대로 통과 (graceful)', () => {
            expect(rewriteLocationHeader('/admin', '')).toBe('/admin');
        });
    });
});
