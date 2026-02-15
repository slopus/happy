/**
 * Pre-built mock conversation threads for each fixture session.
 *
 * Each function returns a NormalizedMessage[] that can be passed to
 * storage.getState().applyMessages(sessionId, messages).
 */

import { NormalizedMessage } from '@/sync/typesRaw';
import {
    createUserMessage,
    createAgentMessage,
    createToolCall,
    createToolResult,
    createThinkingMessage,
} from './factory';

// =============================================================================
// Helpers
// =============================================================================

/** Offset timestamps relative to a base time */
function at(base: number, offsetMs: number) {
    return base + offsetMs;
}

// =============================================================================
// singleActive: "Refactor auth middleware" — Emila thinking
// =============================================================================

export function singleActiveMessages(baseTime: number): NormalizedMessage[] {
    const t = baseTime;

    return [
        createUserMessage(
            'Can you refactor the auth middleware to use JWT verification instead of session cookies? The current implementation is in `src/middleware/auth.ts`.',
            { id: 'sa-user-1', createdAt: at(t, 0) }
        ),
        createThinkingMessage(
            'The user wants to refactor auth middleware from session cookies to JWT. I should first read the existing file to understand the current implementation, then plan the changes.',
            { id: 'sa-think-1', createdAt: at(t, 1000) }
        ),
        createAgentMessage(
            "I'll help you refactor the auth middleware to use JWT. Let me first read the current implementation.",
            {
                id: 'sa-agent-1',
                createdAt: at(t, 2000),
                usage: { input_tokens: 2100, output_tokens: 85, cache_read_input_tokens: 14000 },
            }
        ),
        createToolCall('Read', { file_path: '/Users/sean/src/emila/src/middleware/auth.ts' }, {
            id: 'sa-tc-1', toolId: 'sa-tool-read-1', createdAt: at(t, 2500),
            description: 'Reading auth middleware',
        }),
        createToolResult('sa-tool-read-1',
            `import { Request, Response, NextFunction } from 'express';\nimport { SessionStore } from '../session';\n\nexport function authMiddleware(req: Request, res: Response, next: NextFunction) {\n    const sessionId = req.cookies['session_id'];\n    if (!sessionId) {\n        return res.status(401).json({ error: 'No session' });\n    }\n    const session = SessionStore.get(sessionId);\n    if (!session) {\n        return res.status(401).json({ error: 'Invalid session' });\n    }\n    req.user = session.user;\n    next();\n}`,
            { id: 'sa-tr-1', createdAt: at(t, 3000) }
        ),
        createAgentMessage(
            "I can see the current middleware uses cookie-based sessions. Here's my plan:\n\n1. Replace `SessionStore` lookup with JWT verification\n2. Extract the token from the `Authorization: Bearer` header\n3. Add proper error handling for expired/invalid tokens\n4. Keep the `req.user` assignment for downstream compatibility\n\nLet me also check if you already have a JWT library installed.",
            {
                id: 'sa-agent-2',
                createdAt: at(t, 4000),
                usage: { input_tokens: 3200, output_tokens: 180, cache_read_input_tokens: 14000 },
            }
        ),
        createToolCall('Bash', { command: 'cat package.json | grep -i jwt' }, {
            id: 'sa-tc-2', toolId: 'sa-tool-bash-1', createdAt: at(t, 5000),
            description: 'Check for JWT dependency',
        }),
        createToolResult('sa-tool-bash-1',
            '    "jsonwebtoken": "^9.0.2",',
            { id: 'sa-tr-2', createdAt: at(t, 5500) }
        ),
        createAgentMessage(
            "Great, `jsonwebtoken` is already installed. Now let me update the middleware.",
            {
                id: 'sa-agent-3',
                createdAt: at(t, 6000),
                usage: { input_tokens: 3800, output_tokens: 45, cache_read_input_tokens: 14000 },
            }
        ),
        createToolCall('Edit', {
            file_path: '/Users/sean/src/emila/src/middleware/auth.ts',
            old_string: `import { Request, Response, NextFunction } from 'express';\nimport { SessionStore } from '../session';`,
            new_string: `import { Request, Response, NextFunction } from 'express';\nimport jwt from 'jsonwebtoken';\nimport { config } from '../config';`,
        }, {
            id: 'sa-tc-3', toolId: 'sa-tool-edit-1', createdAt: at(t, 6500),
            description: 'Update imports for JWT',
        }),
        createToolResult('sa-tool-edit-1', 'File edited successfully.', {
            id: 'sa-tr-3', createdAt: at(t, 7000),
        }),
        createToolCall('Edit', {
            file_path: '/Users/sean/src/emila/src/middleware/auth.ts',
            old_string: `export function authMiddleware(req: Request, res: Response, next: NextFunction) {\n    const sessionId = req.cookies['session_id'];\n    if (!sessionId) {\n        return res.status(401).json({ error: 'No session' });\n    }\n    const session = SessionStore.get(sessionId);\n    if (!session) {\n        return res.status(401).json({ error: 'Invalid session' });\n    }\n    req.user = session.user;\n    next();\n}`,
            new_string: `export function authMiddleware(req: Request, res: Response, next: NextFunction) {\n    const authHeader = req.headers.authorization;\n    if (!authHeader?.startsWith('Bearer ')) {\n        return res.status(401).json({ error: 'Missing bearer token' });\n    }\n\n    const token = authHeader.slice(7);\n    try {\n        const payload = jwt.verify(token, config.jwtSecret) as { userId: string; email: string };\n        req.user = { id: payload.userId, email: payload.email };\n        next();\n    } catch (err) {\n        if (err instanceof jwt.TokenExpiredError) {\n            return res.status(401).json({ error: 'Token expired' });\n        }\n        return res.status(401).json({ error: 'Invalid token' });\n    }\n}`,
        }, {
            id: 'sa-tc-4', toolId: 'sa-tool-edit-2', createdAt: at(t, 7500),
            description: 'Replace session lookup with JWT verification',
        }),
        createToolResult('sa-tool-edit-2', 'File edited successfully.', {
            id: 'sa-tr-4', createdAt: at(t, 8000),
        }),
    ];
}

