export type SessionFileLink = {
    path: string;
    absolutePath: string;
    relativePath: string | null;
    withinSessionRoot: boolean;
    line: number | null;
    column: number | null;
};

export type SessionFileTextSegment = {
    text: string;
    link: SessionFileLink | null;
};

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;
const POSIX_ABSOLUTE_PATH = /^\//;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const FILE_URL_PREFIX = /^file:\/\//i;
const RELATIVE_PREFIX = /^(?:\.{1,2}[\\/]|~[\\/])/;
const HAS_PATH_SEPARATOR = /[\\/]/;
const BARE_FILE_NAME = /^[^\\/\s]+\.[^\\/\s]+$/;
const NUMERIC_EXTENSION = /^\d+$/;
const FILE_EXTENSION = /^[A-Za-z0-9_-]{1,16}$/;
const EXTENSIONLESS_FILE_NAMES = new Set([
    'README',
    'LICENSE',
    'Makefile',
    'Dockerfile',
    '.gitignore',
    '.gitattributes',
    '.env',
    '.npmrc',
    '.yarnrc',
]);
const LEADING_WRAP = /^[([{<"'`]+/;
const TRAILING_WRAP = /[)\]}>",;!?`]+$/;
const APP_ROUTE_PREFIXES = ['/session/', '/text-selection', '/settings', '/auth'];

function parseLineAndColumn(value: string): { path: string; line: number | null; column: number | null } {
    const trimmed = value.trim();
    const lineColumnMatch = trimmed.match(/^(.*):(\d+):(\d+)$/);
    if (lineColumnMatch) {
        return {
            path: lineColumnMatch[1],
            line: Number.parseInt(lineColumnMatch[2], 10),
            column: Number.parseInt(lineColumnMatch[3], 10),
        };
    }

    const lineMatch = trimmed.match(/^(.*):(\d+)$/);
    if (!lineMatch) {
        return {
            path: trimmed,
            line: null,
            column: null,
        };
    }

    return {
        path: lineMatch[1],
        line: Number.parseInt(lineMatch[2], 10),
        column: null,
    };
}

function pushTextSegment(segments: SessionFileTextSegment[], text: string) {
    if (!text) {
        return;
    }
    const last = segments[segments.length - 1];
    if (last && last.link === null) {
        last.text += text;
        return;
    }
    segments.push({ text, link: null });
}

function stripToken(value: string): { leading: string; core: string; trailing: string } {
    const leading = value.match(LEADING_WRAP)?.[0] ?? '';
    const withoutLeading = leading ? value.slice(leading.length) : value;
    const trailing = withoutLeading.match(TRAILING_WRAP)?.[0] ?? '';
    const core = trailing ? withoutLeading.slice(0, withoutLeading.length - trailing.length) : withoutLeading;
    return { leading, core, trailing };
}

function decodeFileUrl(value: string): string {
    if (!FILE_URL_PREFIX.test(value)) {
        return value;
    }
    const stripped = value.replace(FILE_URL_PREFIX, '');
    const normalized = stripped.startsWith('/') ? stripped : `/${stripped}`;
    try {
        return decodeURIComponent(normalized);
    } catch {
        return normalized;
    }
}

function inferHomeDirectory(sessionRoot: string | null | undefined): string | null {
    if (!sessionRoot) {
        return null;
    }
    const normalizedRoot = normalizePath(sessionRoot);
    const match = normalizedRoot.match(/^([A-Za-z]:\/Users\/[^/]+|\/Users\/[^/]+|\/home\/[^/]+)/);
    return match?.[1] ?? null;
}

function expandHomePath(value: string, sessionRoot: string | null | undefined): string {
    if (!value.startsWith('~/')) {
        return value;
    }
    const home = inferHomeDirectory(sessionRoot);
    if (!home) {
        return value;
    }
    return `${home}/${value.slice(2)}`;
}

function normalizePath(value: string): string {
    const withForwardSlashes = value.replace(/\\/g, '/');
    const isWindowsAbsolute = /^[A-Za-z]:\//.test(withForwardSlashes);
    const isPosixAbsolute = withForwardSlashes.startsWith('/');
    const prefix = isWindowsAbsolute ? `${withForwardSlashes.slice(0, 2)}/` : isPosixAbsolute ? '/' : '';
    const rawRemainder = isWindowsAbsolute ? withForwardSlashes.slice(3) : isPosixAbsolute ? withForwardSlashes.replace(/^\/+/, '') : withForwardSlashes;

    const parts = rawRemainder.split('/');
    const normalizedParts: string[] = [];

    for (const part of parts) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            if (normalizedParts.length > 0 && normalizedParts[normalizedParts.length - 1] !== '..') {
                normalizedParts.pop();
            } else if (!prefix) {
                normalizedParts.push(part);
            }
            continue;
        }
        normalizedParts.push(part);
    }

    if (!prefix) {
        return normalizedParts.join('/');
    }
    if (normalizedParts.length === 0) {
        return prefix;
    }
    return `${prefix}${normalizedParts.join('/')}`;
}

