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
 *   - protocol-relative (`//host/...`)  → 그대로 (cross-origin 의도)
 *   - absolute URL (`http(s)://...`)    → 그대로 (cross-origin 의도)
 *   - 빈 값 / prefix 빈 값              → 그대로 (graceful)
 */
export function rewriteLocationHeader(value: string, prefix: string): string {
    if (!value || !prefix) return value;
    // absolute URL or protocol-relative — cross-origin 의도
    if (value.startsWith('//') || /^https?:\/\//i.test(value)) return value;
    // not an absolute path — 상대 경로
    if (!value.startsWith('/')) return value;
    // idempotent — 이미 prefix 로 시작 (정확히 prefix 와 같거나 그 다음이 `/` 또는 끝)
    if (value === prefix || value.startsWith(prefix + '/')) return value;
    return prefix + value;
}