// =============================================================================
// multipleProjects session-1: "Add dark mode toggle" — waiting
// =============================================================================

export function darkModeMessages(baseTime: number): NormalizedMessage[] {
    const t = baseTime;

    return [
        createUserMessage(
            'Add a dark mode toggle to the settings page. Use the existing theme system.',
            { id: 'dm-user-1', createdAt: at(t, 0) }
        ),
        createAgentMessage(
            "I'll add a dark mode toggle to your settings page. Let me first check the existing theme system to understand how it works.",
            {
                id: 'dm-agent-1',
                createdAt: at(t, 1500),
                usage: { input_tokens: 1800, output_tokens: 65, cache_read_input_tokens: 12000 },
            }
        ),
        createToolCall('Grep', { pattern: 'ThemeProvider|useTheme|darkMode', path: 'src/', type: 'tsx' }, {
            id: 'dm-tc-1', toolId: 'dm-tool-grep-1', createdAt: at(t, 2000),
            description: 'Search for theme-related code',
        }),
        createToolResult('dm-tool-grep-1',
            'src/contexts/ThemeContext.tsx\nsrc/components/Layout.tsx\nsrc/hooks/useTheme.ts',
            { id: 'dm-tr-1', createdAt: at(t, 2500) }
        ),
        createToolCall('Read', { file_path: '/Users/sean/src/runline/arc/src/contexts/ThemeContext.tsx' }, {
            id: 'dm-tc-2', toolId: 'dm-tool-read-1', createdAt: at(t, 3000),
            description: 'Reading ThemeContext',
        }),
        createToolResult('dm-tool-read-1',
            `import React, { createContext, useContext, useState } from 'react';\n\ntype Theme = 'light' | 'dark' | 'system';\n\nconst ThemeContext = createContext<{\n    theme: Theme;\n    setTheme: (t: Theme) => void;\n}>({ theme: 'system', setTheme: () => {} });\n\nexport function useTheme() {\n    return useContext(ThemeContext);\n}`,
            { id: 'dm-tr-2', createdAt: at(t, 3500) }
        ),
        createAgentMessage(
            "The theme system already supports `'light' | 'dark' | 'system'` modes. I'll add a toggle component to the settings page that uses `useTheme()`. Let me check the settings page structure.",
            {
                id: 'dm-agent-2',
                createdAt: at(t, 4000),
                usage: { input_tokens: 2500, output_tokens: 95, cache_read_input_tokens: 12000 },
            }
        ),
        createToolCall('Read', { file_path: '/Users/sean/src/runline/arc/src/pages/Settings.tsx' }, {
            id: 'dm-tc-3', toolId: 'dm-tool-read-2', createdAt: at(t, 4500),
            description: 'Reading Settings page',
        }),
        createToolResult('dm-tool-read-2',
            `import React from 'react';\nimport { SettingsSection } from '../components/SettingsSection';\n\nexport function SettingsPage() {\n    return (\n        <div className="settings-page">\n            <SettingsSection title="Account">\n                {/* account settings */}\n            </SettingsSection>\n            <SettingsSection title="Notifications">\n                {/* notification settings */}\n            </SettingsSection>\n        </div>\n    );\n}`,
            { id: 'dm-tr-3', createdAt: at(t, 5000) }
        ),
        createAgentMessage(
            "I'll add a new \"Appearance\" section with a three-way toggle for light, dark, and system themes. The component will use segmented control style for a clean look.",
            {
                id: 'dm-agent-3',
                createdAt: at(t, 5500),
                usage: { input_tokens: 3100, output_tokens: 110, cache_read_input_tokens: 12000 },
            }
        ),
    ];
}

