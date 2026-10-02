import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSandboxRuntimeConfig, filterCredentialsFromEnv } from './config';
import type { SandboxConfig } from '@/persistence';
import { configuration } from '@/configuration';
import { macGetMandatoryDenyPatterns, wrapCommandWithSandboxMacOS } from '@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js';

const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : "/tmp";
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
    it('forwards an explicit Git config grant without discarding explicit deny paths', () => {
        const config = buildSandboxRuntimeConfig(createConfig({
            allowGitConfig: true,
            denyWritePaths: ['.env', '.git/config'],
        }), sessionPath);
        expect(config.filesystem?.allowGitConfig).toBe(true);
        expect(config.filesystem?.denyWrite).toContain(resolve(sessionPath, '.git/config'));
    });

    // specs/checkpoint-local-history — a checkpoint session works in the real repository, so it keeps
    // the project's Git configuration access like any other session.
    it('does not grant Git configuration by default, and a checkpoint session keeps the project choice', () => {
        expect(buildSandboxRuntimeConfig(createConfig(), sessionPath).filesystem?.allowGitConfig).toBe(false);
        const config = buildSandboxRuntimeConfig(createConfig({
            allowGitConfig: true,
            checkpointProtection: { secretPatterns: ['.env*'], maxFileBytes: 100, maxFiles: 10, maxTotalBytes: 1000 },
        }), sessionPath);
        expect(config.filesystem?.allowGitConfig).toBe(true);
    });

    it.runIf(process.platform === 'darwin')('maps the approved macOS temporary directory to its real path', () => {
        expect(buildSandboxRuntimeConfig(createConfig(), sessionPath).filesystem?.allowWrite)
            .toContain('/private/tmp');
    });

    it.runIf(process.platform === 'darwin')('generates a profile with a working temporary root and retained hook protection', () => {
        const config = buildSandboxRuntimeConfig(createConfig({ allowGitConfig: true }), sessionPath);
        const deny = macGetMandatoryDenyPatterns(config.filesystem?.allowGitConfig);
        expect(deny).toContain('**/.git/hooks/**');
        expect(deny).not.toContain('**/.git/config');
        expect(deny).toContain('**/.gitconfig');
        const wrapped = wrapCommandWithSandboxMacOS({
            command: 'true', needsNetworkRestriction: false, readConfig: undefined,
            writeConfig: { allowOnly: config.filesystem!.allowWrite, denyWithinAllow: config.filesystem!.denyWrite },
            allowGitConfig: config.filesystem?.allowGitConfig,
        });
        expect(wrapped).toContain('/private/tmp');
    });

    it('builds strict filesystem isolation', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({ sessionIsolation: 'strict' }),
            sessionPath,
        );

        expect(runtimeConfig.allowPty).toBe(true);
        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            resolve(sessionPath),
            temporaryRoot,
            ...expectedSharedAgentStatePaths(),
        ]);
    });

    it('builds workspace isolation using workspaceRoot fallback to sessionPath', () => {
        const withWorkspaceRoot = buildSandboxRuntimeConfig(createConfig(), sessionPath);
        expect(withWorkspaceRoot.filesystem?.allowWrite).toEqual([
            `${homedir()}/projects`,
            resolve(sessionPath),
            temporaryRoot,
            ...expectedSharedAgentStatePaths(),
        ]);

        const withoutWorkspaceRoot = buildSandboxRuntimeConfig(
            createConfig({ workspaceRoot: undefined }),
            sessionPath,
        );
        expect(withoutWorkspaceRoot.filesystem?.allowWrite).toEqual([
            resolve(sessionPath),
            temporaryRoot,
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
            temporaryRoot,
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
        expect(blocked.enableWeakerNetworkIsolation).toBeUndefined();

        const allowed = buildSandboxRuntimeConfig(
            createConfig({ networkMode: 'allowed' }),
            sessionPath,
        );
        expect(allowed.network?.allowedDomains).toBeUndefined();
        expect(allowed.network?.deniedDomains).toEqual([]);
        expect(allowed.enableWeakerNetworkIsolation).toBe(true);
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

describe('buildSandboxRuntimeConfig with a linked git worktree', () => {
    const createdRoots: string[] = [];

    afterEach(() => {
        for (const root of createdRoots.splice(0)) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    function createLinkedWorktree(): { worktreePath: string; commonGitDir: string } {
        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-worktree-'));
        createdRoots.push(root);

        const mainRepo = join(root, 'main-repo');
        const worktreePath = join(root, 'linked-worktree');
        execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', mainRepo]);
        execFileSync('git', ['-C', mainRepo, 'config', 'user.name', 'Happy Test']);
        execFileSync('git', ['-C', mainRepo, 'config', 'user.email', 'happy-test@example.com']);
        writeFileSync(join(mainRepo, 'tracked.txt'), 'initial\n');
        execFileSync('git', ['-C', mainRepo, 'add', 'tracked.txt']);
        execFileSync('git', ['-C', mainRepo, 'commit', '-m', 'initial']);
        execFileSync('git', ['-C', mainRepo, 'worktree', 'add', '-b', 'linked', worktreePath]);

        return { worktreePath, commonGitDir: realpathSync(join(mainRepo, '.git')) };
    }

    it('adds the resolved common gitdir to allowWrite so git add/fetch/commit can write index.lock, FETCH_HEAD, and refs', () => {
        const { worktreePath, commonGitDir } = createLinkedWorktree();

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), worktreePath);

        expect(runtimeConfig.filesystem?.allowWrite).toContain(commonGitDir);
    });

    it('does not trust an arbitrary gitdir when no commondir file exists', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-worktree-'));
        createdRoots.push(root);
        const worktreePath = join(root, 'linked-worktree');
        const worktreeGitDir = join(root, 'main-repo', '.git', 'worktrees', 'linked-worktree');
        mkdirSync(worktreeGitDir, { recursive: true });
        mkdirSync(worktreePath, { recursive: true });
        writeFileSync(join(worktreePath, '.git'), `gitdir: ${worktreeGitDir}\n`);

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), worktreePath);

        expect(runtimeConfig.filesystem?.allowWrite).not.toContain(worktreeGitDir);
    });

    it('does not widen allowWrite for an attacker-selected gitdir', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-worktree-'));
        createdRoots.push(root);
        writeFileSync(join(root, '.git'), 'gitdir: /\n');

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig({ sessionIsolation: 'strict' }), root);

        expect(runtimeConfig.filesystem?.allowWrite).not.toContain('/');
    });

    it('does not throw or widen allowWrite when the gitfile is unreadable', () => {
        const { worktreePath, commonGitDir } = createLinkedWorktree();
        const gitFile = join(worktreePath, '.git');
        chmodSync(gitFile, 0);

        try {
            const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), worktreePath);
            expect(runtimeConfig.filesystem?.allowWrite).not.toContain(commonGitDir);
        } finally {
            chmodSync(gitFile, 0o600);
        }
    });

    it('does not widen allowWrite when commondir is tampered with', () => {
        const { worktreePath } = createLinkedWorktree();
        const gitFileValue = readFileSync(join(worktreePath, '.git'), 'utf8');
        const worktreeGitDir = gitFileValue.match(/^gitdir:\s*(.+)\s*$/)?.[1];
        expect(worktreeGitDir).toBeDefined();
        writeFileSync(join(worktreeGitDir!, 'commondir'), '/\n');

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig({ sessionIsolation: 'strict' }), worktreePath);

        expect(runtimeConfig.filesystem?.allowWrite).not.toContain('/');
    });

    it('discovers linked-worktree metadata when the session starts in a subdirectory', () => {
        const { worktreePath, commonGitDir } = createLinkedWorktree();
        const nestedSessionPath = join(worktreePath, 'nested');
        mkdirSync(nestedSessionPath);

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), nestedSessionPath);

        expect(runtimeConfig.filesystem?.allowWrite).toContain(commonGitDir);
    });

    it('does not add anything for a regular checkout where .git is a directory', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-worktree-'));
        createdRoots.push(root);
        mkdirSync(join(root, '.git'), { recursive: true });

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig({ workspaceRoot: undefined }), root);

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            resolve(root),
            temporaryRoot,
            ...expectedSharedAgentStatePathsFor(root),
        ]);
    });

    it('does not throw and adds nothing when there is no .git at all', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-worktree-'));
        createdRoots.push(root);

        const runtimeConfig = buildSandboxRuntimeConfig(createConfig({ workspaceRoot: undefined }), root);

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            resolve(root),
            temporaryRoot,
            ...expectedSharedAgentStatePathsFor(root),
        ]);
    });
});

