import { runInNewContext } from 'node:vm'
import { cswapAtLeastPinned, parseCswapVersion } from '../../src/daemon/claudeSetupToken'
import { isSupportedCodexMultiAuthVersion } from '../../src/utils/codexMultiAuthVersions'
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'install-companion-tools.cjs');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
    shouldInstallCompanionTools,
    hasSupportedCodexMultiAuth,
    MINIMUM_CODEX_MULTI_AUTH_VERSION,
    isSupportedCodexMultiAuthVersion: scriptAccepts,
    shouldInstallUvTools,
    shellQuote,
    CODEX_MULTI_AUTH_VERSION,
    CLAUDE_SWAP_PACKAGE,
    CLAUDE_SWAP_VERSION,
    COMPANION_INSTALL_TIMEOUT_MS,
} = require(SCRIPT);

function pinnedVersionIn(sourceFile: string, constantName: string): string {
    const source = readFileSync(join(__dirname, '..', '..', 'src', sourceFile), 'utf8');
    const match = source.match(new RegExp(`const ${constantName} = '([^']+)'`));
    if (!match) throw new Error(`No ${constantName} in src/${sourceFile}`);
    return match[1];
}

describe('shouldInstallCompanionTools', () => {
    it('installs for a global CLI install', () => {
        expect(shouldInstallCompanionTools({ npm_config_global: 'true' })).toBe(true);
    });

    // A local dependency install must not put two extra binaries on PATH.
    // `npm i --location=global` is a real global install, but it sets only
    // npm_config_location — reading npm_config_global alone skipped that user.
    it('installs for a --location=global install', () => {
        expect(shouldInstallCompanionTools({ npm_config_location: 'global' })).toBe(true);
    });

    it('still skips CI for a --location=global install', () => {
        expect(shouldInstallCompanionTools({ npm_config_location: 'global', CI: 'true' })).toBe(false);
    });

    it('skips a --location=user install', () => {
        expect(shouldInstallCompanionTools({ npm_config_location: 'user' })).toBe(false);
    });

    it('skips when the install is not global', () => {
        expect(shouldInstallCompanionTools({})).toBe(false);
        expect(shouldInstallCompanionTools({ npm_config_global: 'false' })).toBe(false);
    });

    // pnpm runs this package's postinstall during a workspace install of the
    // monorepo and leaves npm_config_global unset, so contributors never get
    // the companion CLIs pushed onto their machine by `pnpm install`.
    it('skips a pnpm workspace install, which leaves npm_config_global unset', () => {
        expect(shouldInstallCompanionTools({ npm_config_global: undefined })).toBe(false);
    });

    // cli-smoke-test.yml and the post-publish check in docs/happy-cli-release.md
    // both do a real `npm install -g` of this package. They verify the artifact
    // and must not start depending on two unrelated registries.
    it('skips under CI even for a global install', () => {
        expect(shouldInstallCompanionTools({ npm_config_global: 'true', CI: 'true' })).toBe(false);
    });

    it('treats an empty CI value as not set', () => {
        expect(shouldInstallCompanionTools({ npm_config_global: 'true', CI: '' })).toBe(true);
    });

    // guard-publish-artifact.cjs sets this for its smoke install: the companion
    // packages would otherwise land in the prefix whose dependency closure it
    // asserts, turning a third-party package's problems into a Happy failure.
    it('skips when HAPPY_SKIP_COMPANION_TOOLS is set', () => {
        expect(shouldInstallCompanionTools({
            npm_config_global: 'true',
            HAPPY_SKIP_COMPANION_TOOLS: '1',
        })).toBe(false);
    });

    // `CI=false` is how people explicitly say "this is not CI"; reading it as a
    // CI marker would silently withhold the companion CLIs from a real install.
    it('treats CI=false and CI=0 as not CI', () => {
        expect(shouldInstallCompanionTools({ npm_config_global: 'true', CI: 'false' })).toBe(true);
        expect(shouldInstallCompanionTools({ npm_config_global: 'true', CI: '0' })).toBe(true);
    });
});

describe('shouldInstallUvTools', () => {
    it('installs when the user runs the install themselves', () => {
        expect(shouldInstallUvTools({})).toBe(true);
    });

    // npm's global prefix is shared, so codex-multi-auth lands next to happy
    // either way. uv resolves its tool directory from HOME, which sudo points
    // at root — claude-swap would install somewhere the real user cannot reach
    // while the log still claims success.
    it('skips under sudo, where uv would install into root\'s home', () => {
        expect(shouldInstallUvTools({ SUDO_USER: 'justin' })).toBe(false);
    });
});

// The packaged postinstall cannot import TypeScript; enforce parity with runtime policy.
describe('CODEX_MULTI_AUTH_VERSION', () => {
    it('matches the runtime installation default', () => {
        expect(CODEX_MULTI_AUTH_VERSION).toBe(pinnedVersionIn('utils/codexMultiAuthVersions.ts', 'CODEX_MULTI_AUTH_VERSION'));
    });

    it('matches the runtime minimum version', () => {
        expect(MINIMUM_CODEX_MULTI_AUTH_VERSION).toBe(pinnedVersionIn('utils/codexMultiAuthVersions.ts', 'MINIMUM_CODEX_MULTI_AUTH_VERSION'));
    });

    it.each(['2.15.0', '2.16.0', '2.17.0', '2.19.0', '2.100.0', '3.0.0', '2.19.0-beta.1', 'unknown'])('accepts %s exactly when the runtime does', (version) => {
        expect(scriptAccepts(version)).toBe(isSupportedCodexMultiAuthVersion(version));
    });
});

