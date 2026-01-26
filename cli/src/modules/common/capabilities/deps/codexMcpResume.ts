import { execFile } from 'child_process';
import { constants as fsConstants } from 'fs';
import { access, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { configuration } from '@/configuration';

const execFileAsync = promisify(execFile);

export const CODEX_MCP_RESUME_NPM_PACKAGE = '@leeroy/codex-mcp-resume';
export const CODEX_MCP_RESUME_DIST_TAG = 'happy-codex-resume';
export const DEFAULT_CODEX_MCP_RESUME_INSTALL_SPEC = `${CODEX_MCP_RESUME_NPM_PACKAGE}@${CODEX_MCP_RESUME_DIST_TAG}`;

export const codexResumeInstallDir = () => join(configuration.happyHomeDir, 'tools', 'codex-mcp-resume');
export const codexResumeLegacyInstallDir = () => join(configuration.happyHomeDir, 'tools', 'codex-resume');

const codexResumeBinPath = () => {
    const binName = process.platform === 'win32' ? 'codex-mcp-resume.cmd' : 'codex-mcp-resume';
    return join(codexResumeInstallDir(), 'node_modules', '.bin', binName);
};
const codexResumeLegacyBinPath = () => {
    const binName = process.platform === 'win32' ? 'codex-mcp-resume.cmd' : 'codex-mcp-resume';
    return join(codexResumeLegacyInstallDir(), 'node_modules', '.bin', binName);
};

const codexResumeStatePath = () => join(codexResumeInstallDir(), 'install-state.json');
const codexResumeLegacyStatePath = () => join(codexResumeLegacyInstallDir(), 'install-state.json');

async function readCodexResumeState(): Promise<{ lastInstallLogPath: string | null } | null> {
    try {
        const raw = await readFile(codexResumeStatePath(), 'utf8');
        const parsed = JSON.parse(raw);
        const lastInstallLogPath = typeof parsed?.lastInstallLogPath === 'string' ? parsed.lastInstallLogPath : null;
        return { lastInstallLogPath };
    } catch {
        return null;
    }
}

async function readCodexResumeStateWithFallback(): Promise<{ lastInstallLogPath: string | null } | null> {
    const primary = await readCodexResumeState();
    if (primary) return primary;
    try {
        const raw = await readFile(codexResumeLegacyStatePath(), 'utf8');
        const parsed = JSON.parse(raw);
        const lastInstallLogPath = typeof parsed?.lastInstallLogPath === 'string' ? parsed.lastInstallLogPath : null;
        return { lastInstallLogPath };
    } catch {
        return null;
    }
}

async function writeCodexResumeState(next: { lastInstallLogPath: string | null }): Promise<void> {
    await mkdir(codexResumeInstallDir(), { recursive: true });
    await writeFile(codexResumeStatePath(), JSON.stringify(next, null, 2), 'utf8');
}

async function readInstalledNpmPackageVersion(opts: { installDir: string; packageName: string }): Promise<string | null> {
    try {
        const pkgPath = join(opts.installDir, 'node_modules', opts.packageName, 'package.json');
        const raw = await readFile(pkgPath, 'utf8');
        const parsed = JSON.parse(raw);
        const version = typeof parsed?.version === 'string' ? parsed.version : null;
        return version;
    } catch {
        return null;
    }
}

async function readNpmDistTagVersion(opts: { packageName: string; distTag: string }): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync('npm', ['view', `${opts.packageName}@${opts.distTag}`, 'version'], {
            timeout: 10_000,
            windowsHide: true,
        });
        const text = typeof stdout === 'string' ? stdout.trim() : '';
        return text || null;
    } catch {
        return null;
    }
}

async function installNpmDepToPrefix(opts: {
    installDir: string;
    installSpec: string;
    logPath: string;
}): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
    try {
        await mkdir(opts.installDir, { recursive: true });
        await mkdir(dirname(opts.logPath), { recursive: true });
        const { stdout, stderr } = await execFileAsync(
            'npm',
            ['install', '--no-audit', '--no-fund', '--prefix', opts.installDir, opts.installSpec],
            { timeout: 15 * 60_000, windowsHide: true, maxBuffer: 50 * 1024 * 1024 },
        );

        await writeFile(
            opts.logPath,
            [`# installSpec: ${opts.installSpec}`, '', '## stdout', stdout ?? '', '', '## stderr', stderr ?? ''].join('\n'),
            'utf8',
        );

        return { ok: true };
    } catch (e) {
        const message = e instanceof Error ? e.message : 'Install failed';
        try {
            await mkdir(dirname(opts.logPath), { recursive: true });
            await writeFile(opts.logPath, `# installSpec: ${opts.installSpec}\n\n${message}\n`, 'utf8');
        } catch { }
        return { ok: false, errorMessage: message };
    }
}

