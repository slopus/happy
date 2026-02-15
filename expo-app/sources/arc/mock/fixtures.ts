/**
 * Pre-built mock data scenarios for UI testing.
 */

import { Session, Machine } from '@/sync/storageTypes';
import { ArcConfig } from '@/arc/agent/types';
import { createMockSession, createMockMachine, createMockAgentConfig } from './factory';

export interface MockFixture {
    name: string;
    sessions: Session[];
    machines: Machine[];
    agentConfigs: Record<string, ArcConfig>;
}

// =============================================================================
// Fixtures
// =============================================================================

const HOUR = 3600_000;
const DAY = 86400_000;

export function emptyFixture(): MockFixture {
    return {
        name: 'empty',
        sessions: [],
        machines: [],
        agentConfigs: {},
    };
}

export function singleActiveFixture(): MockFixture {
    const now = Date.now();
    const machine = createMockMachine({
        id: 'machine-1',
        host: 'seans-macbook',
        displayName: "Sean's MacBook Pro",
    });

    const session = createMockSession({
        id: 'session-emila',
        active: true,
        thinking: true,
        path: '/Users/sean/src/emila',
        host: 'seans-macbook',
        machineId: 'machine-1',
        homeDir: '/Users/sean',
        name: 'Refactor auth middleware',
        createdAt: now - 2 * HOUR,
        updatedAt: now - 30_000,
    });

    return {
        name: 'singleActive',
        sessions: [session],
        machines: [machine],
        agentConfigs: {
            'session-emila': createMockAgentConfig({
                name: 'Emila',
                tagline: 'Executive assistant for Sean Hsieh',
                avatar: 'https://runline-assets.t3.storage.dev/emila/emila-avatar.jpg',
            }),
        },
    };
}

export function multipleProjectsFixture(): MockFixture {
    const now = Date.now();

    // Machines
    const mac = createMockMachine({
        id: 'machine-mac',
        host: 'seans-macbook',
        displayName: "Sean's MacBook Pro",
    });
    const linux = createMockMachine({
        id: 'machine-linux',
        host: 'dev-server',
        platform: 'linux',
        displayName: 'Dev Server',
        homeDir: '/home/sean',
    });

    // Active sessions
    const activeWaiting = createMockSession({
        id: 'session-1',
        active: true,
        thinking: false,
        path: '/Users/sean/src/runline/arc',
        host: 'seans-macbook',
        machineId: 'machine-mac',
        homeDir: '/Users/sean',
        name: 'Add dark mode toggle',
        summary: 'Working on theme switching in settings page',
        createdAt: now - 4 * HOUR,
        updatedAt: now - 60_000,
    });

    const activeThinking = createMockSession({
        id: 'session-2',
        active: true,
        thinking: true,
        path: '/home/sean/api-server',
        host: 'dev-server',
        machineId: 'machine-linux',
        homeDir: '/home/sean',
        name: 'Optimize database queries',
        createdAt: now - HOUR,
        updatedAt: now - 5_000,
    });

    // Inactive sessions — today
    const inactiveToday = createMockSession({
        id: 'session-3',
        active: false,
        path: '/Users/sean/src/runline/arc',
        host: 'seans-macbook',
        machineId: 'machine-mac',
        homeDir: '/Users/sean',
        name: 'Fix navigation bug in sidebar',
        draft: 'Can you also check the tablet layout?',
        createdAt: now - 6 * HOUR,
        updatedAt: now - 2 * HOUR,
        activeAt: now - 2 * HOUR,
    });

    // Inactive sessions — yesterday
    const inactiveYesterday = createMockSession({
        id: 'session-4',
        active: false,
        path: '/Users/sean/src/emila',
        host: 'seans-macbook',
        machineId: 'machine-mac',
        homeDir: '/Users/sean',
        name: 'Set up voice integration',
        createdAt: now - DAY - 3 * HOUR,
        updatedAt: now - DAY - HOUR,
        activeAt: now - DAY - HOUR,
    });

    // Inactive sessions — 3 days ago, with permission request
    const inactiveOld = createMockSession({
        id: 'session-5',
        active: false,
        path: '/home/sean/api-server',
        host: 'dev-server',
        machineId: 'machine-linux',
        homeDir: '/home/sean',
        name: 'Migrate to Prisma v6',
        createdAt: now - 3 * DAY,
        updatedAt: now - 3 * DAY + HOUR,
        activeAt: now - 3 * DAY + HOUR,
    });

    return {
        name: 'multipleProjects',
        sessions: [activeWaiting, activeThinking, inactiveToday, inactiveYesterday, inactiveOld],
        machines: [mac, linux],
        agentConfigs: {
            'session-1': createMockAgentConfig({
                name: 'Emila',
                tagline: 'Executive assistant for Sean Hsieh',
                avatar: 'https://runline-assets.t3.storage.dev/emila/emila-avatar.jpg',
            }),
            'session-2': createMockAgentConfig({
                name: 'DevBot',
                tagline: 'Backend engineering',
            }),
            'session-4': createMockAgentConfig({
                name: 'Emila',
                tagline: 'Executive assistant for Sean Hsieh',
                avatar: 'https://runline-assets.t3.storage.dev/emila/emila-avatar.jpg',
            }),
        },
    };
}

export function permissionRequestsFixture(): MockFixture {
    const now = Date.now();

    const machine = createMockMachine({
        id: 'machine-1',
        host: 'seans-macbook',
        displayName: "Sean's MacBook Pro",
    });

    const session = createMockSession({
        id: 'session-perm',
        active: true,
        thinking: false,
        hasPermissionRequest: true,
        path: '/Users/sean/src/runline/arc',
        host: 'seans-macbook',
        machineId: 'machine-1',
        homeDir: '/Users/sean',
        name: 'Deploy to production',
        createdAt: now - HOUR,
        updatedAt: now - 10_000,
    });

    return {
        name: 'permissionRequests',
        sessions: [session],
        machines: [machine],
        agentConfigs: {
            'session-perm': createMockAgentConfig({
                name: 'Emila',
                tagline: 'Executive assistant for Sean Hsieh',
                avatar: 'https://runline-assets.t3.storage.dev/emila/emila-avatar.jpg',
            }),
        },
    };
}

// =============================================================================
// Registry
// =============================================================================

export const FIXTURES = {
    empty: emptyFixture,
    singleActive: singleActiveFixture,
    multipleProjects: multipleProjectsFixture,
    permissionRequests: permissionRequestsFixture,
} as const;

export type FixtureName = keyof typeof FIXTURES;

export function getFixture(name: string): MockFixture {
    const factory = FIXTURES[name as FixtureName];
    if (!factory) {
        console.warn(`[Mock] Unknown fixture "${name}", falling back to empty`);
        return emptyFixture();
    }
    return factory();
}
