/**
 * `Location` 응답 헤더 rewriter — specs/preview-relay-escape-plug Phase A.
 *
 * dev server 가 `Location: /admin` 같은 absolute path 로 redirect 응답
 * 시, 그대로 두면 브라우저가 iframe 의 현재 origin (relay host) 기준
 * 으로 follow → `<relay>/admin` 으로 escape. relay 가 preview prefix 를
 * 부착해 redirect 가 동일 prefix 안에 머물도록 보장.
 *
 * 처리 규칙:
 *   - absolute path (`/foo`)            → prefix 부착
 *   - 이미 prefix 시작                  → idempotent (그대로)
 *   - 상대 경로 (`foo`, `./foo`, `..`)  → 그대로 (브라우저가 현재 URL 기준 해석)
 *   - dev self URL (`http://0.0.0.0:3000/foo`) → preview path 로 정규화
 *   - protocol-relative (`//host/...`)  → 외부 host 는 그대로 (cross-origin 의도)
 *   - absolute URL (`http(s)://...`)    → 외부 host 는 그대로 (cross-origin 의도)
 *   - 빈 값 / prefix 빈 값              → 그대로 (graceful)
 */
export function rewriteLocationHeader(value: string, prefix: string): string {
    if (!value) return value;

    const localPath = pathFromDevServerSelfUrl(value);
    if (localPath !== null) return prefix ? prefix + localPath : localPath;

    // absolute URL or protocol-relative — 외부 cross-origin 의도
    if (value.startsWith('//') || /^https?:\/\//i.test(value)) return value;
    if (!prefix) return value;
    // not an absolute path — 상대 경로
    if (!value.startsWith('/')) return value;
    // idempotent — 이미 prefix 로 시작 (정확히 prefix 와 같거나 그 다음이 `/` 또는 끝)
    if (value === prefix || value.startsWith(prefix + '/')) return value;
    return prefix + value;
}

function pathFromDevServerSelfUrl(value: string): string | null {
    try {
        const url = value.startsWith('//')
            ? new URL(`http:${value}`)
            : new URL(value);
        if (!isDevServerSelfHost(url.hostname)) return null;
        return `${url.pathname || '/'}${url.search}${url.hash}`;
    } catch {
        return null;
    }
}

function isDevServerSelfHost(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return normalized === 'localhost' ||
        normalized === '0.0.0.0' ||
        normalized === '127.0.0.1' ||
        normalized === '::1' ||
        normalized === '[::1]';
}
