import { describe, it, expect } from 'vitest';
import { isLikelyGithubPat } from './validateGithubPat';

describe('isLikelyGithubPat', () => {
    it('accepts classic PAT prefix ghp_', () => {
        expect(isLikelyGithubPat('ghp_AAAAAAAAAAAAAAAAAAAA')).toBe(true);
    });

    it('accepts fine-grained PAT prefix github_pat_', () => {
        expect(isLikelyGithubPat('github_pat_AAAAAAAAAAAAAAAAAAAA_BBBBB')).toBe(true);
    });

    it('accepts OAuth user-to-server token prefix gho_', () => {
        expect(isLikelyGithubPat('gho_AAAAAAAAAAAAAAAAAAAA')).toBe(true);
    });

    it('accepts server-to-server token prefix ghs_', () => {
        expect(isLikelyGithubPat('ghs_AAAAAAAAAAAAAAAAAAAA')).toBe(true);
    });

    it('rejects unknown prefix (e.g. OpenAI sk-)', () => {
        expect(isLikelyGithubPat('sk-AAAAAAAAAAAAAAAAAAAA')).toBe(false);
    });

    it('rejects no-prefix opaque string', () => {
        expect(isLikelyGithubPat('AAAAAAAAAAAAAAAAAAAA')).toBe(false);
    });

    it('rejects too-short input even with correct prefix', () => {
        expect(isLikelyGithubPat('ghp_short')).toBe(false);
    });

    it('rejects empty string', () => {
        expect(isLikelyGithubPat('')).toBe(false);
    });

    it('rejects non-string input', () => {
        expect(isLikelyGithubPat(null as unknown as string)).toBe(false);
        expect(isLikelyGithubPat(undefined as unknown as string)).toBe(false);
        expect(isLikelyGithubPat(123 as unknown as string)).toBe(false);
    });

    it('rejects whitespace around an otherwise-valid token (caller must trim)', () => {
        // Strict — better to fail loudly than silently accept stray whitespace
        // that breaks downstream HTTP Authorization header building.
        expect(isLikelyGithubPat(' ghp_AAAAAAAAAAAAAAAAAAAA ')).toBe(false);
    });
});
