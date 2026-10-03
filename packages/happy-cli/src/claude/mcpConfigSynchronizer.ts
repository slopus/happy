import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { McpRuntimeServerStatus } from '@slopus/happy-wire';
import type { AplusMcpServersFetchResult, AplusMcpServersMap } from '@/aplus/fetchAplusMcpServers';
import { deepEqual } from '@/utils/deterministicJson';
import { sanitizeMcpError } from './mcpRuntimeRecovery';
import { logger } from '@/ui/logger';

type McpConfigControl = Pick<Query, 'setMcpServers'>;

export type McpConfigMeasure = <T>(stage: 'mcp-grant' | 'mcp-fetch' | 'mcp-compare' | 'mcp-apply', action: () => T | Promise<T>) => Promise<T>;

export type McpConfigSource = {
    baseServers: Record<string, any>;
    initialAplusServers: AplusMcpServersMap;
    /**
     * 대화를 열 때 있던 조직 등록 MCP 의 이름. 이 세션 동안 설정에서 사라져도
     * 제거하지 않는다 — 조직 등록 MCP 는 외부 URL 직접 호출이라 조직이 사용을
     * 중단해도 호출 자체는 계속 되고, 중단은 다음 대화부터 적용하는 편이 낫다.
     *
     * 커넥터는 넣지 않는다. 사용 중단된 커넥터는 게이트웨이가 거부하므로
     * 유지해봐야 죽은 툴만 남는다.
     */
    floorServerNames?: string[];
    fetchAplusServers: (measure?: McpConfigMeasure) => Promise<AplusMcpServersFetchResult>;
    onApplied?: (servers: Record<string, any>, aplusServers: AplusMcpServersMap) => void;
};

type McpConfigSynchronizerOptions = McpConfigSource & {
    now?: () => number;
    onStatus?: (status: McpRuntimeServerStatus) => void;
};

export class McpConfigSynchronizer {
    private currentAplusServers: AplusMcpServersMap;
    private readonly floorServers: AplusMcpServersMap;
    private readonly now: () => number;

    constructor(
        private readonly query: McpConfigControl,
        private readonly options: McpConfigSynchronizerOptions,
    ) {
        this.currentAplusServers = options.initialAplusServers;
        this.floorServers = Object.fromEntries(
            (options.floorServerNames ?? [])
                .filter((name) => options.initialAplusServers[name])
                .map((name) => [name, options.initialAplusServers[name]]),
        );
        this.now = options.now ?? Date.now;
    }

    /**
     * 바닥선을 조기 반환이 아니라 합집합으로 지킨다. 새 설정을 그대로 적용하되
     * 빠진 바닥선 항목만 되살린다 — 조기 반환하면 커넥터 capability 토큰 갱신
     * 같은 다른 변경까지 함께 멈춘다.
     */
    private withFloor(servers: AplusMcpServersMap): AplusMcpServersMap {
        const out = { ...servers };
        for (const [name, entry] of Object.entries(this.floorServers)) {
            if (!out[name]) out[name] = entry;
        }
        return out;
    }

    async sync(measure?: McpConfigMeasure): Promise<void> {
        let result: AplusMcpServersFetchResult;
        try {
            result = await this.options.fetchAplusServers(measure);
        } catch (error) {
            this.emitConfigFailure(sanitizeMcpError(error));
            return;
        }
        if (!result.ok) {
            if (result.reason === 'not-configured' || result.reason === 'missing-machine-id') {
                return;
            }
            if (result.reason === 'connector-config-missing') {
                for (const provider of result.missing) {
                    this.options.onStatus?.({
                        name: provider,
                        status: 'connector-config-missing',
                        error: sanitizeMcpError(result.error),
                        checkedAt: this.now(),
                    });
                }
                return;
            }
            if (result.reason === 'mcp-config-missing') {
                for (const { name, reason } of result.missing) {
                    this.options.onStatus?.({
                        name,
                        status: reason === 'connector-config-missing'
                            ? 'connector-config-missing'
                            : 'mcp-config-missing',
                        error: sanitizeMcpError(result.error),
                        checkedAt: this.now(),
                    });
                }
                return;
            }
            this.emitConfigFailure(result.error);
            return;
        }
        const aplusServers = this.withFloor(result.servers);
        const equal = measure ? await measure('mcp-compare', () => deepEqual(this.currentAplusServers, aplusServers)) : deepEqual(this.currentAplusServers, aplusServers);
        if (equal) {
            return;
        }

        const servers = { ...this.options.baseServers, ...aplusServers };
        try {
            const applied = await (measure ? measure('mcp-apply', () => this.query.setMcpServers(servers)) : this.query.setMcpServers(servers));
            this.currentAplusServers = aplusServers;
            this.options.onApplied?.(servers, aplusServers);
            const added = [...applied.added].sort().join(',') || '(none)';
            const removed = [...applied.removed].sort().join(',') || '(none)';
            logger.debug(`[MCP CONFIG] Applied server changes added=${added} removed=${removed}`);
            for (const [name, error] of Object.entries(applied.errors)) {
                this.options.onStatus?.({
                    name,
                    status: 'failed',
                    error: sanitizeMcpError(error),
                    checkedAt: this.now(),
                });
            }
        } catch (error) {
            this.emitConfigFailure(sanitizeMcpError(error));
        }
    }

    private emitConfigFailure(error: string): void {
        this.options.onStatus?.({
            name: 'aplus-config',
            status: 'config-fetch-failed',
            error: sanitizeMcpError(error),
            checkedAt: this.now(),
        });
    }
}
