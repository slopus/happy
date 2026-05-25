/**
 * Redact gate — specs/20260525-company-mcp-server P5.
 *
 * 목적: 특정 tool 의 tool_result content 를 표시/로그/모바일 미러링 채널에서만
 * `[redacted by policy]` 로 치환. 모델 SDK 에 흘러가는 원본은 절대 건드리지 않는다.
 *
 * 동작 원리:
 *  - SDK 의 tool_result 메시지에는 tool name 이 없고 `tool_use_id` 만 있다.
 *  - 따라서 이전에 본 `tool_use` 블록의 (id → name) 매핑을 모아두고,
 *    tool_result 시점에 lookup → 정책 매칭이면 치환.
 *
 * 매칭 룰 (`shouldRedact`):
 *  - HAPPY_REDACT_MCP_PREFIXES (콤마 구분) 의 prefix 중 하나로 시작하면 redact.
 *  - HAPPY_REDACT_TOOLS (콤마 구분) 에 정확히 일치하면 redact.
 *
 * 기본값:
 *  - prefixes: "mcp__aplus-common__,mcp__aplus-company__"
 *  - tools:    "Skill"     (Claude built-in Skill 도구도 같은 표면에 노출됨)
 *
 * 비활성화:
 *  - 환경변수 빈 문자열로 두면 해당 매칭 그룹은 꺼짐.
 */

// 진단 로그 재활성화 시 주석 해제
// import { logger } from '@/ui/logger'

export const REDACTED_PLACEHOLDER = '[redacted by policy]'

const DEFAULT_PREFIXES = 'mcp__aplus-common__,mcp__aplus-company__'
const DEFAULT_TOOLS = 'Skill'

function parseList(env: string | undefined, fallback: string): string[] {
    const src = env === undefined ? fallback : env
    return src.split(',').map(s => s.trim()).filter(Boolean)
}

// 1회 캐시 — 프로세스 부트 후 env 변경 가능성 낮음. 테스트에서 reset 필요하면
// `resetRedactConfig()` 호출.
let prefixesCache: string[] | null = null
let toolsCache: string[] | null = null

function getPrefixes(): string[] {
    if (prefixesCache === null) {
        prefixesCache = parseList(process.env.HAPPY_REDACT_MCP_PREFIXES, DEFAULT_PREFIXES)
    }
    return prefixesCache
}

function getTools(): string[] {
    if (toolsCache === null) {
        toolsCache = parseList(process.env.HAPPY_REDACT_TOOLS, DEFAULT_TOOLS)
    }
    return toolsCache
}

export function resetRedactConfig(): void {
    prefixesCache = null
    toolsCache = null
}

export function shouldRedact(toolName: string | undefined): boolean {
    if (!toolName) return false
    const prefixes = getPrefixes()
    for (const p of prefixes) {
        if (toolName.startsWith(p)) return true
    }
    const tools = getTools()
    return tools.includes(toolName)
}

// (id → name) 매핑은 프로세스 전체에 하나만 둔다. happy-cli 는 1 프로세스 1
// Claude 세션 모델이므로 충분. 메모리 누수 방지 차원에서 상한을 두진 않았고,
// 한 세션이 수십만 tool_use 를 만들지 않는다는 가정.
const toolUseIdToName = new Map<string, string>()

export function recordToolUse(id: string | undefined, name: string | undefined): void {
    if (!id || !name) return
    toolUseIdToName.set(id, name)
    // 진단용 — redact 동작 확인 시 주석 해제 (specs/20260525-company-mcp-server P5 검증)
    // logger.debug(`[redact] recordToolUse id=${id} name=${name} match=${shouldRedact(name)}`)
}

export function getToolNameById(id: string | undefined): string | undefined {
    if (!id) return undefined
    return toolUseIdToName.get(id)
}

export function resetToolUseMap(): void {
    toolUseIdToName.clear()
}

/**
 * 표시/로그 surface 에서 tool_result content 본문을 치환할 때 사용.
 * content 는 string 일 수도, content-block 배열일 수도 있어 둘 다 처리.
 * 입력 객체는 그대로 두고 새 값을 반환 (immutability — 모델 컨텍스트 보호).
 */
export function redactToolResultContent(content: unknown): unknown {
    // 진단용 — redact 동작 확인 시 주석 해제 (specs/20260525-company-mcp-server P5 검증)
    // logger.debug(`[redact] redactToolResultContent fired (contentType=${typeof content}${Array.isArray(content) ? '[]' : ''})`)
    if (typeof content === 'string') return REDACTED_PLACEHOLDER
    if (Array.isArray(content)) {
        return content.map(block => {
            if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
                return { ...block, text: REDACTED_PLACEHOLDER }
            }
            // image / 기타 블록은 본문이 텍스트가 아니므로 placeholder 텍스트 블록으로 단일 교체
            return { type: 'text', text: REDACTED_PLACEHOLDER }
        })
    }
    return REDACTED_PLACEHOLDER
}
