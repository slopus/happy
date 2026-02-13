import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxConfig } from '@/persistence';
import {
    detectWorkspaceRootSuggestions,
    handleSandboxCommand,
    handleSandboxDisable,
    handleSandboxStatus,
} from './sandbox';

const { mockPrompt, mockReadSettings, mockUpdateSettings } = vi.hoisted(() => ({
    mockPrompt: vi.fn(),
    mockReadSettings: vi.fn(),
    mockUpdateSettings: vi.fn(),
}));

vi.mock('inquirer', () => ({
    default: {
        prompt: mockPrompt,
    },
}));

vi.mock('@/persistence', async () => {
    const actual = await vi.importActual<typeof import('@/persistence')>('@/persistence');
    return {
        ...actual,
        readSettings: mockReadSettings,
        updateSettings: mockUpdateSettings,
    };
});

describe('handleSandboxCommand', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('routes configure subcommand', async () => {
        mockPrompt
            .mockResolvedValueOnce({
                scopeMode: 'workspace',
                workspaceRoot: '~/Developer',
                networkMode: 'allowed',
                allowLocalBinding: true,
            })
            .mockResolvedValueOnce({ confirmSave: false });

        await handleSandboxCommand(['configure']);

        expect(mockPrompt).toHaveBeenCalled();
    });

    it('routes status subcommand', async () => {
        mockReadSettings.mockResolvedValue({ sandboxConfig: undefined });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await handleSandboxCommand(['status']);

        expect(mockReadSettings).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith('Sandbox is not configured. Run `happy sandbox configure`.');
    });

    it('routes disable subcommand', async () => {
        mockUpdateSettings.mockImplementation(async (updater: (value: any) => any) => {
            return updater({
                sandboxConfig: {
                    enabled: true,
                    workspaceRoot: '~/projects',
                    sessionIsolation: 'workspace',
                    customWritePaths: [],
                    denyReadPaths: ['~/.ssh'],
                    extraWritePaths: ['/tmp'],
                    denyWritePaths: ['.env'],
                    networkMode: 'allowed',
                    allowedDomains: [],
                    deniedDomains: [],
                    allowLocalBinding: true,
                },
            });
        });

        await handleSandboxCommand(['disable']);

        expect(mockUpdateSettings).toHaveBeenCalledTimes(1);
    });
});

describe('handleSandboxStatus', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('prints not configured when sandbox is missing', async () => {
        mockReadSettings.mockResolvedValue({ sandboxConfig: undefined });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await handleSandboxStatus();

        expect(logSpy).toHaveBeenCalledWith('Sandbox is not configured. Run `happy sandbox configure`.');
    });

    it('prints formatted sandbox configuration when present', async () => {
        const config: SandboxConfig = {
            enabled: true,
            workspaceRoot: '~/projects',
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: ['~/.ssh'],
            extraWritePaths: ['/tmp'],
            denyWritePaths: ['.env'],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
        };

        mockReadSettings.mockResolvedValue({ sandboxConfig: config });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        await handleSandboxStatus();

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Sandbox status'));
        expect(logSpy).toHaveBeenCalledWith('Enabled: yes');
        expect(logSpy).toHaveBeenCalledWith('Scope: workspace');
        expect(logSpy).toHaveBeenCalledWith('Network mode: allowed');
    });
});

describe('handleSandboxDisable', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sets sandboxConfig.enabled to false', async () => {
        const current = {
            sandboxConfig: {
                enabled: true,
                workspaceRoot: '~/projects',
                sessionIsolation: 'workspace',
                customWritePaths: [],
                denyReadPaths: ['~/.ssh'],
                extraWritePaths: ['/tmp'],
                denyWritePaths: ['.env'],
                networkMode: 'allowed',
                allowedDomains: [],
                deniedDomains: [],
                allowLocalBinding: true,
            },
        };

        let updated: any;
        mockUpdateSettings.mockImplementation(async (updater: (value: any) => any) => {
            updated = updater(current);
            return updated;
        });

        await handleSandboxDisable();

        expect(updated.sandboxConfig.enabled).toBe(false);
    });
});

describe('detectWorkspaceRootSuggestions', () => {
    it('returns existing roots in platform order', () => {
        const suggestions = detectWorkspaceRootSuggestions({
            platform: 'darwin',
            home: '/Users/test',
            pathExists: (path) => path === '/Users/test/Develop' || path === '/Users/test/Workspace',
        });

        expect(suggestions).toEqual(['~/Develop', '~/Workspace']);
    });

    it('returns first platform default when none exist', () => {
        const suggestions = detectWorkspaceRootSuggestions({
            platform: 'linux',
            home: '/home/test',
            pathExists: () => false,
        });

        expect(suggestions).toEqual(['~/Workspace']);
    });
});