// The installer pin must be accepted by the runtime, which also preserves newer marked builds.
describe('CLAUDE_SWAP_VERSION', () => {
    it('matches the version the daemon runtime pins', () => {
        expect(CLAUDE_SWAP_VERSION).toBe(pinnedVersionIn('daemon/aiCredentialRuntime.ts', 'CLAUDE_SWAP_VERSION'));
    });

    it('is the version ensureClaudeSwap accepts from `cswap --version`', () => {
      expect(cswapAtLeastPinned(parseCswapVersion(`cswap ${CLAUDE_SWAP_VERSION}`))).toBe(true);
      expect(cswapAtLeastPinned(parseCswapVersion('cswap 0.27.0'))).toBe(true);
      expect(cswapAtLeastPinned(parseCswapVersion('cswap 0.27.0b0'))).toBe(false);
      expect(cswapAtLeastPinned(parseCswapVersion('cswap 0.26.0'))).toBe(false);
    });
});

// The failure path prints a command for the user to paste. `>=3.12` is a
// redirection in a shell: zsh fails with "3.12 not found" and bash writes a
// file named `=3.12` while dropping the --python value.
describe('shellQuote', () => {
    it('quotes a value a shell would read as a redirection', () => {
        expect(shellQuote('>=3.12')).toBe("'>=3.12'");
    });

    it('leaves ordinary arguments alone', () => {
        expect(shellQuote('install')).toBe('install');
        expect(shellQuote('-g')).toBe('-g');
        expect(shellQuote(`${CLAUDE_SWAP_PACKAGE}==${CLAUDE_SWAP_VERSION}`)).toBe(`${CLAUDE_SWAP_PACKAGE}==${CLAUDE_SWAP_VERSION}`);
    });

    it('escapes an embedded single quote', () => {
        expect(shellQuote("a'b")).toBe("'a'\\''b'");
    });
});

// An unbounded child would hang `npm install -g happy` itself. aiCredentialRuntime
// runs these same two install commands under timeoutMs, and a tighter bound here
// would fail on links where Happy's own install would have succeeded.
describe('COMPANION_INSTALL_TIMEOUT_MS', () => {
    it('matches the timeout the daemon runtime allows these installs', () => {
        const source = readFileSync(join(__dirname, '..', '..', 'src', 'daemon', 'aiCredentialRuntime.ts'), 'utf8');
        const timeouts = [...source.matchAll(/timeoutMs:\s*([0-9_]+)/g)]
            .map((match) => Number(match[1].replace(/_/g, '')));
        expect(timeouts.length).toBeGreaterThan(0);
        expect(COMPANION_INSTALL_TIMEOUT_MS).toBe(Math.max(...timeouts));
    });
});

describe('preserving a compatible companion installation', () => {
    it.each(['2.16.0', '2.17.0', '2.19.0'])('keeps matching CLI/global package %s', (version) => {
        const run = vi.fn((command: string) => ({ status: 0, stdout: command === 'npm' ? '/global' : version }));
        expect(hasSupportedCodexMultiAuth(run, () => JSON.stringify({ version }))).toBe(true);
    });
    it.each(['2.15.0', '2.8.4'])('does not accept a runtime older than the minimum: %s', (version) => {
        expect(hasSupportedCodexMultiAuth(() => ({ status: 0, stdout: version }), () => JSON.stringify({ version }))).toBe(false);
    });
    it('does not keep conflicting executable and global package versions', () => {
        expect(hasSupportedCodexMultiAuth((command: string) => ({ status: 0, stdout: command === 'npm' ? '/global' : '2.17.0' }), () => JSON.stringify({ version: '2.16.0' }))).toBe(false);
    });
    it('treats command failures as unavailable', () => {
        expect(hasSupportedCodexMultiAuth(() => ({ status: 1, stdout: '2.17.0' }), () => '{}')).toBe(false);
    });
});

it.each(['2.17.0', '2.19.0', '2.15.0'])('postinstall keeps only compatible existing runtime %s', (version) => {
    const run = vi.fn((command: string, args: string[]) => ({
        status: 0, stdout: command === 'npm' && args[0] === 'root' ? '/global' : version,
    }));
    const module = { exports: {} };
    const requireMock = Object.assign((name: string) => name === 'node:child_process' ? { spawnSync: run }
        : name === 'node:fs' ? { readFileSync: () => JSON.stringify({ version }) }
        : { join }, { main: module });
    runInNewContext(readFileSync(SCRIPT, 'utf8'), {
        require: requireMock, module,
        process: { platform: 'linux', env: { npm_config_global: 'true' } },
        console: { log() {}, warn() {} },
    });
    expect(run.mock.calls.some(([command, args]) => command === 'npm' && args[0] === 'install')).toBe(version === '2.15.0');
});
