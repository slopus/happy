import type { CapabilitiesDetectRequest, CapabilityDetectResult, CapabilityId, CodexMcpResumeDepData } from '@/sync/capabilitiesProtocol';
import { compareVersions, parseVersion } from '@/utils/versionUtils';

export const CODEX_MCP_RESUME_DEP_ID = 'dep.codex-mcp-resume' as const satisfies CapabilityId;
export const CODEX_MCP_RESUME_DIST_TAG = 'happy-codex-resume' as const;

export function getCodexMcpResumeDetectResult(
    results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined,
): CapabilityDetectResult | null {
    const res = results?.[CODEX_MCP_RESUME_DEP_ID];
    return res ? res : null;
}

export function getCodexMcpResumeDepData(
    results: Partial<Record<CapabilityId, CapabilityDetectResult>> | null | undefined,
): CodexMcpResumeDepData | null {
    const result = getCodexMcpResumeDetectResult(results);
    if (!result || result.ok !== true) return null;
    const data = result.data as any;
    return data && typeof data === 'object' ? (data as CodexMcpResumeDepData) : null;
}

export function getCodexMcpResumeLatestVersion(data: CodexMcpResumeDepData | null | undefined): string | null {
    const registry = data?.registry;
    if (!registry || typeof registry !== 'object') return null;
    if ((registry as any).ok !== true) return null;
    const latest = (registry as any).latestVersion;
    return typeof latest === 'string' ? latest : null;
}

export function getCodexMcpResumeRegistryError(data: CodexMcpResumeDepData | null | undefined): string | null {
    const registry = data?.registry;
    if (!registry || typeof registry !== 'object') return null;
    if ((registry as any).ok !== false) return null;
    const msg = (registry as any).errorMessage;
    return typeof msg === 'string' ? msg : null;
}

export function isCodexMcpResumeUpdateAvailable(data: CodexMcpResumeDepData | null | undefined): boolean {
    if (data?.installed !== true) return false;
    const installed = typeof data.installedVersion === 'string' ? data.installedVersion : null;
    const latest = getCodexMcpResumeLatestVersion(data);
    if (!installed || !latest) return false;
    const installedParsed = parseVersion(installed);
    const latestParsed = parseVersion(latest);
    if (!installedParsed || !latestParsed) return false;
    return compareVersions(installed, latest) < 0;
}

export function shouldPrefetchCodexMcpResumeRegistry(params: {
    result?: CapabilityDetectResult | null;
    data?: CodexMcpResumeDepData | null;
    requireExistingResult?: boolean;
}): boolean {
    const OK_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours
    const ERROR_RETRY_MS = 30 * 60 * 1000; // 30 minutes

    const now = Date.now();
    const requireExistingResult = params.requireExistingResult === true;
    const result = params.result ?? null;
    const data = params.data ?? null;

    if (!result || result.ok !== true) {
        return requireExistingResult ? false : true;
    }

    if (!data || data.installed !== true) {
        return requireExistingResult ? false : true;
    }

    const checkedAt = typeof result.checkedAt === 'number' ? result.checkedAt : 0;
    const hasRegistry = Boolean((data as any).registry);

    if (!hasRegistry) return true;
    if (checkedAt <= 0) return true;

    const ok = (data as any).registry?.ok === true;
    const ageMs = now - checkedAt;
    const threshold = ok ? OK_STALE_MS : ERROR_RETRY_MS;
    return ageMs > threshold;
}

export function buildCodexMcpResumeRegistryDetectRequest(): CapabilitiesDetectRequest {
    return {
        requests: [
            {
                id: CODEX_MCP_RESUME_DEP_ID,
                params: { includeRegistry: true, onlyIfInstalled: true, distTag: CODEX_MCP_RESUME_DIST_TAG },
            },
        ],
    };
}