// =============================================================================
// multipleProjects session-2: "Optimize database queries" — thinking
// =============================================================================

export function dbOptimizeMessages(baseTime: number): NormalizedMessage[] {
    const t = baseTime;

    return [
        createUserMessage(
            'The dashboard page is loading slowly. Can you look at the SQL queries and optimize them? The main bottleneck seems to be the analytics endpoint.',
            { id: 'db-user-1', createdAt: at(t, 0) }
        ),
        createAgentMessage(
            "I'll investigate the analytics endpoint performance. Let me trace the query path from the route handler to the database.",
            {
                id: 'db-agent-1',
                createdAt: at(t, 2000),
                usage: { input_tokens: 2200, output_tokens: 60, cache_read_input_tokens: 18000 },
            }
        ),
        createToolCall('Grep', { pattern: 'analytics|dashboard', path: 'src/routes/', type: 'ts' }, {
            id: 'db-tc-1', toolId: 'db-tool-grep-1', createdAt: at(t, 2500),
            description: 'Find analytics route handlers',
        }),
        createToolResult('db-tool-grep-1',
            'src/routes/analytics.ts\nsrc/routes/dashboard.ts',
            { id: 'db-tr-1', createdAt: at(t, 3000) }
        ),
        createToolCall('Read', { file_path: '/home/sean/api-server/src/routes/analytics.ts' }, {
            id: 'db-tc-2', toolId: 'db-tool-read-1', createdAt: at(t, 3500),
            description: 'Reading analytics route',
        }),
        createToolResult('db-tool-read-1',
            `import { prisma } from '../db';\nimport { Router } from 'express';\n\nconst router = Router();\n\nrouter.get('/stats', async (req, res) => {\n    const orgId = req.user.orgId;\n    \n    // N+1 query — fetches each user's sessions individually\n    const users = await prisma.user.findMany({ where: { orgId } });\n    const stats = await Promise.all(users.map(async (user) => {\n        const sessions = await prisma.session.count({ where: { userId: user.id } });\n        const lastActive = await prisma.session.findFirst({\n            where: { userId: user.id },\n            orderBy: { createdAt: 'desc' },\n        });\n        return { user: user.name, sessions, lastActive: lastActive?.createdAt };\n    }));\n    \n    res.json(stats);\n});`,
            { id: 'db-tr-2', createdAt: at(t, 4000) }
        ),
        createAgentMessage(
            "Found the problem. The `/stats` endpoint has a classic N+1 query issue — it makes 2 separate database calls per user (session count + last active). For an org with 100 users, that's 200+ queries.\n\nI'll rewrite this to use a single aggregation query with Prisma's `groupBy`.",
            {
                id: 'db-agent-2',
                createdAt: at(t, 5000),
                usage: { input_tokens: 4500, output_tokens: 160, cache_read_input_tokens: 18000 },
            }
        ),
        createToolCall('Edit', {
            file_path: '/home/sean/api-server/src/routes/analytics.ts',
            old_string: `    // N+1 query — fetches each user's sessions individually\n    const users = await prisma.user.findMany({ where: { orgId } });\n    const stats = await Promise.all(users.map(async (user) => {\n        const sessions = await prisma.session.count({ where: { userId: user.id } });\n        const lastActive = await prisma.session.findFirst({\n            where: { userId: user.id },\n            orderBy: { createdAt: 'desc' },\n        });\n        return { user: user.name, sessions, lastActive: lastActive?.createdAt };\n    }));`,
            new_string: `    // Single aggregation query — replaces N+1 pattern\n    const stats = await prisma.user.findMany({\n        where: { orgId },\n        select: {\n            name: true,\n            _count: { select: { sessions: true } },\n            sessions: {\n                select: { createdAt: true },\n                orderBy: { createdAt: 'desc' },\n                take: 1,\n            },\n        },\n    });\n\n    const result = stats.map((u) => ({\n        user: u.name,\n        sessions: u._count.sessions,\n        lastActive: u.sessions[0]?.createdAt ?? null,\n    }));`,
        }, {
            id: 'db-tc-3', toolId: 'db-tool-edit-1', createdAt: at(t, 6000),
            description: 'Replace N+1 with single aggregation query',
        }),
        createToolResult('db-tool-edit-1', 'File edited successfully.', {
            id: 'db-tr-3', createdAt: at(t, 6500),
        }),
        createToolCall('Bash', { command: 'cd /home/sean/api-server && npx prisma validate' }, {
            id: 'db-tc-4', toolId: 'db-tool-bash-1', createdAt: at(t, 7000),
            description: 'Validate Prisma schema',
        }),
        createToolResult('db-tool-bash-1',
            'Prisma schema validated successfully.',
            { id: 'db-tr-4', createdAt: at(t, 8000) }
        ),
    ];
}

