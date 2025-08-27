import { describe, it, expect } from 'vitest';
import { resolveAbsolutePath, resolvePath } from './pathUtils';

describe('pathUtils', () => {
    describe('resolveAbsolutePath', () => {
        describe('basic tilde expansion', () => {
            it('should expand ~ to home directory', () => {
                expect(resolveAbsolutePath('~', '/Users/steve')).toBe('/Users/steve');
            });

            it('should expand ~/ to home directory with trailing slash', () => {
                expect(resolveAbsolutePath('~/', '/Users/steve')).toBe('/Users/steve/');
            });

            it('should expand ~/Documents to home directory plus path', () => {
                expect(resolveAbsolutePath('~/Documents', '/Users/steve')).toBe('/Users/steve/Documents');
            });

            it('should expand ~/Documents/project to nested path', () => {
                expect(resolveAbsolutePath('~/Documents/project', '/Users/steve')).toBe('/Users/steve/Documents/project');
            });

            it('should expand ~/Documents/deep/nested/path', () => {
                expect(resolveAbsolutePath('~/Documents/deep/nested/path', '/Users/steve')).toBe('/Users/steve/Documents/deep/nested/path');
            });
        });

        describe('non-tilde paths remain unchanged', () => {
            it('should not modify absolute Unix paths', () => {
                expect(resolveAbsolutePath('/usr/local/bin', '/Users/steve')).toBe('/usr/local/bin');
            });

            it('should not modify absolute Windows paths', () => {
                expect(resolveAbsolutePath('C:\\Program Files', 'C:\\Users\\steve')).toBe('C:\\Program Files');
            });

            it('should not modify relative paths', () => {
                expect(resolveAbsolutePath('./folder', '/Users/steve')).toBe('./folder');
                expect(resolveAbsolutePath('../parent', '/Users/steve')).toBe('../parent');
                expect(resolveAbsolutePath('relative/path', '/Users/steve')).toBe('relative/path');
            });

            it('should not modify paths starting with ~username (other user homes)', () => {
                expect(resolveAbsolutePath('~root', '/Users/steve')).toBe('~root');
                expect(resolveAbsolutePath('~john/Documents', '/Users/steve')).toBe('~john/Documents');
            });
        });

        describe('Windows path handling', () => {
            it('should expand ~ with Windows home directory', () => {
                expect(resolveAbsolutePath('~', 'C:\\Users\\steve')).toBe('C:\\Users\\steve');
            });

            it('should use Windows separator for Windows home', () => {
                expect(resolveAbsolutePath('~/Documents', 'C:\\Users\\steve')).toBe('C:\\Users\\steve\\Documents');
                expect(resolveAbsolutePath('~/Documents/project', 'C:\\Users\\steve')).toBe('C:\\Users\\steve\\Documents/project');
            });

            it('should handle Windows home with forward slashes', () => {
                expect(resolveAbsolutePath('~/Documents', 'C:/Users/steve')).toBe('C:/Users/steve/Documents');
            });
        });

        describe('edge cases', () => {
            it('should return original path when homeDir is undefined', () => {
                expect(resolveAbsolutePath('~', undefined)).toBe('~');
                expect(resolveAbsolutePath('~/Documents', undefined)).toBe('~/Documents');
            });

            it('should return original path when homeDir is empty', () => {
                expect(resolveAbsolutePath('~', '')).toBe('~');
                expect(resolveAbsolutePath('~/Documents', '')).toBe('~/Documents');
            });

            it('should handle homeDir with trailing separator', () => {
                expect(resolveAbsolutePath('~', '/Users/steve/')).toBe('/Users/steve');
                expect(resolveAbsolutePath('~/Documents', '/Users/steve/')).toBe('/Users/steve/Documents');
                expect(resolveAbsolutePath('~', 'C:\\Users\\steve\\')).toBe('C:\\Users\\steve');
                expect(resolveAbsolutePath('~/Documents', 'C:\\Users\\steve\\')).toBe('C:\\Users\\steve\\Documents');
            });

            it('should handle empty string path', () => {
                expect(resolveAbsolutePath('', '/Users/steve')).toBe('');
            });

            it('should handle paths with spaces', () => {
                expect(resolveAbsolutePath('~/My Documents', '/Users/steve')).toBe('/Users/steve/My Documents');
                expect(resolveAbsolutePath('~/Program Files/My App', 'C:\\Users\\steve')).toBe('C:\\Users\\steve\\Program Files/My App');
            });

            it('should handle paths with special characters', () => {
                expect(resolveAbsolutePath('~/Documents & Files', '/Users/steve')).toBe('/Users/steve/Documents & Files');
                expect(resolveAbsolutePath('~/folder@example.com', '/Users/steve')).toBe('/Users/steve/folder@example.com');
            });
        });

        describe('path separator normalization', () => {
            it('should use Unix separator for Unix home paths', () => {
                expect(resolveAbsolutePath('~/Documents/subfolder', '/home/user')).toBe('/home/user/Documents/subfolder');
                expect(resolveAbsolutePath('~/Documents/subfolder', '/Users/steve')).toBe('/Users/steve/Documents/subfolder');
            });

            it('should use Windows separator for Windows home paths', () => {
                expect(resolveAbsolutePath('~/Documents/subfolder', 'C:\\Users\\steve')).toBe('C:\\Users\\steve\\Documents/subfolder');
            });

            it('should handle mixed separators in home directory', () => {
                // Edge case: mixed separators in homeDir - should use the last separator type found
                expect(resolveAbsolutePath('~/Documents', 'C:/Users\\steve')).toBe('C:/Users\\steve\\Documents');
            });
        });

        describe('long paths', () => {
            it('should handle very long paths', () => {
                const longPath = '~/Documents/' + 'a'.repeat(200) + '/file.txt';
                const result = resolveAbsolutePath(longPath, '/Users/steve');
                expect(result).toBe('/Users/steve/Documents/' + 'a'.repeat(200) + '/file.txt');
            });

            it('should handle very long home directory paths', () => {
                const longHome = '/very/long/path/to/users/' + 'b'.repeat(100) + '/steve';
                expect(resolveAbsolutePath('~/Documents', longHome)).toBe(longHome + '/Documents');
            });
        });
    });

    describe('resolvePath (existing function)', () => {
        it('should return original path when metadata is null', () => {
            expect(resolvePath('/some/path', null)).toBe('/some/path');
        });

        it('should resolve path relative to metadata root', () => {
            const metadata = {
                path: '/Users/steve/project',
                host: 'localhost',
                homeDir: '/Users/steve'
            };
            expect(resolvePath('/Users/steve/project/src/file.ts', metadata)).toBe('src/file.ts');
        });

        it('should return <root> for exact metadata path', () => {
            const metadata = {
                path: '/Users/steve/project',
                host: 'localhost',
                homeDir: '/Users/steve'
            };
            expect(resolvePath('/Users/steve/project', metadata)).toBe('<root>');
        });

        it('should handle case insensitive matching', () => {
            const metadata = {
                path: '/Users/Steve/Project',
                host: 'localhost',
                homeDir: '/Users/Steve'
            };
            expect(resolvePath('/users/steve/project/src/file.ts', metadata)).toBe('src/file.ts');
        });

        it('should return original path if not under metadata path', () => {
            const metadata = {
                path: '/Users/steve/project',
                host: 'localhost',
                homeDir: '/Users/steve'
            };
            expect(resolvePath('/usr/local/bin/node', metadata)).toBe('/usr/local/bin/node');
        });

        it('should not resolve sibling directory paths that start with metadata path', () => {
            const metadata = {
                path: '/Users/steve/Develop/slopus/happy',
                host: 'localhost',
                homeDir: '/Users/steve'
            };
            // This should NOT be resolved as it's a sibling directory, not within the metadata path
            expect(resolvePath('/Users/steve/Develop/slopus/happy-server/sources/types/index.ts', metadata))
                .toBe('/Users/steve/Develop/slopus/happy-server/sources/types/index.ts');
        });

        it('should handle edge case where metadata path is a substring of another path', () => {
            const metadata = {
                path: '/home/user/app',
                host: 'localhost',
                homeDir: '/home/user'
            };
            // These should NOT be resolved
            expect(resolvePath('/home/user/app-v2/src/main.js', metadata))
                .toBe('/home/user/app-v2/src/main.js');
            expect(resolvePath('/home/user/application/config.json', metadata))
                .toBe('/home/user/application/config.json');
        });
    });

    describe('integration scenarios', () => {
        it('should work with typical macOS home directories', () => {
            const homeDir = '/Users/developer';
            expect(resolveAbsolutePath('~', homeDir)).toBe('/Users/developer');
            expect(resolveAbsolutePath('~/Projects/happy', homeDir)).toBe('/Users/developer/Projects/happy');
            expect(resolveAbsolutePath('~/Desktop/file.txt', homeDir)).toBe('/Users/developer/Desktop/file.txt');
        });

        it('should work with typical Linux home directories', () => {
            const homeDir = '/home/developer';
            expect(resolveAbsolutePath('~', homeDir)).toBe('/home/developer');
            expect(resolveAbsolutePath('~/projects/happy', homeDir)).toBe('/home/developer/projects/happy');
            expect(resolveAbsolutePath('~/documents/file.txt', homeDir)).toBe('/home/developer/documents/file.txt');
        });

        it('should work with typical Windows home directories', () => {
            const homeDir = 'C:\\Users\\developer';
            expect(resolveAbsolutePath('~', homeDir)).toBe('C:\\Users\\developer');
            expect(resolveAbsolutePath('~/Projects/happy', homeDir)).toBe('C:\\Users\\developer\\Projects/happy');
            expect(resolveAbsolutePath('~/Desktop/file.txt', homeDir)).toBe('C:\\Users\\developer\\Desktop/file.txt');
        });

        it('should handle common session creation scenarios', () => {
            // Scenarios that would commonly occur in new-session.tsx
            const macHomeDir = '/Users/steve';
            
            expect(resolveAbsolutePath('~', macHomeDir)).toBe('/Users/steve');
            expect(resolveAbsolutePath('~/Code', macHomeDir)).toBe('/Users/steve/Code');
            expect(resolveAbsolutePath('~/Documents/Projects', macHomeDir)).toBe('/Users/steve/Documents/Projects');
            expect(resolveAbsolutePath('/absolute/path', macHomeDir)).toBe('/absolute/path');
            expect(resolveAbsolutePath('./relative', macHomeDir)).toBe('./relative');
        });
    });
});