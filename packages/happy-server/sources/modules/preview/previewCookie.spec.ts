import { describe, it, expect } from 'vitest';
import {
    cookieName,
    readPreviewCookie,
    buildPreviewCookie,
} from '@/modules/preview/previewCookie';

const MID = 'c3e45bdb-b388-4d4f-8dff-bc1870e0e7d7';
const PORT = 3000;
const TOKEN = 'payload.sig';

describe('cookieName', () => {
    it('formats as happy_preview_{mid}_{port}', () => {
        expect(cookieName(MID, PORT)).toBe(`happy_preview_${MID}_${PORT}`);
    });
});

describe('readPreviewCookie', () => {
    it('returns null when the cookie header is absent', () => {
        expect(readPreviewCookie(undefined, MID, PORT)).toBeNull();
    });

    it('returns null when the cookie header is empty', () => {
        expect(readPreviewCookie('', MID, PORT)).toBeNull();
    });

    it('returns null when a different cookie is present but not ours', () => {
        const header = 'session=abc; other=xyz';
        expect(readPreviewCookie(header, MID, PORT)).toBeNull();
    });

    it('reads the single matching cookie value', () => {
        const header = `${cookieName(MID, PORT)}=${TOKEN}`;
        expect(readPreviewCookie(header, MID, PORT)).toBe(TOKEN);
    });

    it('reads the cookie when it appears first among many', () => {
        const header = `${cookieName(MID, PORT)}=${TOKEN}; session=abc; other=xyz`;
        expect(readPreviewCookie(header, MID, PORT)).toBe(TOKEN);
    });

    it('reads the cookie when it appears in the middle', () => {
        const header = `foo=1; ${cookieName(MID, PORT)}=${TOKEN}; bar=2`;
        expect(readPreviewCookie(header, MID, PORT)).toBe(TOKEN);
    });

    it('reads the cookie when it appears last', () => {
        const header = `foo=1; bar=2; ${cookieName(MID, PORT)}=${TOKEN}`;
        expect(readPreviewCookie(header, MID, PORT)).toBe(TOKEN);
    });

    it('decodes URL-encoded values', () => {
        // Some proxies or legacy clients URI-encode cookie values.
        const encoded = encodeURIComponent('payload.sig with spaces');
        const header = `${cookieName(MID, PORT)}=${encoded}`;
        expect(readPreviewCookie(header, MID, PORT)).toBe('payload.sig with spaces');
    });

    it('does not confuse a prefix-matching cookie name', () => {
        // `happy_preview_{mid}_{port}` vs `happy_preview_{mid}_{port}_extra`
        // the second must not match the first.
        const header = `${cookieName(MID, PORT)}_extra=SHOULD_NOT_MATCH; ok=1`;
        expect(readPreviewCookie(header, MID, PORT)).toBeNull();
    });

    it('returns the correct cookie when two different preview cookies coexist', () => {
        const otherMid = 'b9dbe026-284';
        const otherPort = 4001;
        const header =
            `${cookieName(otherMid, otherPort)}=OTHER; ` +
            `${cookieName(MID, PORT)}=${TOKEN}`;
        expect(readPreviewCookie(header, MID, PORT)).toBe(TOKEN);
        expect(readPreviewCookie(header, otherMid, otherPort)).toBe('OTHER');
    });

    it('escapes special regex characters in machineId safely', () => {
        // machineIds can contain dots or other chars across different
        // deployments; readPreviewCookie must treat the name as a literal.
        const mid = 'a.b+c';
        const header = `happy_preview_${mid}_${PORT}=${TOKEN}`;
        expect(readPreviewCookie(header, mid, PORT)).toBe(TOKEN);
    });
});

describe('buildPreviewCookie', () => {
    it('serializes with HttpOnly, SameSite=Lax, and the per-preview Path', () => {
        const out = buildPreviewCookie(MID, PORT, TOKEN, 600);
        expect(out).toContain(`${cookieName(MID, PORT)}=${encodeURIComponent(TOKEN)}`);
        expect(out).toContain('HttpOnly');
        expect(out).toContain('SameSite=Lax');
        expect(out).toContain(`Path=/v1/preview/${MID}/${PORT}/`);
        expect(out).toContain('Max-Age=600');
    });

    it('URL-encodes the token value (defense against stray =/;)', () => {
        const raw = 'abc.def==;drop';
        const out = buildPreviewCookie(MID, PORT, raw, 600);
        // Never raw — always URI-encoded. Cookie parsers will decode on read.
        expect(out).toContain(`${cookieName(MID, PORT)}=${encodeURIComponent(raw)}`);
        expect(out).not.toContain(`${cookieName(MID, PORT)}=${raw};drop`);
    });

    it('omits Secure by default (HTTP dev setups would drop it)', () => {
        const out = buildPreviewCookie(MID, PORT, TOKEN, 600);
        expect(out).not.toContain('Secure');
    });

    it('accepts a Secure attribute when the caller opts in (HTTPS deploys)', () => {
        const out = buildPreviewCookie(MID, PORT, TOKEN, 600, { secure: true });
        expect(out).toContain('Secure');
    });

    it('uses SameSite=None when Secure is enabled (cross-site iframe case)', () => {
        // Only matters for cross-origin iframes on HTTPS — Lax cookies don't
        // ship on third-party subresource fetches in that topology.
        const out = buildPreviewCookie(MID, PORT, TOKEN, 600, { secure: true, sameSite: 'None' });
        expect(out).toContain('SameSite=None');
        expect(out).toContain('Secure');
    });

    describe('mode: subdomain', () => {
        it('uses root Path and omits Domain (host-only scope)', () => {
            const out = buildPreviewCookie(MID, PORT, TOKEN, 600, { mode: 'subdomain' });
            expect(out).toContain('Path=/');
            expect(out).not.toContain(`Path=/v1/preview/`);
            expect(out).not.toMatch(/Domain=/);
        });

        it('preserves HttpOnly + Max-Age + token encoding', () => {
            const out = buildPreviewCookie(MID, PORT, TOKEN, 600, { mode: 'subdomain' });
            expect(out).toContain('HttpOnly');
            expect(out).toContain('Max-Age=600');
            expect(out).toContain(`${cookieName(MID, PORT)}=${encodeURIComponent(TOKEN)}`);
        });

        it('combines with secure + SameSite=None for cross-origin iframe', () => {
            const out = buildPreviewCookie(MID, PORT, TOKEN, 600, {
                mode: 'subdomain',
                secure: true,
                sameSite: 'None',
            });
            expect(out).toContain('Path=/');
            expect(out).toContain('Secure');
            expect(out).toContain('SameSite=None');
        });
    });
});