// =============================================================================
// multipleProjects session-3: "Fix navigation bug in sidebar" — inactive/today
// =============================================================================

export function navBugMessages(baseTime: number): NormalizedMessage[] {
    const t = baseTime;

    return [
        createUserMessage(
            'The sidebar collapses when navigating to a nested route. It should stay open.',
            { id: 'nb-user-1', createdAt: at(t, 0) }
        ),
        createAgentMessage(
            "That sounds like a state management issue with the sidebar. Let me look at the sidebar component and how it handles route changes.",
            {
                id: 'nb-agent-1',
                createdAt: at(t, 1500),
                usage: { input_tokens: 1600, output_tokens: 55, cache_read_input_tokens: 11000 },
            }
        ),
        createToolCall('Read', { file_path: '/Users/sean/src/runline/arc/src/components/Sidebar.tsx' }, {
            id: 'nb-tc-1', toolId: 'nb-tool-read-1', createdAt: at(t, 2000),
            description: 'Reading Sidebar component',
        }),
        createToolResult('nb-tool-read-1',
            `import { usePathname } from 'expo-router';\nimport { useState, useEffect } from 'react';\n\nexport function Sidebar() {\n    const pathname = usePathname();\n    const [isOpen, setIsOpen] = useState(true);\n\n    // BUG: This resets isOpen on every route change\n    useEffect(() => {\n        setIsOpen(true);\n    }, [pathname]);\n\n    return (/* ... */);\n}`,
            { id: 'nb-tr-1', createdAt: at(t, 2500) }
        ),
        createAgentMessage(
            "Found the bug. The `useEffect` on line 10 re-runs whenever `pathname` changes and unconditionally sets `isOpen(true)`. But since `useState(true)` already initializes it to `true`, the issue is likely that something else is setting it to `false` first.\n\nThe real fix is to remove this effect entirely — the sidebar state should persist across navigations. Let me also check if there's a responsive collapse happening.",
            {
                id: 'nb-agent-2',
                createdAt: at(t, 3500),
                usage: { input_tokens: 2800, output_tokens: 130, cache_read_input_tokens: 11000 },
            }
        ),
        createToolCall('Edit', {
            file_path: '/Users/sean/src/runline/arc/src/components/Sidebar.tsx',
            old_string: `    // BUG: This resets isOpen on every route change\n    useEffect(() => {\n        setIsOpen(true);\n    }, [pathname]);`,
            new_string: `    // Sidebar state persists across navigations`,
        }, {
            id: 'nb-tc-2', toolId: 'nb-tool-edit-1', createdAt: at(t, 4000),
            description: 'Remove buggy useEffect that resets sidebar state',
        }),
        createToolResult('nb-tool-edit-1', 'File edited successfully.', {
            id: 'nb-tr-2', createdAt: at(t, 4500),
        }),
        createAgentMessage(
            "Fixed. The sidebar will now maintain its open/closed state when navigating between routes. The `useEffect` was triggering a re-render cycle on every pathname change that briefly collapsed and re-expanded the sidebar.\n\nWant me to run the tests to verify nothing else broke?",
            {
                id: 'nb-agent-3',
                createdAt: at(t, 5000),
                usage: { input_tokens: 3200, output_tokens: 95, cache_read_input_tokens: 11000 },
            }
        ),
    ];
}

