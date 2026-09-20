import { describe, expect, it } from 'vitest';
import { buildProjectHomeRows, findProjectWorktree, workspaceOrigin } from './projectHomeList';
import type { SessionListViewItem, SessionRowData } from '@/sync/storage';

function row(overrides: Partial<SessionRowData> & { id: string }): SessionRowData {
    return {
        name: overrides.id,
        subtitle: '',
        avatarId: overrides.id,
        flavor: null,
        clientId: 'rig',
        identityLine: null,
        providerKind: null,
        modelName: null,
        activitySummary: null,
        gitChangedFiles: null,
        gitCountsExact: true,
        gitDeletions: null,
        gitInsertions: null,
        state: 'waiting',
        createdAt: 0,
        lastActivityAt: 0,
        hasDraft: false,
        active: true,
        archived: false,
        machineId: 'machine-a',
        machineOffline: false,
        path: null,
        homeDir: null,
        completedTodosCount: 0,
        totalTodosCount: 0,
        hasUnread: false,
        projectId: null,
        projectName: null,
        workspaceId: null,
        workspaceName: null,
        ...overrides,
    };
}

function project(
    name: string,
    source: 'rig' | 'happy',
    workspaces: { id: string; name: string | null; sessions: SessionRowData[] }[],
    machineId: string = 'machine-a',
): SessionListViewItem {
    const sessions = workspaces.flatMap((workspace) => workspace.sessions);
    return {
        type: 'project',
        source,
        project: {
            id: `${source}:${name}`,
            name,
            machineId,
            workspaces,
            sessionCount: sessions.length,
            activeCount: sessions.length,
        },
    };
}

const machines = [
    { id: 'machine-a', metadata: { displayName: 'Studio', machineKind: 'rig' } },
    { id: 'machine-b', metadata: { displayName: 'Laptop', machineKind: 'rig' } },
    // No `machineKind`: a Happy CLI daemon, which trails the Happy Agent ones.
    { id: 'machine-c', metadata: { displayName: 'Terminal' } },
];

function build(
    data: SessionListViewItem[],
    expanded: Record<string, boolean> = {},
    archive: { hasArchivedSessions?: boolean; archiveHidden?: boolean } = {},
) {
    return buildProjectHomeRows({
        data,
        machines,
        unknownMachineText: 'unknown',
        expanded,
        labels: { bots: 'Bots', projects: 'Projects' },
        ...archive,
    });
}

function shape(rows: ReturnType<typeof build>): string[] {
    return rows.map((item) => {
        switch (item.type) {
            case 'section': return `section:${item.label}`;
            case 'machine': return `machine:${item.machineName}`;
            case 'bot': return `bot:${item.session.id}`;
            case 'project': return `project:${item.project.name}(${item.project.worktreeCount})`;
            case 'worktree': return `worktree:${item.worktree.workspaceName}${item.last ? ':last' : ''}`;
            case 'worktreeToggle': return item.toggle.expanded
                ? 'toggle:less'
                : `toggle:+${item.toggle.hiddenCount}`;
            case 'archiveToggle': return item.hidden ? 'archive:show' : 'archive:hide';
            case 'archiveHeader': return `archiveHeader:${item.title}`;
            case 'archived': return `archived:${item.session.id}`;
        }
    });
}

/** `count` worktrees named w1, w2, … beside the project's own checkout. */
function worktrees(count: number) {
    return [
        { id: '', name: null, sessions: [row({ id: 'own' })] },
        ...Array.from({ length: count }, (_, index) => ({
            id: `w${index + 1}`,
            name: `w${index + 1}`,
            sessions: [row({ id: `s${index + 1}` })],
        })),
    ];
}

