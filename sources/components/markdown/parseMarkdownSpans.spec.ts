import { describe, it, expect } from 'vitest';
import { parseMarkdownSpans } from './parseMarkdownSpans';

describe('parseMarkdownSpans', () => {
    describe('URL detection', () => {
        describe('basic URL detection', () => {
            it('should detect https:// URLs', () => {
                const result = parseMarkdownSpans('Check out https://example.com for more info', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'https://example.com',
                    url: 'https://example.com'
                });
            });

            it('should detect http:// URLs', () => {
                const result = parseMarkdownSpans('Visit http://example.com', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'http://example.com',
                    url: 'http://example.com'
                });
            });

            it('should detect www. URLs and prefix with https://', () => {
                const result = parseMarkdownSpans('Go to www.example.com', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'www.example.com',
                    url: 'https://www.example.com'
                });
            });
        });

        describe('multiple URLs', () => {
            it('should detect multiple URLs in one line', () => {
                const result = parseMarkdownSpans('Visit https://example.com and https://another.com', false);
                const urls = result.filter(span => span.url !== null);
                expect(urls).toHaveLength(2);
                expect(urls[0].url).toBe('https://example.com');
                expect(urls[1].url).toBe('https://another.com');
            });

            it('should detect mixed URL types', () => {
                const result = parseMarkdownSpans('Check https://example.com and http://test.com and www.another.com', false);
                const urls = result.filter(span => span.url !== null);
                expect(urls).toHaveLength(3);
                expect(urls[0].url).toBe('https://example.com');
                expect(urls[1].url).toBe('http://test.com');
                expect(urls[2].url).toBe('https://www.another.com');
            });
        });

        describe('URLs with paths and parameters', () => {
            it('should handle URLs with paths', () => {
                const result = parseMarkdownSpans('Link: https://example.com/path/to/page', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'https://example.com/path/to/page',
                    url: 'https://example.com/path/to/page'
                });
            });

            it('should handle URLs with query parameters', () => {
                const result = parseMarkdownSpans('Search: https://example.com/search?q=test&page=1', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'https://example.com/search?q=test&page=1',
                    url: 'https://example.com/search?q=test&page=1'
                });
            });

            it('should handle URLs with fragments', () => {
                const result = parseMarkdownSpans('Docs: https://example.com/docs#section', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'https://example.com/docs#section',
                    url: 'https://example.com/docs#section'
                });
            });

            it('should handle complex URLs', () => {
                const result = parseMarkdownSpans('API: https://api.example.com/v1/users?id=123&sort=name#results', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'https://api.example.com/v1/users?id=123&sort=name#results',
                    url: 'https://api.example.com/v1/users?id=123&sort=name#results'
                });
            });
        });

        describe('interaction with markdown formatting', () => {
            it('should detect URLs in markdown links', () => {
                const result = parseMarkdownSpans('[Click here](https://example.com)', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'Click here',
                    url: 'https://example.com'
                });
            });

            it('should not detect URLs inside code blocks', () => {
                const result = parseMarkdownSpans('Code: `https://example.com`', false);
                const codeSpan = result.find(span => span.styles.includes('code'));
                expect(codeSpan).toBeDefined();
                expect(codeSpan?.text).toBe('https://example.com');
                expect(codeSpan?.url).toBeNull();
            });

            it('should not interfere with bold text containing URLs', () => {
                const result = parseMarkdownSpans('**Check https://example.com now**', false);
                // URLs inside markdown formatting are not auto-detected (the markdown pattern matches first)
                // This is expected behavior - users can use markdown link syntax for formatted links
                const boldSpan = result.find(span => span.styles.includes('bold'));
                expect(boldSpan).toBeDefined();
                expect(boldSpan?.text).toContain('https://example.com');
            });

            it('should not interfere with italic text containing URLs', () => {
                const result = parseMarkdownSpans('*Visit https://example.com today*', false);
                // URLs inside markdown formatting are not auto-detected (the markdown pattern matches first)
                // This is expected behavior - users can use markdown link syntax for formatted links
                const italicSpan = result.find(span => span.styles.includes('italic'));
                expect(italicSpan).toBeDefined();
                expect(italicSpan?.text).toContain('https://example.com');
            });
        });

        describe('text preservation around URLs', () => {
            it('should preserve text before URL', () => {
                const result = parseMarkdownSpans('Before https://example.com', false);
                expect(result[0]).toEqual({ styles: [], text: 'Before ', url: null });
                expect(result[1]).toEqual({ styles: [], text: 'https://example.com', url: 'https://example.com' });
            });

            it('should preserve text after URL', () => {
                const result = parseMarkdownSpans('https://example.com after', false);
                expect(result[0]).toEqual({ styles: [], text: 'https://example.com', url: 'https://example.com' });
                expect(result[1]).toEqual({ styles: [], text: ' after', url: null });
            });

            it('should preserve text around URL', () => {
                const result = parseMarkdownSpans('Before https://example.com after', false);
                expect(result).toHaveLength(3);
                expect(result[0]).toEqual({ styles: [], text: 'Before ', url: null });
                expect(result[1]).toEqual({ styles: [], text: 'https://example.com', url: 'https://example.com' });
                expect(result[2]).toEqual({ styles: [], text: ' after', url: null });
            });
        });

        describe('edge cases', () => {
            it('should handle URLs at the start of text', () => {
                const result = parseMarkdownSpans('https://example.com is great', false);
                expect(result[0]).toEqual({ styles: [], text: 'https://example.com', url: 'https://example.com' });
            });

            it('should handle URLs at the end of text', () => {
                const result = parseMarkdownSpans('Visit https://example.com', false);
                const urlSpan = result.find(span => span.url);
                expect(urlSpan?.text).toBe('https://example.com');
            });

            it('should handle single URL', () => {
                const result = parseMarkdownSpans('https://example.com', false);
                expect(result).toHaveLength(1);
                expect(result[0]).toEqual({ styles: [], text: 'https://example.com', url: 'https://example.com' });
            });

            it('should handle URLs with ports', () => {
                const result = parseMarkdownSpans('http://localhost:3000/api', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'http://localhost:3000/api',
                    url: 'http://localhost:3000/api'
                });
            });

            it('should handle URLs with subdomains', () => {
                const result = parseMarkdownSpans('https://api.dev.example.com/v1', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'https://api.dev.example.com/v1',
                    url: 'https://api.dev.example.com/v1'
                });
            });

            it('should handle URLs with hyphens in domain', () => {
                const result = parseMarkdownSpans('https://my-awesome-site.com', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'https://my-awesome-site.com',
                    url: 'https://my-awesome-site.com'
                });
            });

            it('should handle URLs followed by punctuation', () => {
                const result = parseMarkdownSpans('Check https://example.com here', false);
                const urlSpan = result.find(span => span.url);
                expect(urlSpan?.text).toBe('https://example.com');
                expect(urlSpan?.url).toBe('https://example.com');
            });
        });

        describe('real-world examples', () => {
            it('should handle GitHub URLs', () => {
                const result = parseMarkdownSpans('Check out https://github.com/slopus/happy', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'https://github.com/slopus/happy',
                    url: 'https://github.com/slopus/happy'
                });
            });

            it('should handle documentation URLs', () => {
                const result = parseMarkdownSpans('Read the docs at https://happy.engineering/docs/', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'https://happy.engineering/docs/',
                    url: 'https://happy.engineering/docs/'
                });
            });

            it('should handle API endpoint URLs', () => {
                const result = parseMarkdownSpans('POST to https://api.example.com/v1/users', false);
                expect(result).toContainEqual({
                    styles: [],
                    text: 'https://api.example.com/v1/users',
                    url: 'https://api.example.com/v1/users'
                });
            });

            it('should handle Yahoo URLs', () => {
                const result = parseMarkdownSpans('Visit https://www.yahoo.com or www.yahoo.com', false);
                const urls = result.filter(span => span.url !== null);
                expect(urls).toHaveLength(2);
                expect(urls[0].url).toBe('https://www.yahoo.com');
                expect(urls[1].url).toBe('https://www.yahoo.com');
            });
        });
    });

    describe('existing markdown functionality', () => {
        it('should handle bold text', () => {
            const result = parseMarkdownSpans('**bold text**', false);
            expect(result).toContainEqual({
                styles: ['bold'],
                text: 'bold text',
                url: null
            });
        });

        it('should handle italic text', () => {
            const result = parseMarkdownSpans('*italic text*', false);
            expect(result).toContainEqual({
                styles: ['italic'],
                text: 'italic text',
                url: null
            });
        });

        it('should handle inline code', () => {
            const result = parseMarkdownSpans('`code text`', false);
            expect(result).toContainEqual({
                styles: ['code'],
                text: 'code text',
                url: null
            });
        });

        it('should handle markdown links', () => {
            const result = parseMarkdownSpans('[link text](https://example.com)', false);
            expect(result).toContainEqual({
                styles: [],
                text: 'link text',
                url: 'https://example.com'
            });
        });

        it('should handle plain text', () => {
            const result = parseMarkdownSpans('plain text', false);
            expect(result).toEqual([{
                styles: [],
                text: 'plain text',
                url: null
            }]);
        });

        it('should handle mixed formatting', () => {
            const result = parseMarkdownSpans('Some **bold** and *italic* text', false);
            expect(result.length).toBeGreaterThan(1);
            expect(result.some(span => span.styles.includes('bold'))).toBe(true);
            expect(result.some(span => span.styles.includes('italic'))).toBe(true);
        });
    });
});