function resolvePath(path: string, sessionRoot: string | null | undefined): string | null {
    const expandedPath = expandHomePath(decodeFileUrl(path), sessionRoot);
    if (!expandedPath) {
        return null;
    }
    if (WINDOWS_ABSOLUTE_PATH.test(expandedPath) || POSIX_ABSOLUTE_PATH.test(expandedPath)) {
        return normalizePath(expandedPath);
    }
    if (!sessionRoot) {
        return null;
    }
    return normalizePath(`${normalizePath(sessionRoot)}/${expandedPath}`);
}

function isWithinRoot(path: string, root: string | null | undefined): boolean {
    if (!root) {
        return false;
    }
    const normalizedPath = normalizePath(path);
    const normalizedRoot = normalizePath(root);
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function getRelativePath(path: string, root: string | null | undefined): string | null {
    if (!isWithinRoot(path, root) || !root) {
        return null;
    }
    const normalizedPath = normalizePath(path);
    const normalizedRoot = normalizePath(root);
    if (normalizedPath === normalizedRoot) {
        return '.';
    }
    return normalizedPath.slice(normalizedRoot.length + 1);
}

function looksLikeBareFileName(value: string): boolean {
    if (!BARE_FILE_NAME.test(value)) {
        return false;
    }
    const extension = value.split('.').pop() ?? '';
    return !NUMERIC_EXTENSION.test(extension);
}

function hasFileLikeEnding(value: string): boolean {
    const normalized = normalizePath(value);
    const basename = normalized.split('/').pop() ?? normalized;
    if (!basename) {
        return false;
    }
    if (EXTENSIONLESS_FILE_NAMES.has(basename)) {
        return true;
    }
    if (basename.startsWith('.')) {
        return basename.length > 1;
    }
    const lastDotIndex = basename.lastIndexOf('.');
    if (lastDotIndex <= 0 || lastDotIndex === basename.length - 1) {
        return false;
    }
    const extension = basename.slice(lastDotIndex + 1);
    if (!FILE_EXTENSION.test(extension)) {
        return false;
    }
    return !NUMERIC_EXTENSION.test(extension);
}

function isAppRoute(value: string): boolean {
    return APP_ROUTE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function looksLikePath(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) {
        return false;
    }
    if (WINDOWS_ABSOLUTE_PATH.test(trimmed)) {
        return true;
    }
    if (POSIX_ABSOLUTE_PATH.test(trimmed)) {
        return !isAppRoute(trimmed);
    }
    if (RELATIVE_PREFIX.test(trimmed)) {
        return true;
    }
    if (HAS_PATH_SEPARATOR.test(trimmed)) {
        return true;
    }
    return looksLikeBareFileName(trimmed);
}

function buildLink(path: string, line: number | null, column: number | null, sessionRoot: string | null | undefined): SessionFileLink | null {
    const absolutePath = resolvePath(path, sessionRoot);
    if (!absolutePath) {
        return null;
    }
    return {
        path: normalizePath(path),
        absolutePath,
        relativePath: getRelativePath(absolutePath, sessionRoot),
        withinSessionRoot: isWithinRoot(absolutePath, sessionRoot),
        line,
        column,
    };
}

export function resolveSessionFilePath(path: string, sessionRoot?: string | null): SessionFileLink | null {
    const parsed = parseLineAndColumn(path);
    return buildLink(parsed.path, parsed.line, parsed.column, sessionRoot);
}

export function parseSessionFileLink(
    url: string,
    options?: { label?: string | null; sessionRoot?: string | null; bareText?: boolean }
): SessionFileLink | null {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
        return null;
    }

    if (!WINDOWS_ABSOLUTE_PATH.test(trimmedUrl) && URL_SCHEME.test(trimmedUrl)) {
        return null;
    }

    const parsedUrl = parseLineAndColumn(trimmedUrl);
    const parsedLabel = options?.label ? parseLineAndColumn(options.label) : null;

    if (!looksLikePath(parsedUrl.path) && !looksLikePath(parsedLabel?.path ?? '')) {
        return null;
    }

    if (options?.bareText) {
        const hasStrongSignal =
            parsedUrl.line !== null ||
            parsedUrl.column !== null ||
            hasFileLikeEnding(parsedUrl.path);
        if (!hasStrongSignal) {
            return null;
        }
    }

    return buildLink(
        parsedUrl.path,
        parsedUrl.line ?? parsedLabel?.line ?? null,
        parsedUrl.column ?? parsedLabel?.column ?? null,
        options?.sessionRoot,
    );
}