export async function installCodexMcpResume(installSpecOverride?: string): Promise<
    | { ok: true; logPath: string }
    | { ok: false; errorMessage: string; logPath: string }
> {
    const logPath = join(configuration.logsDir, `install-dep-codex-mcp-resume-${Date.now()}.log`);

    const installSpecRaw = typeof installSpecOverride === 'string' ? installSpecOverride.trim() : '';
    const installSpec =
        installSpecRaw ||
        (typeof process.env.HAPPY_CODEX_MCP_RESUME_INSTALL_SPEC === 'string' ? process.env.HAPPY_CODEX_MCP_RESUME_INSTALL_SPEC.trim() : '') ||
        (typeof process.env.HAPPY_CODEX_RESUME_INSTALL_SPEC === 'string' ? process.env.HAPPY_CODEX_RESUME_INSTALL_SPEC.trim() : '') ||
        DEFAULT_CODEX_MCP_RESUME_INSTALL_SPEC;

    const result = await installNpmDepToPrefix({
        installDir: codexResumeInstallDir(),
        installSpec,
        logPath,
    });

    try {
        await writeCodexResumeState({ lastInstallLogPath: logPath });
    } catch { }

    if (!result.ok) {
        const extraHelp = (() => {
            if (installSpec !== DEFAULT_CODEX_MCP_RESUME_INSTALL_SPEC) return '';
            const msg = result.errorMessage || '';
            if (!msg.includes('No matching version found')) return '';
            return `\n\nTip: the npm dist-tag "${CODEX_MCP_RESUME_DIST_TAG}" may not be set yet.\n` +
                `Publish and then run your dist-tag workflow, or temporarily install "${CODEX_MCP_RESUME_NPM_PACKAGE}@latest".`;
        })();
        return { ok: false, errorMessage: result.errorMessage + extraHelp, logPath };
    }

    return { ok: true, logPath };
}

export type CodexMcpResumeDepData = {
    installed: boolean;
    installDir: string;
    binPath: string | null;
    installedVersion: string | null;
    distTag: string;
    lastInstallLogPath: string | null;
    registry?: { ok: true; latestVersion: string | null } | { ok: false; errorMessage: string };
};

export async function getCodexMcpResumeDepStatus(opts?: {
    includeRegistry?: boolean;
    onlyIfInstalled?: boolean;
    distTag?: string;
}): Promise<CodexMcpResumeDepData> {
    const primaryBinPath = codexResumeBinPath();
    const legacyBinPath = codexResumeLegacyBinPath();
    const state = await readCodexResumeStateWithFallback();
    const accessMode = process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;

    const installed = await (async () => {
        try {
            await access(primaryBinPath, accessMode);
            return true;
        } catch {
            try {
                await access(legacyBinPath, accessMode);
                return true;
            } catch {
                return false;
            }
        }
    })();

    const binPath = installed
        ? await (async () => {
            try {
                await access(primaryBinPath, accessMode);
                return primaryBinPath;
            } catch {
                return legacyBinPath;
            }
        })()
        : null;

    const installDir = binPath?.startsWith(codexResumeLegacyInstallDir()) ? codexResumeLegacyInstallDir() : codexResumeInstallDir();
    const installedVersion = await readInstalledNpmPackageVersion({ installDir, packageName: CODEX_MCP_RESUME_NPM_PACKAGE });
    const includeRegistry = Boolean(opts?.includeRegistry);
    const onlyIfInstalled = Boolean(opts?.onlyIfInstalled);
    const distTag = typeof opts?.distTag === 'string' && opts.distTag.trim() ? opts.distTag.trim() : CODEX_MCP_RESUME_DIST_TAG;

    const registry = includeRegistry && (!onlyIfInstalled || installed)
        ? await (async () => {
            try {
                const latestVersion = await readNpmDistTagVersion({ packageName: CODEX_MCP_RESUME_NPM_PACKAGE, distTag });
                return { ok: true as const, latestVersion };
            } catch (e) {
                const msg = e instanceof Error ? e.message : 'Failed to read npm dist-tag';
                return { ok: false as const, errorMessage: msg };
            }
        })()
        : undefined;

    return {
        installed,
        binPath,
        installDir,
        installedVersion,
        distTag,
        lastInstallLogPath: state?.lastInstallLogPath ?? null,
        ...(registry ? { registry } : {}),
    };
}
