/**
 * Aplus auto-mcp-config fetcher — specs/20260525-company-mcp-server P6(b).
 *
 * 부트 시 web-ui (`/api/me/mcp-config`) 에 happyToken 으로 GET → 응답의
 * `mcpServers` 를 그대로 각 agent runner 의 mcpServers 에 머지한다.
 *
 * 동작 정책:
 *  - `HAPPY_APLUS_MCP_CONFIG_URL` 가 설정돼 있을 때만 시도 — 미설정이면 no-op.
 *  - 실패해도 throw 하지 않는다 (graceful degrade). MCP 가 없을 뿐 세션은 정상.
 *  - 타임아웃 3 초 (사용자 부트 체감 지연 최소화).
 */

import { logger } from '@/ui/logger'

type McpHttpServerEntry = {
    type: 'http'
    url: string
    headers?: Record<string, string>
}

export type AplusMcpServersMap = Record<string, McpHttpServerEntry>

const TIMEOUT_MS = 3000

export async function fetchAplusMcpServers(token: string, machineId: string): Promise<AplusMcpServersMap> {
    const configUrl = process.env.HAPPY_APLUS_MCP_CONFIG_URL
    if (!configUrl) {
        logger.debug('[aplus] HAPPY_APLUS_MCP_CONFIG_URL 미설정 — aplus MCP 자동등록 skip')
        return {}
    }
    if (!machineId) {
        logger.debug('[aplus] machineId 없음 — aplus MCP 자동등록 skip')
        return {}
    }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    try {
        const res = await fetch(configUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Aplus-Machine-Id': machineId,
            },
            signal: ctl.signal,
        })
        if (!res.ok) {
            logger.debug(`[aplus] mcp-config 응답 ${res.status} — skip`)
            return {}
        }
        const body = (await res.json()) as { mcpServers?: AplusMcpServersMap }
        if (!body?.mcpServers || typeof body.mcpServers !== 'object') {
            logger.debug('[aplus] mcp-config 응답에 mcpServers 없음 — skip')
            return {}
        }
        const keys = Object.keys(body.mcpServers)
        logger.debug(`[aplus] mcp-config 받음 — 등록: ${keys.join(', ')}`)
        return body.mcpServers
    } catch (e) {
        logger.debug(`[aplus] mcp-config fetch 실패 — skip: ${(e as Error).message}`)
        return {}
    } finally {
        clearTimeout(timer)
    }
}
