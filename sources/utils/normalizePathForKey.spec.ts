import { describe, it, expect } from 'vitest';
import { normalizePathForKey } from './normalizePathForKey';

describe('normalizePathForKey', () => {
    it('should convert underscores to hyphens', () => {
        expect(normalizePathForKey('/Users/dev/my_project')).toBe('-Users-dev-my-project');
        expect(normalizePathForKey('/Users/dev/trading_signals_bot')).toBe('-Users-dev-trading-signals-bot');
    });

    it('should convert forward slashes to hyphens', () => {
        expect(normalizePathForKey('/Users/dev/project')).toBe('-Users-dev-project');
    });

    it('should convert dots to hyphens', () => {
        expect(normalizePathForKey('/Users/dev/my.project')).toBe('-Users-dev-my-project');
        expect(normalizePathForKey('/Users/dev/.hidden')).toBe('-Users-dev-hidden');
    });

    it('should preserve existing hyphens', () => {
        expect(normalizePathForKey('/Users/dev/car-log-plus')).toBe('-Users-dev-car-log-plus');
    });

    it('should collapse multiple hyphens into one', () => {
        expect(normalizePathForKey('/Users//dev///project')).toBe('-Users-dev-project');
    });

    it('should remove trailing hyphens but keep leading hyphen', () => {
        expect(normalizePathForKey('/Users/dev/project/')).toBe('-Users-dev-project');
    });

    it('should handle home directory shortcut', () => {
        expect(normalizePathForKey('~/Documents/project')).toBe('-Documents-project');
    });

    it('should return empty string for empty input', () => {
        expect(normalizePathForKey('')).toBe('');
    });

    it('should match Claude Code .claude/projects naming convention', () => {
        // Real-world examples from the issue
        expect(normalizePathForKey('/Users/iml1s/Documents/mine/trading_signals_bot'))
            .toBe('-Users-iml1s-Documents-mine-trading-signals-bot');
        expect(normalizePathForKey('/Users/iml1s/Documents/mine/happy'))
            .toBe('-Users-iml1s-Documents-mine-happy');
        expect(normalizePathForKey('/Users/iml1s/Documents/mine/car-log-plus'))
            .toBe('-Users-iml1s-Documents-mine-car-log-plus');
    });

    // Edge cases discovered from web search - GitHub issues #15481, #2224, #5814, #14310
    describe('edge cases from real-world issues', () => {
        it('should handle paths with spaces (Windows usernames like "John Doe")', () => {
            // GitHub issue #15481 - Windows paths with spaces fail
            expect(normalizePathForKey('/Users/John Doe/Documents/project'))
                .toBe('-Users-John-Doe-Documents-project');
            expect(normalizePathForKey('C:\\Users\\John Doe\\projects\\myapp'))
                .toBe('C-Users-John-Doe-projects-myapp');
            // iCloud Drive paths with spaces
            expect(normalizePathForKey('/Users/dev/Library/Mobile Documents/project'))
                .toBe('-Users-dev-Library-Mobile-Documents-project');
        });

        it('should handle Unicode/CJK paths (Chinese, Japanese, Korean)', () => {
            // GitHub issues #2224, #14310 - Unicode handling issues
            expect(normalizePathForKey('/Users/小明/projects/app'))
                .toBe('-Users-projects-app');
            expect(normalizePathForKey('/home/田中/code/project'))
                .toBe('-home-code-project');
            expect(normalizePathForKey('/Users/김철수/Documents/work'))
                .toBe('-Users-Documents-work');
            // Mixed ASCII and Unicode
            expect(normalizePathForKey('/Users/dev/我的專案'))
                .toBe('-Users-dev');
        });

        it('should handle Windows paths with backslashes and drive letters', () => {
            // GitHub issue #5814 - Windows path normalization
            expect(normalizePathForKey('C:\\Users\\dev\\project'))
                .toBe('C-Users-dev-project');
            expect(normalizePathForKey('D:\\Projects\\my_app'))
                .toBe('D-Projects-my-app');
            // UNC paths
            expect(normalizePathForKey('\\\\server\\share\\project'))
                .toBe('-server-share-project');
        });

        it('should handle double hyphens in original path names', () => {
            // Codex review concern - paths with double hyphens should collapse
            expect(normalizePathForKey('/Users/dev/my--project'))
                .toBe('-Users-dev-my-project');
            expect(normalizePathForKey('/Users/dev/test---app'))
                .toBe('-Users-dev-test-app');
        });

        it('should handle trailing special characters', () => {
            // Paths ending with special characters
            expect(normalizePathForKey('/Users/dev/project_'))
                .toBe('-Users-dev-project');
            expect(normalizePathForKey('/Users/dev/project.'))
                .toBe('-Users-dev-project');
            expect(normalizePathForKey('/Users/dev/project-'))
                .toBe('-Users-dev-project');
        });

        it('should handle special Unicode whitespace characters', () => {
            // GitHub issue #2224 - narrow no-break space (U+202F) used in macOS screenshots
            expect(normalizePathForKey('/Users/dev/Screenshot\u202FPM.png'))
                .toBe('-Users-dev-Screenshot-PM-png');
            // Other special whitespace
            expect(normalizePathForKey('/Users/dev/file\u00A0name')) // non-breaking space
                .toBe('-Users-dev-file-name');
        });

        it('should handle mixed special characters', () => {
            expect(normalizePathForKey('/Users/John_Doe/My.Project/src'))
                .toBe('-Users-John-Doe-My-Project-src');
            expect(normalizePathForKey('C:\\Users\\dev\\my_project.v2'))
                .toBe('C-Users-dev-my-project-v2');
        });
    });

    // Additional edge cases from Codex review + Context7/web research
    describe('advanced edge cases', () => {
        it('should handle Unicode NFC vs NFD normalization variants (results may differ)', () => {
            // macOS APFS/HFS+ uses NFD (decomposed), others use NFC (composed)
            // Source: https://eclecticlight.co/2021/05/08/explainer-unicode-normalization-and-apfs/
            // café in NFC (precomposed) - single character é (U+00E9)
            expect(normalizePathForKey('/Users/dev/café'))
                .toBe('-Users-dev-caf');
            // café in NFD (decomposed) - e + combining acute accent (U+0065 + U+0301)
            expect(normalizePathForKey('/Users/dev/cafe\u0301'))
                .toBe('-Users-dev-cafe');
            // IMPORTANT: NFC and NFD produce DIFFERENT keys because:
            // - NFC: 'é' (U+00E9) is stripped as non-ASCII, leaving 'caf'
            // - NFD: 'e' (U+0065) + combining accent (U+0301) - 'e' is preserved, accent stripped, leaving 'cafe'
            // This is a known limitation - same folder on different filesystems may produce different keys
        });

        it('should handle emoji folder names', () => {
            // Source: https://www.howtogeek.com/682868/you-can-use-emoji-in-file-names-on-windows-10/
            // Emoji are supported on Windows 10/11, macOS, and Linux
            expect(normalizePathForKey('/Users/dev/🚀project'))
                .toBe('-Users-dev-project');
            expect(normalizePathForKey('/Users/dev/my-app-📱'))
                .toBe('-Users-dev-my-app');
            expect(normalizePathForKey('/Users/dev/✨magic✨'))
                .toBe('-Users-dev-magic');
            // Multiple emoji
            expect(normalizePathForKey('/Users/dev/🔥🔥🔥'))
                .toBe('-Users-dev');
        });

        it('should handle Windows path variants', () => {
            // Source: https://github.com/ehmicky/cross-platform-node-guide/blob/main/docs/3_filesystem/file_paths.md
            // Lowercase drive letters
            expect(normalizePathForKey('c:\\Users\\dev\\project'))
                .toBe('c-Users-dev-project');
            // Forward-slash Windows paths (accepted by Windows)
            expect(normalizePathForKey('C:/Users/dev/project'))
                .toBe('C-Users-dev-project');
            // Mixed delimiters (Windows accepts both)
            expect(normalizePathForKey('C:\\Users/dev\\project'))
                .toBe('C-Users-dev-project');
            // Extended-length paths (\\?\)
            expect(normalizePathForKey('\\\\?\\C:\\very\\long\\path'))
                .toBe('-C-very-long-path');
            // Drive-relative paths (C:folder without backslash)
            expect(normalizePathForKey('C:folder'))
                .toBe('C-folder');
        });

        it('should handle relative paths and edge cases', () => {
            // Relative path with ./
            expect(normalizePathForKey('./project'))
                .toBe('-project');
            // Relative path with ../
            expect(normalizePathForKey('../parent/project'))
                .toBe('-parent-project');
            // Root path only
            expect(normalizePathForKey('/'))
                .toBe('');
            // Current directory only
            expect(normalizePathForKey('.'))
                .toBe('');
            // Parent directory only
            expect(normalizePathForKey('..'))
                .toBe('');
        });

        it('should handle accented characters (diacritics)', () => {
            // Common European accented characters
            expect(normalizePathForKey('/Users/dev/naïve'))
                .toBe('-Users-dev-na-ve');
            expect(normalizePathForKey('/Users/dev/Ångström'))
                .toBe('-Users-dev-ngstr-m');
            expect(normalizePathForKey('/Users/dev/señor'))
                .toBe('-Users-dev-se-or');
            // German umlauts
            expect(normalizePathForKey('/Users/dev/größe'))
                .toBe('-Users-dev-gr-e');
        });

        it('should preserve case for Windows drive letters (case-sensitive behavior)', () => {
            // Current implementation is case-sensitive - C: and c: produce DIFFERENT keys
            // This matches the behavior of preserving original path casing
            const upperCase = normalizePathForKey('C:\\Users\\dev\\project');
            const lowerCase = normalizePathForKey('c:\\Users\\dev\\project');
            // These are intentionally different - case is preserved
            expect(upperCase).toBe('C-Users-dev-project');
            expect(lowerCase).toBe('c-Users-dev-project');
            // Note: If case-insensitive matching is needed in the future,
            // the function would need to be updated to normalize case
        });
    });
});