// =============================================================================
// multipleProjects session-4: "Set up voice integration" — inactive/yesterday
// =============================================================================

export function voiceSetupMessages(baseTime: number): NormalizedMessage[] {
    const t = baseTime;

    return [
        createUserMessage(
            'Set up the ElevenLabs voice integration for Emila. The agent ID is in the .arc.yaml.',
            { id: 'vs-user-1', createdAt: at(t, 0) }
        ),
        createAgentMessage(
            "I'll set up the ElevenLabs voice integration. Let me read the `.arc.yaml` to get the agent ID and then wire it into the voice system.",
            {
                id: 'vs-agent-1',
                createdAt: at(t, 1500),
                usage: { input_tokens: 1500, output_tokens: 52, cache_read_input_tokens: 9000 },
            }
        ),
        createToolCall('Read', { file_path: '/Users/sean/src/emila/.arc.yaml' }, {
            id: 'vs-tc-1', toolId: 'vs-tool-read-1', createdAt: at(t, 2000),
            description: 'Reading .arc.yaml',
        }),
        createToolResult('vs-tool-read-1',
            `agent:\n  name: "Emila"\n  tagline: "Executive assistant for Sean Hsieh"\n  avatar: generated\n\nvoice:\n  elevenlabs_agent_id: "agent_abc123xyz"\n  greeting: "Hi Sean, how can I help you today?"\n  language: "en"`,
            { id: 'vs-tr-1', createdAt: at(t, 2500) }
        ),
        createAgentMessage(
            "Got the agent ID `agent_abc123xyz`. The voice config looks complete with a custom greeting. Now I need to wire the `RealtimeProvider` to use this agent ID when initiating voice sessions for Emila.\n\nLet me check how the voice system currently initializes.",
            {
                id: 'vs-agent-2',
                createdAt: at(t, 3500),
                usage: { input_tokens: 2200, output_tokens: 85, cache_read_input_tokens: 9000 },
            }
        ),
    ];
}

// =============================================================================
// multipleProjects session-5: "Migrate to Prisma v6" — inactive/old
// =============================================================================

export function prismaMigrationMessages(baseTime: number): NormalizedMessage[] {
    const t = baseTime;

    return [
        createUserMessage(
            'Migrate the project from Prisma v5 to v6. Follow the official migration guide.',
            { id: 'pm-user-1', createdAt: at(t, 0) }
        ),
        createAgentMessage(
            "I'll handle the Prisma v5 to v6 migration. The key changes are:\n\n1. Updated `@prisma/client` and `prisma` packages\n2. New `prisma.` namespace for enums\n3. Strict mode for `findUnique` return types\n4. Updated `$transaction` API\n\nLet me start by checking the current version and updating packages.",
            {
                id: 'pm-agent-1',
                createdAt: at(t, 2000),
                usage: { input_tokens: 2000, output_tokens: 120, cache_read_input_tokens: 15000 },
            }
        ),
        createToolCall('Bash', { command: 'cd /home/sean/api-server && cat package.json | grep prisma' }, {
            id: 'pm-tc-1', toolId: 'pm-tool-bash-1', createdAt: at(t, 2500),
            description: 'Check current Prisma version',
        }),
        createToolResult('pm-tool-bash-1',
            '    "@prisma/client": "^5.22.0",\n    "prisma": "^5.22.0",',
            { id: 'pm-tr-1', createdAt: at(t, 3000) }
        ),
        createToolCall('Bash', { command: 'cd /home/sean/api-server && npm install @prisma/client@6 prisma@6' }, {
            id: 'pm-tc-2', toolId: 'pm-tool-bash-2', createdAt: at(t, 3500),
            description: 'Upgrade Prisma to v6',
        }),
        createToolResult('pm-tool-bash-2',
            'added 12 packages, removed 4 packages, and changed 8 packages in 14s',
            { id: 'pm-tr-2', createdAt: at(t, 5000) }
        ),
    ];
}

