import type { ProjectGroupData, ProjectWorkspaceGroup } from '@/sync/projectGroups';
import type { SessionRowData } from '@/sync/storage';
import type { SessionState } from '@/utils/sessionUtils';

/**
 * Fake project/session data for the sessions-list layout sandbox
 * (`/dev/session-layouts`). Shaped exactly like the real view data so layout
 * candidates can be built against production types and moved over unchanged.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A single import-time timestamp keeps every relative label stable while the
// sandbox is open, instead of drifting between re-renders.
const NOW = Date.now();

interface FakeSessionInput {
    id: string;
    name: string;
    state: SessionState;
    provider?: 'codex' | 'claude';
    model?: string;
    activity?: string;
    unread?: boolean;
    draft?: boolean;
    archived?: boolean;
    agoMinutes?: number;
    path?: string;
    machineId?: string;
    workspaceName?: string | null;
}

function fakeSession(input: FakeSessionInput): SessionRowData {
    // Archive is independent of the agent lifecycle — a fixture can be either.
    const active = input.state !== 'disconnected';
    const provider = input.provider ?? 'codex';
    const providerName = provider === 'claude' ? 'Claude Code' : 'OpenAI Codex';
    const activeAt = NOW - (input.agoMinutes ?? 0) * MINUTE;
    return {
        id: input.id,
        name: input.name,
        subtitle: input.path ?? '~/Projects/happy',
        avatarId: input.id,
        flavor: provider,
        clientId: 'rig',
        identityLine: `Rig · ${providerName}`,
        providerKind: provider,
        modelName: input.model ?? (provider === 'claude' ? 'Opus 5' : 'GPT-5.6 Sol'),
        activitySummary: input.activity ?? null,
        state: input.state,
        ...(active ? {} : { activeAt, createdAt: activeAt - DAY }),
        hasDraft: !!input.draft,
        active,
        archived: !!input.archived,
        machineId: input.machineId ?? 'machine-denis',
        path: input.path ?? '/Users/denis/Projects/happy',
        homeDir: '/Users/denis',
        completedTodosCount: 0,
        totalTodosCount: 0,
        hasUnread: !!input.unread,
        projectId: null,
        projectName: null,
        workspaceId: input.workspaceName ? `wt-${input.workspaceName}` : null,
        workspaceName: input.workspaceName ?? null,
    };
}

function workspace(name: string | null, sessions: FakeSessionInput[]): ProjectWorkspaceGroup {
    return {
        id: name ? `wt-${name}` : '',
        name,
        sessions: sessions.map((session) => fakeSession({ ...session, workspaceName: name })),
    };
}

function project(
    id: string,
    name: string,
    machineId: string | null,
    workspaces: ProjectWorkspaceGroup[],
): ProjectGroupData {
    const sessions = workspaces.flatMap((item) => item.sessions);
    return {
        id,
        name,
        machineId,
        workspaces,
        sessionCount: sessions.length,
        activeCount: sessions.filter((session) => session.active).length,
    };
}

/** Rig projects: several worktrees, mixed providers, some archived rows. */
export const fixtureRigProjects: ProjectGroupData[] = [
    project('rig:happy', 'happy', 'machine-denis', [
        workspace(null, [
            { id: 's-1', name: 'Flatten the sessions list', state: 'thinking', activity: '3 edits' },
            { id: 's-2', name: 'Push suppression needs an active client', state: 'permission_required' },
            { id: 's-3', name: 'Rig session', state: 'disconnected', archived: true, agoMinutes: 190 },
        ]),
        workspace('feat/rig-native-sessions', [
            { id: 's-4', name: 'Create Rig sessions from Happy', state: 'waiting', unread: true },
            { id: 's-5', name: 'Session naming heuristics', state: 'waiting', draft: true, provider: 'claude' },
        ]),
        workspace('fix/stale-agent', [
            { id: 's-6', name: 'Stale agent selection for machine', state: 'waiting', agoMinutes: 12 },
        ]),
    ]),
    project('rig:rig', 'rig', 'machine-denis', [
        workspace(null, [
            { id: 's-7', name: 'Worktree bootstrap', state: 'thinking', provider: 'claude', activity: '1 test' },
            { id: 's-8', name: 'Autoname sessions from first prompt', state: 'waiting' },
            { id: 's-9', name: 'Rig session', state: 'disconnected', archived: true, agoMinutes: 1400 },
        ]),
    ]),
    project('rig:home', 'Home', 'machine-denis', [
        workspace(null, [
            { id: 's-10', name: 'Casual Greeting', state: 'waiting', path: '/Users/denis' },
            { id: 's-11', name: 'Rig session', state: 'disconnected', archived: true, agoMinutes: 60, path: '/Users/denis' },
        ]),
    ]),
];

/** Happy CLI projects, including a second machine to exercise machine labels. */
export const fixtureHappyProjects: ProjectGroupData[] = [
    project('happy:happy-dev', 'happy', 'machine-denis-dev', [
        workspace(null, [
            { id: 'h-1', name: 'Новый чат', state: 'waiting', machineId: 'machine-denis-dev', provider: 'claude' },
            { id: 'h-2', name: 'Web scroll for wide code blocks', state: 'disconnected', machineId: 'machine-denis-dev', agoMinutes: 45, provider: 'claude' },
            { id: 'h-3', name: 'Новый чат', state: 'disconnected', machineId: 'machine-denis-dev', archived: true, agoMinutes: 300, provider: 'claude' },
        ]),
    ]),
    project('happy:dotfiles', 'dotfiles', 'machine-mini', [
        workspace(null, [
            { id: 'h-4', name: 'Zsh prompt cleanup', state: 'waiting', machineId: 'machine-mini', path: '/Users/denis/dotfiles', provider: 'claude' },
            { id: 'h-5', name: 'Brewfile audit', state: 'disconnected', machineId: 'machine-mini', path: '/Users/denis/dotfiles', agoMinutes: 2880, provider: 'claude' },
        ]),
    ]),
];

export const fixtureMachineNames: Record<string, string> = {
    'machine-denis': 'MacBook-Pro-Denis',
    'machine-denis-dev': 'MacBook-Pro-Denis-dev',
    'machine-mini': 'mac-mini',
};

/** Flat, newest-first view of every fixture session, for feed-style layouts. */
export function fixtureFlatSessions(projects: ProjectGroupData[]): {
    session: SessionRowData;
    projectName: string;
    machineId: string | null;
}[] {
    return projects.flatMap((item) =>
        item.workspaces.flatMap((tree) =>
            tree.sessions.map((session) => ({
                session,
                projectName: item.name,
                machineId: item.machineId,
            })),
        ),
    );
}