function expectedSharedAgentStatePathsFor(sessionPathForTest: string): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';
    const expand = (pathValue: string) => {
        const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
        return isAbsolute(expandedHome) ? expandedHome : resolve(sessionPathForTest, expandedHome);
    };
    return [...new Set([expand(codexHome), expand(claudeConfigDir)])];
}
// Run from a macOS host test process. An inherited sandbox cannot be relaxed by a child profile.
it.skipIf(process.platform !== 'darwin' || Boolean(process.env.CODEX_SANDBOX))(
    'allows init, clone and submodule update in a managed worktree while denying hooks and sibling writes',
    async () => {
        const run = promisify(execFile);
        const root = await mkdtemp(join(process.cwd(), '.tmp-git-sandbox-'));
        const repository = join(root, 'repo');
        const source = join(root, 'source');
        const worktree = join(repository, '.aplus/worktrees/task');
        const gitDirectory = join(repository, '.git');
        const env = { ...process.env, GIT_TEMPLATE_DIR: '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
        const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
        const git = (cwd: string, args: string[]) => run('git', [
            '-c', 'user.name=Sandbox Test', '-c', 'user.email=sandbox@example.invalid', ...args,
        ], { cwd, env });
        try {
            await mkdir(source);
            await mkdir(repository);
            await git(source, ['init']);
            await writeFile(join(source, 'file.txt'), 'fixture');
            await git(source, ['add', 'file.txt']);
            await git(source, ['commit', '-m', 'fixture']);
            await git(repository, ['init']);
            await git(repository, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'vendor/library']);
            await git(repository, ['commit', '-am', 'submodule']);
            await git(repository, ['worktree', 'add', '-b', 'sandbox-test', worktree]);
            const config = buildSandboxRuntimeConfig(createConfig({
                workspaceRoot: undefined, allowGitConfig: true, denyReadPaths: [],
                extraWritePaths: [gitDirectory],
                denyWritePaths: ['.env', `${gitDirectory}/hooks`, `${gitDirectory}/**/hooks/**`],
            }), worktree);
            const sandbox = (args: string[]) => run('sh', ['-c', wrapCommandWithSandboxMacOS({
                command: args.map(quote).join(' '), needsNetworkRestriction: false, readConfig: undefined,
                writeConfig: { allowOnly: config.filesystem!.allowWrite, denyWithinAllow: config.filesystem!.denyWrite },
                allowGitConfig: config.filesystem?.allowGitConfig,
            })], { cwd: worktree, env });
            await sandbox(['git', 'init', 'new-repository']);
            await sandbox(['git', 'clone', source, 'cloned-repository']);
            await sandbox(['git', 'config', '--local', 'sandbox.test', 'enabled']);
            await sandbox(['git', '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init']);
            expect((await git(worktree, ['config', '--get', 'sandbox.test'])).stdout.trim()).toBe('enabled');
            await expect(sandbox(['touch', join(root, 'outside.txt')])).rejects.toThrow();
            await expect(sandbox(['touch', join(worktree, '.env')])).rejects.toThrow();
            await expect(sandbox(['mkdir', '-p', join(gitDirectory, 'hooks')])).rejects.toThrow();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }, 30_000,
);

describe('filterCredentialsFromEnv', () => {
    it('removes inherited GitHub and cloud credentials while preserving runtime variables', () => {
        expect(filterCredentialsFromEnv({
            GH_TOKEN: 'github-secret',
            AWS_ACCESS_KEY_ID: 'aws-secret',
            PATH: '/usr/bin',
            APLUS_AGENT_TASK_ID: 'task-1',
        })).toEqual({
            PATH: '/usr/bin',
            APLUS_AGENT_TASK_ID: 'task-1',
        });
    });
});

// 공유 머신에서 세션 config 는 사용자·프로젝트가 고칠 수 있는 값이다. enabled 만
// 확인하면 denyReadPaths:[] / customWritePaths:['/'] 로 격리를 그대로 벗을 수 있다.
// mandatory 머신에서는 신뢰 floor 가 세션 config 위에 강제된다.
describe('buildSandboxRuntimeConfig on a mandatory machine', () => {
    it('denies read and write on the Happy home even when the session config clears them', () => {
        const built = buildSandboxRuntimeConfig(
            createConfig({ denyReadPaths: [], denyWritePaths: [] }),
            sessionPath,
            'mandatory',
        );

        expect(built.filesystem.denyRead).toContain(configuration.daemonHappyHomeDir);
        expect(built.filesystem.denyWrite).toContain(configuration.daemonHappyHomeDir);
        // 세션이 옮겨 쓰는 HAPPY_HOME_DIR 을 가리면 자기 자격증명까지 가려진다.
        expect(built.filesystem.denyRead).not.toContain(configuration.happyHomeDir);
    });

    it('keeps the session own deny paths alongside the floor', () => {
        const built = buildSandboxRuntimeConfig(
            createConfig({ denyReadPaths: ['~/.ssh'] }),
            sessionPath,
            'mandatory',
        );

        expect(built.filesystem.denyRead).toContain(resolveLikeRuntime('~/.ssh'));
        expect(built.filesystem.denyRead).toContain(configuration.daemonHappyHomeDir);
    });

    // allowWrite 가 '/' 나 홈 루트면 floor 밖의 다른 사용자 워크스페이스와
    // PATH 상의 실행 파일까지 쓰기 가능해진다 — 클램프가 아니라 거절이다.
    it('refuses a filesystem-root write scope', () => {
        expect(() => buildSandboxRuntimeConfig(
            createConfig({ sessionIsolation: 'custom', customWritePaths: ['/'] }),
            sessionPath,
            'mandatory',
        )).toThrow(/unsafe-write-scope/);
    });

    it('refuses a home-root write scope', () => {
        expect(() => buildSandboxRuntimeConfig(
            createConfig({ sessionIsolation: 'custom', customWritePaths: ['~'] }),
            sessionPath,
            'mandatory',
        )).toThrow(/unsafe-write-scope/);
    });

    it('leaves an owner-choice machine exactly as before', () => {
        const config = createConfig({ denyReadPaths: [], denyWritePaths: [] });

        expect(buildSandboxRuntimeConfig(config, sessionPath))
            .toEqual(buildSandboxRuntimeConfig(config, sessionPath, 'owner-choice'));
        expect(buildSandboxRuntimeConfig(config, sessionPath).filesystem.denyRead)
            .toEqual([]);
    });
});
