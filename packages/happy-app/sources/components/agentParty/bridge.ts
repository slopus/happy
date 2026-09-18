import { parseAccountSessionTarget } from '@/auth/accountLink';
import { canonicalAccountServer } from '@/auth/accountRuntime';
export const AGENT_PARTY_ORIGIN = 'https://47.115.228.20:8443';
export const AGENT_PARTY_URL = `${AGENT_PARTY_ORIGIN}/agent-party/`;
export const AGENT_PARTY_RELAY = AGENT_PARTY_ORIGIN;
export function parsePartySessionMessage(value: unknown, accountId: string, serverUrl: string): string | null {
    if (!value || typeof value !== 'object' || (value as { type?: unknown }).type !== 'agent-party-session') return null;
    const target = parseAccountSessionTarget(value as Record<string, unknown>);
    if (!target || target.accountId !== accountId || target.serverUrl !== canonicalAccountServer(serverUrl)) return null;
    return target.sessionId;
}
export function partyFrameUrl(ticket: string, agents: boolean): string {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error('群聊连接信息无效');
    return `${AGENT_PARTY_URL}${agents ? '?view=agents' : ''}#ticket=${ticket}`;
}
export type PartySurfaceProps = { url: string; onMessage(value: unknown): void; onError(): void };
