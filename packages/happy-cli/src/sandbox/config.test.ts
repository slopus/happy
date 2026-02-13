import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSandboxRuntimeConfig } from './config';
import type { SandboxConfig } from '@/persistence';

const sessionPath = '/tmp/happy-session';

function resolveLikeRuntime(pathValue: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }
    return resolve(sessionPath, expandedHome);
}

function expectedSharedAgentStatePaths(): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';
    return [...new Set([
        resolveLikeRuntime(codexHome),
        resolveLikeRuntime(claudeConfigDir),
    ])];
}

function createConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return {
        enabled: true,
        workspaceRoot: '~/projects',
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: ['~/.ssh', '~/.aws'],
        extraWritePaths: ['/tmp'],
        denyWritePaths: ['.env'],
        networkMode: 'allowed',
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        ...overrides,
    };
}

describe('buildSandboxRuntimeConfig', () => {
    it('builds strict filesystem isolation', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({ sessionIsolation: 'strict' }),
            sessionPath,
        );

        expect(runtimeConfig.allowPty).toBe(true);
        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            resolve(sessionPath),
            '/tmp',
            ...expectedSharedAgentStatePaths(),
        ]);
    });

    it('builds workspace isolation using workspaceRoot fallback to sessionPath', () => {
        const withWorkspaceRoot = buildSandboxRuntimeConfig(createConfig(), sessionPath);
        expect(withWorkspaceRoot.filesystem?.allowWrite).toEqual([
            `${homedir()}/projects`,
            '/tmp',
            ...expectedSharedAgentStatePaths(),
        ]);

        const withoutWorkspaceRoot = buildSandboxRuntimeConfig(
            createConfig({ workspaceRoot: undefined }),
            sessionPath,
        );
        expect(withoutWorkspaceRoot.filesystem?.allowWrite).toEqual([
            resolve(sessionPath),
            '/tmp',
            ...expectedSharedAgentStatePaths(),
        ]);
    });

    it('builds custom isolation from explicit custom paths', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                sessionIsolation: 'custom',
                customWritePaths: ['~/sandbox', 'relative/write'],
                extraWritePaths: ['/tmp', '../scratch'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            `${homedir()}/sandbox`,
            resolve(sessionPath, 'relative/write'),
            '/tmp',
            resolve(sessionPath, '../scratch'),
            ...expectedSharedAgentStatePaths(),
        ]);
    });

    it('maps blocked and allowed network modes', () => {
        const blocked = buildSandboxRuntimeConfig(
            createConfig({ networkMode: 'blocked', allowLocalBinding: false }),
            sessionPath,
        );
        expect(blocked.network?.allowedDomains).toEqual([]);
        expect(blocked.network?.deniedDomains).toEqual([]);
        expect(blocked.network?.allowLocalBinding).toBe(false);

        const allowed = buildSandboxRuntimeConfig(
            createConfig({ networkMode: 'allowed' }),
            sessionPath,
        );
        expect(allowed.network?.allowedDomains).toEqual(['*']);
        expect(allowed.network?.deniedDomains).toEqual([]);
    });

    it('maps custom network mode from user lists', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                networkMode: 'custom',
                allowedDomains: ['*.github.com', 'api.openai.com'],
                deniedDomains: ['tracking.example.com'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.network?.allowedDomains).toEqual(['*.github.com', 'api.openai.com']);
        expect(runtimeConfig.network?.deniedDomains).toEqual(['tracking.example.com']);
    });

    it('resolves tilde and relative paths across all filesystem path fields', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                sessionIsolation: 'custom',
                customWritePaths: ['~/custom', 'relative/custom'],
                extraWritePaths: ['~/extra', './extra'],
                denyReadPaths: ['~/.ssh', 'relative/read'],
                denyWritePaths: ['.env', 'relative/write-deny'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            `${homedir()}/custom`,
            resolve(sessionPath, 'relative/custom'),
            `${homedir()}/extra`,
            resolve(sessionPath, './extra'),
            ...expectedSharedAgentStatePaths(),
        ]);
        expect(runtimeConfig.filesystem?.denyRead).toEqual([
            `${homedir()}/.ssh`,
            resolve(sessionPath, 'relative/read'),
        ]);
        expect(runtimeConfig.filesystem?.denyWrite).toEqual([
            resolve(sessionPath, '.env'),
            resolve(sessionPath, 'relative/write-deny'),
        ]);
    });

    it('includes overridden CODEX_HOME and CLAUDE_CONFIG_DIR in allowWrite', () => {
        const originalCodexHome = process.env.CODEX_HOME;
        const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

        try {
            process.env.CODEX_HOME = '~/custom-codex-home';
            process.env.CLAUDE_CONFIG_DIR = './custom-claude-config';

            const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), sessionPath);

            expect(runtimeConfig.filesystem?.allowWrite).toContain(`${homedir()}/custom-codex-home`);
            expect(runtimeConfig.filesystem?.allowWrite).toContain(resolve(sessionPath, './custom-claude-config'));
        } finally {
            if (originalCodexHome === undefined) {
                delete process.env.CODEX_HOME;
            } else {
                process.env.CODEX_HOME = originalCodexHome;
            }

            if (originalClaudeConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
            }
        }
    });
});