// =============================================================================
// permissionRequests: "Deploy to production" — with pending permission
// =============================================================================

export function deployMessages(baseTime: number): NormalizedMessage[] {
    const t = baseTime;

    return [
        createUserMessage(
            'Deploy the latest changes to production.',
            { id: 'dp-user-1', createdAt: at(t, 0) }
        ),
        createAgentMessage(
            "I'll deploy the latest changes to production. Let me first check the current git status and make sure we're on the right branch with no uncommitted changes.",
            {
                id: 'dp-agent-1',
                createdAt: at(t, 1500),
                usage: { input_tokens: 1800, output_tokens: 65, cache_read_input_tokens: 10000 },
            }
        ),
        createToolCall('Bash', { command: 'git status && git log --oneline -3' }, {
            id: 'dp-tc-1', toolId: 'dp-tool-bash-1', createdAt: at(t, 2000),
            description: 'Check git status',
        }),
        createToolResult('dp-tool-bash-1',
            'On branch main\nYour branch is up to date with \'origin/main\'.\n\nnothing to commit, working tree clean\n\n3f2a1b8 feat: add dark mode toggle\n8c4d5e6 fix: sidebar navigation bug\na1b2c3d refactor: auth middleware to JWT',
            { id: 'dp-tr-1', createdAt: at(t, 2500) }
        ),
        createAgentMessage(
            "Clean working tree on `main`, up to date with origin. The latest 3 commits look good. I'll run the test suite first, then deploy.",
            {
                id: 'dp-agent-2',
                createdAt: at(t, 3000),
                usage: { input_tokens: 2500, output_tokens: 55, cache_read_input_tokens: 10000 },
            }
        ),
        createToolCall('Bash', { command: 'npm test' }, {
            id: 'dp-tc-2', toolId: 'dp-tool-bash-2', createdAt: at(t, 3500),
            description: 'Run test suite',
        }),
        createToolResult('dp-tool-bash-2',
            'Test Suites:  12 passed, 12 total\nTests:       87 passed, 87 total\nSnapshots:   0 total\nTime:        8.234s\nRan all test suites.',
            { id: 'dp-tr-2', createdAt: at(t, 12000) }
        ),
        createAgentMessage(
            "All 87 tests passing. Deploying to production now.",
            {
                id: 'dp-agent-3',
                createdAt: at(t, 13000),
                usage: { input_tokens: 3000, output_tokens: 25, cache_read_input_tokens: 10000 },
            }
        ),
        // This is the tool call that matches the session's agentState permission request
        createToolCall('Bash', { command: 'rm -rf /tmp/old-build' }, {
            id: 'dp-tc-3', toolId: 'dp-tool-bash-3', createdAt: at(t, 13500),
            description: 'Clean old build artifacts',
        }),
        // No result for this one — it's pending permission
    ];
}

// =============================================================================
// Map session IDs to message generators
// =============================================================================

export type MessageGenerator = (baseTime: number) => NormalizedMessage[];

export const FIXTURE_MESSAGES: Record<string, Record<string, MessageGenerator>> = {
    singleActive: {
        'session-emila': singleActiveMessages,
    },
    multipleProjects: {
        'session-1': darkModeMessages,
        'session-2': dbOptimizeMessages,
        'session-3': navBugMessages,
        'session-4': voiceSetupMessages,
        'session-5': prismaMigrationMessages,
    },
    permissionRequests: {
        'session-perm': deployMessages,
    },
};