describe('buildProjectHomeRows', () => {
    it('makes the project its own card and hangs only its worktrees under it', () => {
        const rows = build([
            project('happy', 'rig', [
                { id: '', name: null, sessions: [row({ id: 'a' }), row({ id: 'b' })] },
                { id: 'gdansk', name: 'Gdansk', sessions: [row({ id: 'c' })] },
            ]),
        ]);

        expect(shape(rows)).toEqual([
            'machine:Studio',
            'section:Projects',
            'project:happy(1)',
            'worktree:Gdansk:last',
        ]);
    });

    it('gives a project with no worktrees a single card and nothing to toggle', () => {
        const rows = build([
            project('shop-box', 'rig', [{ id: '', name: null, sessions: [row({ id: 'a' })] }]),
        ]);

        expect(shape(rows)).toEqual(['machine:Studio', 'section:Projects', 'project:shop-box(0)']);
        expect(rows[2]).toMatchObject({ project: { worktreeCount: 0 } });
    });

    it('opens the own checkout from the card, with its chats as tabs oldest first', () => {
        const rows = build([
            // The store hands a checkout's chats over most recent first.
            project('happy', 'rig', [
                { id: '', name: null, sessions: [row({ id: 'late', createdAt: 20 }), row({ id: 'early', createdAt: 10 })] },
            ]),
        ]);

        const card = rows[2].type === 'project' ? rows[2].project : null;
        expect(card?.session?.id).toBe('late');
        expect(card?.tabs.map((tab) => tab.id)).toEqual(['early', 'late']);
    });

    it('closes the tree line on the last worktree only', () => {
        const rows = build([
            project('happy', 'rig', [
                { id: '', name: null, sessions: [row({ id: 'a' })] },
                { id: 'v', name: 'Vilnius', sessions: [row({ id: 'b' })] },
                { id: 'i', name: 'Istanbul', sessions: [row({ id: 'c' })] },
            ]),
        ]);

        expect(shape(rows)).toEqual([
            'machine:Studio',
            'section:Projects',
            'project:happy(2)',
            'worktree:Vilnius',
            'worktree:Istanbul:last',
        ]);
    });

    it('lets each worktree report its own chats, and the card only its own', () => {
        const rows = build([
            project('happy', 'rig', [
                { id: '', name: null, sessions: [row({ id: 'a' })] },
                { id: 'w', name: 'w', sessions: [row({ id: 'b', state: 'permission_required', hasUnread: true })] },
            ]),
        ]);

        expect(rows[2]).toMatchObject({ project: { working: false, blocked: false, unread: false } });
        expect(rows[3]).toMatchObject({ worktree: { blocked: true, unread: true } });
    });

    it('shows the first three worktrees and offers the rest', () => {
        const rows = build([project('happy', 'rig', worktrees(5))]);

        expect(shape(rows)).toEqual([
            'machine:Studio',
            'section:Projects',
            'project:happy(5)',
            'worktree:w1',
            'worktree:w2',
            'worktree:w3',
            'toggle:+2',
        ]);
    });

    it('shows every worktree once the project is expanded', () => {
        const rows = build([project('happy', 'rig', worktrees(5))], { 'rig:happy': true });

        expect(shape(rows)).toEqual([
            'machine:Studio',
            'section:Projects',
            'project:happy(5)',
            'worktree:w1',
            'worktree:w2',
            'worktree:w3',
            'worktree:w4',
            'worktree:w5',
            'toggle:less',
        ]);
    });

    it('leaves a project sitting at the preview count alone', () => {
        // Three shown and none held back: a control that would do nothing in
        // either direction is not drawn.
        expect(shape(build([project('happy', 'rig', worktrees(3))]))).toEqual([
            'machine:Studio',
            'section:Projects',
            'project:happy(3)',
            'worktree:w1',
            'worktree:w2',
            'worktree:w3:last',
        ]);
        expect(shape(build([project('happy', 'rig', worktrees(3))], { 'rig:happy': true })))
            .toEqual([
                'machine:Studio',
                'section:Projects',
                'project:happy(3)',
                'worktree:w1',
                'worktree:w2',
                'worktree:w3:last',
            ]);
    });

    it('speaks for the worktrees it is holding back, and for nothing once expanded', () => {
        const held = [
            { id: '', name: null, sessions: [row({ id: 'own' })] },
            ...[1, 2, 3].map((n) => ({ id: `w${n}`, name: `w${n}`, sessions: [row({ id: `s${n}` })] })),
            { id: 'w4', name: 'w4', sessions: [row({ id: 's4', state: 'permission_required' as const, hasUnread: true })] },
        ];

        const folded = build([project('happy', 'rig', held)]);
        expect(folded[6]).toMatchObject({ toggle: { hiddenCount: 1, blocked: true, unread: true } });
        // The card never took this on: it answers for its own checkout only.
        expect(folded[2]).toMatchObject({ project: { blocked: false, unread: false } });

        const open = build([project('happy', 'rig', held)], { 'rig:happy': true });
        expect(open[7]).toMatchObject({
            toggle: { expanded: true, hiddenCount: 0, blocked: false, unread: false },
        });
    });

    it('runs the tree line through the toggle, which is the last row under a card', () => {
        const rows = build([project('happy', 'rig', worktrees(4))]);
        expect(rows[5]).toMatchObject({ type: 'worktree', last: false });
        expect(rows[6]).toMatchObject({ type: 'worktreeToggle' });
    });

    it('carries a project that has only worktrees, with no chat on the card', () => {
        const rows = build([
            project('happy', 'rig', [{ id: 'w', name: 'Vilnius', sessions: [row({ id: 'a' })] }]),
        ]);

        expect(shape(rows)).toEqual([
            'machine:Studio',
            'section:Projects',
            'project:happy(1)',
            'worktree:Vilnius:last',
        ]);
        expect(rows[2]).toMatchObject({ project: { session: null } });
        expect(rows[2].type === 'project' && rows[2].project.avatarSession?.id).toBe('a');
    });

    it('reports a card live only while a chat in it runs on a reachable machine', () => {
        const offline = build([
            project('a', 'rig', [{ id: '', name: null, sessions: [row({ id: 'x', machineOffline: true })] }]),
        ]);
        const inactive = build([
            project('b', 'rig', [{ id: '', name: null, sessions: [row({ id: 'y', active: false })] }]),
        ]);
        const live = build([
            project('c', 'rig', [{ id: '', name: null, sessions: [row({ id: 'z' })] }]),
        ]);

        expect(offline[2]).toMatchObject({ project: { live: false } });
        expect(inactive[2]).toMatchObject({ project: { live: false } });
        expect(live[2]).toMatchObject({ project: { live: true } });
    });

    it('skips checkouts with no chats left, and projects with no checkouts left', () => {
        const rows = build([
            project('happy', 'rig', [
                { id: '', name: null, sessions: [] },
                { id: 'w', name: 'w', sessions: [row({ id: 'a' })] },
            ]),
            project('empty', 'rig', [{ id: '', name: null, sessions: [] }]),
        ]);

        expect(shape(rows)).toEqual([
            'machine:Studio',
            'section:Projects',
            'project:happy(1)',
            'worktree:w:last',
        ]);
    });

    it('gives CLI projects the same card and worktrees Happy Agent projects get', () => {
        const rows = build([
            { type: 'bots', sessions: [row({ id: 'bot' }), row({ id: 'cli-bot', clientId: 'happy-cli' })] },
            project('happy', 'rig', [{ id: '', name: null, sessions: [row({ id: 'a' })] }]),
            project('cli', 'happy', [{ id: '', name: null, sessions: [row({ id: 'b', clientId: 'happy-cli' })] }]),
        ]);

        expect(shape(rows)).toEqual([
            'machine:Studio',
            'section:Bots',
            'bot:bot',
            'bot:cli-bot',
            'section:Projects',
            'project:cli(0)',
            'project:happy(0)',
        ]);
    });

    it('heads the list with the computer even when the account has only one', () => {
        const rows = build([
            project('happy', 'rig', [{ id: '', name: null, sessions: [row({ id: 'a' })] }]),
        ]);

        expect(shape(rows)).toEqual(['machine:Studio', 'section:Projects', 'project:happy(0)']);
    });

    it('gives every computer its own bots and its own projects', () => {
        const rows = build([
            { type: 'bots', sessions: [row({ id: 'studio-bot' }), row({ id: 'terminal-bot', machineId: 'machine-c' })] },
            project('happy', 'rig', [{ id: '', name: null, sessions: [row({ id: 'a' })] }]),
            project('cli', 'happy', [{ id: '', name: null, sessions: [row({ id: 'b', machineId: 'machine-c' })] }], 'machine-c'),
        ]);

        expect(shape(rows)).toEqual([
            'machine:Studio',
            'section:Bots',
            'bot:studio-bot',
            'section:Projects',
            'project:happy(0)',
            'machine:Terminal',
            'section:Bots',
            'bot:terminal-bot',
            'section:Projects',
            'project:cli(0)',
        ]);
    });

    it('leads with the Happy Agent computers and trails the CLI daemons', () => {
        const rows = build([
            project('cli', 'happy', [{ id: '', name: null, sessions: [row({ id: 'a', machineId: 'machine-c' })] }], 'machine-c'),
            project('agent', 'rig', [{ id: '', name: null, sessions: [row({ id: 'b' })] }]),
        ]);

        expect(shape(rows).filter((entry) => entry.startsWith('machine:')))
            .toEqual(['machine:Studio', 'machine:Terminal']);
    });

    it('puts the computer worked on most recently first within its own kind', () => {
        // Laptop sorts before Studio by name, so leading with Studio can only
        // be its more recent activity.
        const rows = build([
            project('recent', 'rig', [{ id: '', name: null, sessions: [row({ id: 'a', lastActivityAt: 20 })] }]),
            project('stale', 'rig', [
                { id: '', name: null, sessions: [row({ id: 'b', machineId: 'machine-b', lastActivityAt: 10 })] },
            ], 'machine-b'),
        ]);

        expect(shape(rows).filter((entry) => entry.startsWith('machine:')))
            .toEqual(['machine:Studio', 'machine:Laptop']);
    });

    it('files a chat that names no computer under its own heading, last', () => {
        const rows = build([
            { type: 'bots', sessions: [row({ id: 'homeless', machineId: null })] },
            project('happy', 'rig', [{ id: '', name: null, sessions: [row({ id: 'a' })] }]),
        ]);

        expect(shape(rows)).toEqual([
            'machine:Studio',
            'section:Projects',
            'project:happy(0)',
            'machine:<unknown>',
            'section:Bots',
            'bot:homeless',
        ]);
    });

    // Repeated labels are repeated rows, and the list keys on the id.
    it('gives the section labels under each computer ids of their own', () => {
        const rows = build([
            { type: 'bots', sessions: [row({ id: 'studio-bot' }), row({ id: 'terminal-bot', machineId: 'machine-c' })] },
        ]);
        const ids = rows.flatMap((item) => (item.type === 'section' ? [item.id] : []));

        expect(ids).toEqual(['bots:machine-a', 'bots:machine-c']);
    });

    it('trails the revealed archive behind every computer, under its toggle', () => {
        const rows = build([
            project('happy', 'rig', [{ id: '', name: null, sessions: [row({ id: 'a' })] }]),
            { type: 'header', title: 'Today' },
            { type: 'session', session: row({ id: 'archived', archived: true }) },
        ], {}, { hasArchivedSessions: true, archiveHidden: false });

        expect(shape(rows)).toEqual([
            'machine:Studio',
            'section:Projects',
            'project:happy(0)',
            'archive:hide',
            'archiveHeader:Today',
            'archived:archived',
        ]);
    });

    // The store filters hidden archived chats out of the data before it gets
    // here, so the toggle is the only trace of them — and it has to be there,
    // or nothing on the screen could bring them back.
    it('keeps the toggle while the archive is hidden, and nothing else of it', () => {
        const rows = build([
            project('happy', 'rig', [{ id: '', name: null, sessions: [row({ id: 'a' })] }]),
        ], {}, { hasArchivedSessions: true, archiveHidden: true });

        expect(shape(rows)).toEqual([
            'machine:Studio',
            'section:Projects',
            'project:happy(0)',
            'archive:show',
        ]);
    });

    // An account with nothing but an archive used to open onto a blank screen.
    it('still offers the archive when there is nothing else', () => {
        const rows = build([], {}, { hasArchivedSessions: true, archiveHidden: true });
        expect(shape(rows)).toEqual(['archive:show']);
    });

    it('draws no toggle for an account with nothing archived', () => {
        const rows = build([
            project('happy', 'rig', [{ id: '', name: null, sessions: [row({ id: 'a' })] }]),
        ]);
        expect(shape(rows)).toEqual(['machine:Studio', 'section:Projects', 'project:happy(0)']);
    });

    it('draws no projects heading when the account has none', () => {
        expect(shape(build([{ type: 'bots', sessions: [row({ id: 'bot' })] }]))).toEqual([
            'machine:Studio',
            'section:Bots',
            'bot:bot',
        ]);
        expect(build([])).toEqual([]);
    });
});