type TokenMatch = {
    start: number;
    end: number;
};

function looksLikePathStart(text: string): boolean {
    if (!text) {
        return false;
    }
    if (WINDOWS_ABSOLUTE_PATH.test(text)) {
        return true;
    }
    if (text.startsWith('/') || text.startsWith('~/') || text.startsWith('./') || text.startsWith('../')) {
        return true;
    }
    return HAS_PATH_SEPARATOR.test(text);
}

export function splitSessionFileText(text: string, sessionRoot?: string | null): SessionFileTextSegment[] {
    const segments: SessionFileTextSegment[] = [];
    const tokenPattern = /\S+/g;
    const tokens: TokenMatch[] = [];
    let match: RegExpExecArray | null;

    while ((match = tokenPattern.exec(text)) !== null) {
        tokens.push({ start: match.index, end: match.index + match[0].length });
    }

    let cursor = 0;
    let tokenIndex = 0;

    while (tokenIndex < tokens.length) {
        const token = tokens[tokenIndex];
        const tokenText = text.slice(token.start, token.end);
        const strippedStart = stripToken(tokenText).core;

        if (!looksLikePathStart(strippedStart)) {
            tokenIndex += 1;
            continue;
        }

        let bestEnd = -1;
        let bestLink: SessionFileLink | null = null;
        let bestLeading = '';
        let bestCore = '';
        let bestTrailing = '';

        for (let candidateIndex = tokenIndex; candidateIndex < tokens.length; candidateIndex += 1) {
            const candidate = text.slice(token.start, tokens[candidateIndex].end);
            const stripped = stripToken(candidate);
            if (!stripped.core) {
                continue;
            }

            const link = parseSessionFileLink(stripped.core, {
                sessionRoot,
                bareText: true,
            });

            if (link) {
                bestEnd = candidateIndex;
                bestLink = link;
                bestLeading = stripped.leading;
                bestCore = stripped.core;
                bestTrailing = stripped.trailing;
            }
        }

        if (bestEnd === -1 || !bestLink) {
            tokenIndex += 1;
            continue;
        }

        const end = tokens[bestEnd].end;
        pushTextSegment(segments, text.slice(cursor, token.start));
        pushTextSegment(segments, bestLeading);
        segments.push({ text: bestCore, link: bestLink });
        pushTextSegment(segments, bestTrailing);
        cursor = end;
        tokenIndex = bestEnd + 1;
    }

    if (cursor < text.length) {
        pushTextSegment(segments, text.slice(cursor));
    }

    return segments;
}
