/**
 * Pure utility functions for resolving markdown links to in-app file viewer routes.
 */

export function encodeFilePathForRoute(filePath: string): string {
    const bytes = new TextEncoder().encode(filePath);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export function parsePositiveInt(value?: string): number | undefined {
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseLineAndColumn(source?: string): { line?: number; column?: number } {
    if (!source) return {};
    const trimmed = source.trim();
    const lMatch = /^L(\d+)(?:C(\d+))?$/i.exec(trimmed);
    if (lMatch) {
        return {
            line: parsePositiveInt(lMatch[1]),
            column: parsePositiveInt(lMatch[2]),
        };
    }
    const simpleMatch = /^(\d+)(?::(\d+))?$/.exec(trimmed);
    if (simpleMatch) {
        return {
            line: parsePositiveInt(simpleMatch[1]),
            column: parsePositiveInt(simpleMatch[2]),
        };
    }
    return {};
}

export function parseLocalFileReference(rawUrl: string): { filePath: string; line?: number; column?: number } {
    let url = rawUrl.trim();

    if (url.toLowerCase().startsWith('file://')) {
        url = url.slice('file://'.length);
    }

    let hash = '';
    const hashIndex = url.indexOf('#');
    if (hashIndex >= 0) {
        hash = url.slice(hashIndex + 1);
        url = url.slice(0, hashIndex);
    }

    let filePath = url;
    let line: number | undefined;
    let column: number | undefined;

    const fromHash = parseLineAndColumn(hash);
    line = fromHash.line;
    column = fromHash.column;

    if (!line) {
        const withLineMatch = /^(.*):(\d+)(?::(\d+))?$/.exec(filePath);
        if (withLineMatch && !filePath.includes('://')) {
            filePath = withLineMatch[1];
            line = parsePositiveInt(withLineMatch[2]);
            column = parsePositiveInt(withLineMatch[3]);
        }
    }

    try {
        filePath = decodeURIComponent(filePath);
    } catch {
        // Keep raw path when decode fails.
    }

    return { filePath, line, column };
}

export function isLikelyRelativeFilePath(path: string): boolean {
    if (!path || path.startsWith('/') || path.startsWith('#')) return false;
    if (path.includes('://')) return false;
    if (path.startsWith('./') || path.startsWith('../')) return true;
    return path.includes('/');
}

export function normalizeDirectoryPath(path?: string | null): string | null {
    if (!path) return null;
    const trimmed = path.trim();
    if (!trimmed.startsWith('/')) return null;
    if (trimmed === '/') return '/';
    return trimmed.replace(/\/+$/, '');
}

export function isPathInsideDirectory(path: string, directory?: string | null): boolean {
    const normalizedDir = normalizeDirectoryPath(directory);
    if (!normalizedDir) return false;
    if (normalizedDir === '/') return path.startsWith('/');
    return path === normalizedDir || path.startsWith(`${normalizedDir}/`);
}

export function isLikelyAbsoluteFilePath(path: string, context: {
    sessionWorkingDirectory?: string | null;
    sessionHomeDirectory?: string | null;
}): boolean {
    if (!path.startsWith('/')) return false;
    if (path.startsWith('//')) return false;
    if (isPathInsideDirectory(path, context.sessionWorkingDirectory)) return true;
    if (isPathInsideDirectory(path, context.sessionHomeDirectory)) return true;
    return false;
}

export function joinPosixPath(basePath: string, relativePath: string): string {
    const baseParts = basePath.split('/').filter(Boolean);
    const relativeParts = relativePath.split('/');
    const combined = [...baseParts];

    for (const part of relativeParts) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (combined.length > 0) {
                combined.pop();
            }
            continue;
        }
        combined.push(part);
    }

    return `/${combined.join('/')}`;
}

export function buildSessionFileHref(args: {
    sessionId: string;
    filePath: string;
    line?: number;
    column?: number;
}): string {
    const encodedPath = encodeURIComponent(encodeFilePathForRoute(args.filePath));
    const queryParams = [`path=${encodedPath}`, 'view=file'];
    if (args.line) queryParams.push(`line=${args.line}`);
    if (args.column) queryParams.push(`column=${args.column}`);
    return `/session/${args.sessionId}/file?${queryParams.join('&')}`;
}

export function resolveMarkdownLink(args: {
    rawUrl: string;
    sessionId?: string;
    sessionWorkingDirectory?: string | null;
    sessionHomeDirectory?: string | null;
}): { href: string; target?: '_blank' } {
    const trimmed = args.rawUrl.trim();
    if (!trimmed) {
        return { href: args.rawUrl };
    }

    const isHttpLike = /^(https?:|mailto:|tel:)/i.test(trimmed);
    if (isHttpLike) {
        return { href: trimmed, target: '_blank' };
    }

    if (trimmed.startsWith('/')) {
        if (args.sessionId) {
            const parsed = parseLocalFileReference(trimmed);
            if (isLikelyAbsoluteFilePath(parsed.filePath, {
                sessionWorkingDirectory: args.sessionWorkingDirectory,
                sessionHomeDirectory: args.sessionHomeDirectory,
            })) {
                return {
                    href: buildSessionFileHref({
                        sessionId: args.sessionId,
                        filePath: parsed.filePath,
                        line: parsed.line,
                        column: parsed.column,
                    }),
                };
            }
        }
        return { href: trimmed };
    }

    if (args.sessionId && args.sessionWorkingDirectory && isLikelyRelativeFilePath(trimmed)) {
        const parsed = parseLocalFileReference(trimmed);
        const absolutePath = joinPosixPath(args.sessionWorkingDirectory, parsed.filePath);
        return {
            href: buildSessionFileHref({
                sessionId: args.sessionId,
                filePath: absolutePath,
                line: parsed.line,
                column: parsed.column,
            }),
        };
    }

    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
        return { href: trimmed, target: '_blank' };
    }

    return { href: trimmed };
}
