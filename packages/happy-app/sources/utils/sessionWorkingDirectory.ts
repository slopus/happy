import type { Session } from '@/sync/storageTypes';
import type { NewSessionAgentType } from '@/sync/persistence';

const MAX_DIRECTORY_LABEL_LENGTH = 32;

export function formatWorkingDirectoryLabel(path: string, homeDir?: string): string {
    const normalizedHome = homeDir?.replace(/[\\/]+$/, '');
    const relative = normalizedHome && (path === normalizedHome || path.startsWith(`${normalizedHome}/`) || path.startsWith(`${normalizedHome}\\`))
        ? `~${path.slice(normalizedHome.length)}`
        : path;
    if (relative.length <= MAX_DIRECTORY_LABEL_LENGTH) {
        return relative;
    }

    const separator = relative.includes('\\') ? '\\' : '/';
    const parts = relative.split(/[\\/]/).filter(Boolean);
    const tail = parts.slice(-2).join(separator);
    return relative.startsWith('~') ? `~${separator}…${separator}${tail}` : `…${separator}${tail}`;
}

export function getRecentWorkingDirectories(
    sessions: Session[],
    machineId: string,
    currentPath: string,
    limit: number = 6,
): string[] {
    const seen = new Set<string>([currentPath]);
    const paths: string[] = [];

    for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
        const path = session.metadata?.path;
        if (session.metadata?.machineId !== machineId || !path || seen.has(path)) {
            continue;
        }
        seen.add(path);
        paths.push(path);
        if (paths.length >= limit) {
            break;
        }
    }

    return paths;
}

export type WorkingDirectorySwitchStrategy =
    | 'continue-context'
    | 'new-session'
    | 'continuation-unavailable'
    | 'unsupported';

type SupportedWorkingDirectoryAgent = Exclude<NewSessionAgentType, 'ask'>;
type WorkingDirectoryCapability = {
    agent: SupportedWorkingDirectoryAgent;
    strategy: Exclude<WorkingDirectorySwitchStrategy, 'continuation-unavailable' | 'unsupported'>;
    requiresContinuation: boolean;
};
type WorkingDirectoryCapabilityMap = {
    [Agent in SupportedWorkingDirectoryAgent]: Omit<WorkingDirectoryCapability, 'agent'> & { agent: Agent };
};

const WORKING_DIRECTORY_CAPABILITIES = {
    claude: { agent: 'claude', strategy: 'continue-context', requiresContinuation: true },
    codex: { agent: 'codex', strategy: 'continue-context', requiresContinuation: true },
    gemini: { agent: 'gemini', strategy: 'new-session', requiresContinuation: false },
    opencode: { agent: 'opencode', strategy: 'new-session', requiresContinuation: false },
    openclaw: { agent: 'openclaw', strategy: 'new-session', requiresContinuation: false },
} satisfies WorkingDirectoryCapabilityMap;

function getWorkingDirectoryCapability(
    flavor: string | null | undefined,
): WorkingDirectoryCapability | null {
    if (!flavor || !Object.prototype.hasOwnProperty.call(WORKING_DIRECTORY_CAPABILITIES, flavor)) {
        return null;
    }
    return WORKING_DIRECTORY_CAPABILITIES[flavor as SupportedWorkingDirectoryAgent];
}

export function resolveWorkingDirectoryAgent(flavor: string | null | undefined): NewSessionAgentType | null {
    return getWorkingDirectoryCapability(flavor)?.agent ?? null;
}

/**
 * Codex and Claude can only change directory without losing conversation
 * context when their provider continuation id is present. Ask has no durable
 * provider continuation and intentionally cannot access local files, so a
 * working-directory switch would be misleading there. Other file-capable
 * agents keep their existing same-type fresh-session behavior.
 */
export function resolveWorkingDirectorySwitchStrategy(
    flavor: string | null | undefined,
    hasContinuationSource: boolean,
): WorkingDirectorySwitchStrategy {
    const capability = getWorkingDirectoryCapability(flavor);
    if (!capability) {
        return 'unsupported';
    }
    return capability.requiresContinuation && !hasContinuationSource
        ? 'continuation-unavailable'
        : capability.strategy;
}
