import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';
import { configuration } from '@/configuration';
import {
    MandatorySandboxError,
    isUnsafeMandatoryWriteScope,
    sandboxTrustFloorPaths,
    type SandboxPolicyMode,
} from './sandboxPolicy';

/**
 * $HOME 은 spawn 페이로드로 올 수 있으므로 floor 기준으로 쓸 수 없다.
 * passwd 항목을 먼저 보고, 그것을 못 읽는 환경에서만 homedir() 로 물러난다.
 */
function trustedHomeDir(): string {
    try {
        return userInfo().homedir || homedir();
    } catch {
        return homedir();
    }
}

function expandPath(pathValue: string, sessionPath: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    // sandbox-runtime 0.0.37 recognises /tmp/... but misses the /tmp alias itself.
    if (process.platform === 'darwin' && resolve(sessionPath, expandedHome) === '/tmp'
        && realpathSync('/tmp') === '/private/tmp') {
        return '/private/tmp';
    }
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }

    return resolve(sessionPath, expandedHome);
}

/**
 * A linked `git worktree` keeps its own gitdir (`.git/worktrees/<name>`) outside the
 * worktree's own directory tree — `git add`/`fetch`/`commit` write index.lock, FETCH_HEAD,
 * and refs there. Without this, those writes are outside every allowWrite root and fail
 * with EPERM even though the session's own files are writable.
 */