describe('findProjectWorktree', () => {
    const data: SessionListViewItem[] = [
        { type: 'bots', sessions: [row({ id: 'bot' })] },
        project('happy', 'rig', [
            { id: '', name: null, sessions: [row({ id: 'own' })] },
            { id: 'gdansk', name: 'Gdansk', sessions: [row({ id: 'b', createdAt: 2 }), row({ id: 'a', createdAt: 1 })] },
        ]),
        project('cli', 'happy', [{ id: '', name: null, sessions: [row({ id: 'cli', clientId: 'happy-cli' })] }]),
    ];

    it('finds the checkout a chat runs in, with its sibling chats as tabs', () => {
        const worktree = findProjectWorktree(data, 'a');
        expect(worktree).toMatchObject({ projectName: 'happy', workspaceId: 'gdansk', workspaceName: 'Gdansk' });
        expect(worktree?.tabs.map((tab) => tab.id)).toEqual(['a', 'b']);
        expect(findProjectWorktree(data, 'own')).toMatchObject({ workspaceId: '', workspaceName: null });
    });

    it('reaches CLI project chats too', () => {
        expect(findProjectWorktree(data, 'cli')).toMatchObject({ projectName: 'cli', workspaceId: '' });
    });

    it('has nothing for bots or unknown chats', () => {
        expect(findProjectWorktree(data, 'bot')).toBeNull();
        expect(findProjectWorktree(data, 'missing')).toBeNull();
        expect(findProjectWorktree(null, 'a')).toBeNull();
    });
});

describe('workspaceOrigin', () => {
    it('names a Happy Agent project by identity, whichever checkout the chat runs in', () => {
        expect(workspaceOrigin(row({
            id: 'a',
            projectId: 'project-1',
            path: '/repo/.dev/worktree/gdansk',
        }))).toEqual({ machineId: 'machine-a', projectId: 'project-1', path: null });
    });

    it('sends a CLI worktree chat back to its main checkout', () => {
        expect(workspaceOrigin(row({ id: 'a', path: '/repo/.dev/worktree/gdansk' })))
            .toEqual({ machineId: 'machine-a', projectId: null, path: '/repo' });
        expect(workspaceOrigin(row({ id: 'a', path: '/repo' })))
            .toEqual({ machineId: 'machine-a', projectId: null, path: '/repo' });
    });

    it('has nowhere to create without a machine or a place', () => {
        expect(workspaceOrigin(row({ id: 'a', path: '/repo', machineId: null }))).toBeNull();
        expect(workspaceOrigin(row({ id: 'a', path: null }))).toBeNull();
        expect(workspaceOrigin(row({ id: 'a', path: '   ' }))).toBeNull();
    });
});