function resolveGitWorktreeWritableRoot(sessionPath: string): string | undefined {
    try {
        const gitEnv = { ...process.env };
        delete gitEnv.GIT_DIR;
        delete gitEnv.GIT_WORK_TREE;
        delete gitEnv.GIT_COMMON_DIR;
        gitEnv.GIT_CONFIG_NOSYSTEM = '1';
        gitEnv.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
        gitEnv.GIT_CONFIG_COUNT = '0';

        const canonicalSessionPath = realpathSync(sessionPath);
        const worktreeRoot = execFileSync(
            'git',
            ['-C', canonicalSessionPath, 'rev-parse', '--show-toplevel'],
            { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
        const canonicalWorktreeRoot = realpathSync(worktreeRoot);
        const sessionRelativeToRoot = relative(canonicalWorktreeRoot, canonicalSessionPath);
        if (sessionRelativeToRoot === '..'
            || sessionRelativeToRoot.startsWith(`..${sep}`)
            || isAbsolute(sessionRelativeToRoot)) {
            return undefined;
        }

        const gitPath = resolve(canonicalWorktreeRoot, '.git');
        if (!statSync(gitPath).isFile()) {
            // A plain directory `.git` (main checkout) is already inside the worktree.
            return undefined;
        }

        const gitFileMatch = readFileSync(gitPath, 'utf8').match(/^gitdir:\s*([^\r\n]+)\r?\n?$/);
        if (!gitFileMatch) {
            return undefined;
        }
        const worktreeGitDirPath = isAbsolute(gitFileMatch[1])
            ? gitFileMatch[1]
            : resolve(dirname(gitPath), gitFileMatch[1]);
        const canonicalWorktreeGitDir = realpathSync(worktreeGitDirPath);
        if (!statSync(canonicalWorktreeGitDir).isDirectory()) {
            return undefined;
        }
        const gitReportedWorktreeGitDir = execFileSync(
            'git',
            ['-C', canonicalSessionPath, 'rev-parse', '--absolute-git-dir'],
            { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
        if (realpathSync(gitReportedWorktreeGitDir) !== canonicalWorktreeGitDir) {
            return undefined;
        }

        const backlinkValue = readFileSync(resolve(canonicalWorktreeGitDir, 'gitdir'), 'utf8').trim();
        const backlinkPath = isAbsolute(backlinkValue)
            ? backlinkValue
            : resolve(canonicalWorktreeGitDir, backlinkValue);
        if (realpathSync(backlinkPath) !== realpathSync(gitPath)) {
            return undefined;
        }

        const commonDirValue = readFileSync(resolve(canonicalWorktreeGitDir, 'commondir'), 'utf8').trim();
        const commonDirPath = isAbsolute(commonDirValue)
            ? commonDirValue
            : resolve(canonicalWorktreeGitDir, commonDirValue);
        const canonicalCommonDir = realpathSync(commonDirPath);
        if (!statSync(canonicalCommonDir).isDirectory()
            || dirname(dirname(canonicalWorktreeGitDir)) !== canonicalCommonDir) {
            return undefined;
        }

        const gitReportedCommonDir = execFileSync(
            'git',
            ['-C', canonicalSessionPath, 'rev-parse', '--git-common-dir'],
            { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
        const gitReportedCommonDirPath = isAbsolute(gitReportedCommonDir)
            ? gitReportedCommonDir
            : resolve(canonicalSessionPath, gitReportedCommonDir);
        if (realpathSync(gitReportedCommonDirPath) !== canonicalCommonDir) {
            return undefined;
        }

        return canonicalCommonDir;
    } catch {
        // Invalid, unreadable, or concurrently changed Git metadata must not widen allowWrite.
        return undefined;
    }
}

function resolvePaths(paths: string[], sessionPath: string): string[] {
    return paths.map((pathValue) => expandPath(pathValue, sessionPath));
}

function getSharedAgentStatePaths(sessionPath: string): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';

    return [
        expandPath(codexHome, sessionPath),
        expandPath(claudeConfigDir, sessionPath),
    ];
}

function uniquePaths(paths: string[]): string[] {
    return [...new Set(paths)];
}

const CREDENTIAL_PATTERNS: RegExp[] = [
    /^(AWS|AZURE|GCP|GOOGLE)_/i,
    /^(ANTHROPIC|OPENAI|GEMINI)_API_KEY$/i,
    /_(SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY)$/i,
    /^(DATABASE_URL|REDIS_URL)$/i,
    /^S3_(ACCESS_KEY|SECRET_KEY|HOST)$/i,
    /^HAPPY_(MASTER_SECRET)$/i,
];

const SAFE_ENV_ALLOWLIST = new Set([
    'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'NODE_ENV', 'NODE_PATH', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX',
    'EDITOR', 'VISUAL', 'PAGER', 'TZ', 'TMPDIR',
    'WORKSPACE', 'HAPPY_PROJECT_SANDBOX_CONFIG', 'HAPPY_HOME_DIR',
    'PORT', 'HOST', 'DEBUG', 'VERBOSE',
    'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'COLORTERM', 'FORCE_COLOR', 'NO_COLOR',
]);

/**
 * Filter environment variables to remove credentials before passing to sandboxed processes.
 * Allowlisted vars always pass. Credential-pattern vars are always removed. Others pass through.
 */
export function filterCredentialsFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (SAFE_ENV_ALLOWLIST.has(key)) {
            filtered[key] = value;
            continue;
        }
        const isCredential = CREDENTIAL_PATTERNS.some(pattern => pattern.test(key));
        if (!isCredential) {
            filtered[key] = value;
        }
    }
    return filtered;
}

/**
 * mandatory 머신에서 세션 config 가 낮출 수 없는 경로들. 이 프로세스의
 * happyHomeDir 은 staged /tmp 홈일 수 있는데 그건 세션 자신의 것이므로 가리지
 * 않는다 — 데몬의 홈만 덮는다(configuration.daemonHappyHomeDir).
 */
export function resolveSandboxTrustFloor(): string[] {
    return sandboxTrustFloorPaths({
        homeDir: trustedHomeDir(),
        daemonHappyHomeDir: configuration.daemonHappyHomeDir,
    });
}

export function buildSandboxRuntimeConfig(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
    /** 생략하면 개인 머신(owner-choice)으로 본다 — sandboxPolicy.ts */
    policyMode: SandboxPolicyMode = 'owner-choice',
): SandboxRuntimeConfig {
    const extraWritePaths = resolvePaths(sandboxConfig.extraWritePaths, sessionPath);
    const sharedAgentStatePaths = getSharedAgentStatePaths(sessionPath);
    const gitWorktreeWritableRoot = resolveGitWorktreeWritableRoot(sessionPath);
    const gitWorktreePaths = gitWorktreeWritableRoot ? [gitWorktreeWritableRoot] : [];

    const allowWrite = (() => {
        switch (sandboxConfig.sessionIsolation) {
            case 'strict':
                return uniquePaths([resolve(sessionPath), ...extraWritePaths, ...sharedAgentStatePaths, ...gitWorktreePaths]);
            case 'workspace': {
                const workspaceRoot = sandboxConfig.workspaceRoot
                    ? expandPath(sandboxConfig.workspaceRoot, sessionPath)
                    : resolve(sessionPath);
                return uniquePaths([workspaceRoot, resolve(sessionPath), ...extraWritePaths, ...sharedAgentStatePaths, ...gitWorktreePaths]);
            }
            case 'custom':
                return uniquePaths([
                    ...resolvePaths(sandboxConfig.customWritePaths, sessionPath),
                    ...extraWritePaths,
                    ...sharedAgentStatePaths,
                    ...gitWorktreePaths,
                ]);
        }
    })();

    const network = (() => {
        switch (sandboxConfig.networkMode) {
            case 'blocked':
                return {
                    allowedDomains: [] as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'allowed':
                return {
                    allowedDomains: undefined as unknown as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'custom':
                return {
                    allowedDomains: sandboxConfig.allowedDomains,
                    deniedDomains: sandboxConfig.deniedDomains,
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
        }
    })();

    const enableWeakerNetworkIsolation = sandboxConfig.networkMode === 'allowed'
        ? true
        : undefined;

    const mandatory = policyMode === 'mandatory';
    if (mandatory && isUnsafeMandatoryWriteScope(allowWrite, homedir())) {
        throw new MandatorySandboxError(
            'unsafe-write-scope',
            `쓰기 범위가 파일시스템/홈 루트입니다: ${allowWrite.join(', ')}`,
        );
    }
    const floor = mandatory ? resolveSandboxTrustFloor() : [];

    return {
        allowPty: true,
        enableWeakerNetworkIsolation,
        network,
        filesystem: {
            allowGitConfig: sandboxConfig.allowGitConfig === true,
            denyRead: uniquePaths([...resolvePaths(sandboxConfig.denyReadPaths, sessionPath), ...floor]),
            allowWrite,
            denyWrite: uniquePaths([...resolvePaths(sandboxConfig.denyWritePaths, sessionPath), ...floor]),
        },
    };
}
