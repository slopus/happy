import chalk from 'chalk';
import { existsSync, rmSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require_ = createRequire(import.meta.url);

interface ServerOptions {
    port: number;
    host: string;
    reset: boolean;
    persistServerUrl: boolean;
    masterSecret?: string;
}

interface ServerArtifacts {
    /** Path to the executable (or tsx entrypoint) used to run the server. */
    command: string;
    /** Extra args (e.g. tsx + script path for source mode). */
    prefixArgs: string[];
    /** Working directory for the spawn. */
    cwd: string;
    /** True when running the bundled bun binary; false when running from monorepo source. */
    bundled: boolean;
}

export async function handleServerCommand(args: string[]): Promise<void> {
    const opts = parseArgs(args);
    if (opts === null) return;

    const dataDir = path.join(configuration.happyHomeDir, 'server-data');
    const pgliteDir = path.join(dataDir, 'pglite');
    const secretFile = path.join(dataDir, 'master-secret');

    if (opts.reset && existsSync(dataDir)) {
        console.log(chalk.yellow(`Wiping ${dataDir}...`));
        rmSync(dataDir, { recursive: true, force: true });
    }

    mkdirSync(dataDir, { recursive: true });

    const masterSecret = opts.masterSecret ?? loadOrCreateMasterSecret(secretFile);

    const artifacts = resolveServerArtifacts();
    if (!artifacts) {
        console.error(chalk.red('Could not locate the happy-server bundle or source.'));
        console.error(chalk.gray('  Expected one of:'));
        console.error(chalk.gray(`    - bundled binary at ${path.join(__dirname, '..', '..', 'tools', 'server', currentPlatform(), bundledBinaryName())}`));
        console.error(chalk.gray('    - sibling packages/happy-server/sources/standalone.ts in the monorepo'));
        process.exit(1);
    }

    const serverUrl = `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${opts.port}`;
    const staticDir = findWebappDir();

    console.log(chalk.cyan(`\n  happy server`));
    console.log(chalk.gray(`  data dir:   ${dataDir}`));
    console.log(chalk.gray(`  server url: ${serverUrl}`));
    console.log(chalk.gray(`  mode:       ${artifacts.bundled ? 'bundled' : 'source (dev)'}`));
    if (staticDir) {
        console.log(chalk.gray(`  webapp:     ${staticDir}`));
    } else {
        console.log(chalk.yellow('  webapp:     (no build) — API only. Run `pnpm bundle:webapp` to build.'));
    }
    console.log();

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        DB_PROVIDER: 'pglite',
        DATA_DIR: dataDir,
        PGLITE_DIR: pgliteDir,
        HANDY_MASTER_SECRET: masterSecret,
        PORT: String(opts.port),
        HOST: opts.host,
    };
    if (staticDir) env.HAPPY_STATIC_DIR = staticDir;
    env.HAPPY_INJECT_HTML_CONFIG = JSON.stringify({
        serverUrl,
        disableAnalytics: true,
    });

    console.log(chalk.gray('Running migrations...'));
    await spawnAndWait(artifacts, env, ['migrate']);

    if (opts.persistServerUrl) {
        await updateSettings(current => ({ ...current, serverUrl }));
        console.log(chalk.gray(`Wrote serverUrl=${serverUrl} to ${configuration.settingsFile}`));
    }

    console.log(chalk.gray('Starting server...'));
    const child = spawnBackground(artifacts, env, ['serve']);

    console.log();
    console.log(chalk.green.bold(`✓ happy-server starting at ${serverUrl}`));
    if (staticDir) {
        console.log(chalk.green(`  Open ${serverUrl} in your browser.`));
    }
    if (opts.persistServerUrl) {
        console.log(chalk.gray('  happy CLI + daemon will use this server automatically (settings.serverUrl).'));
    }
    console.log(chalk.gray('  Press Ctrl-C to stop.'));
    console.log();

    const forwardSignal = (sig: NodeJS.Signals) => {
        if (!child.killed) child.kill(sig);
    };
    process.on('SIGINT', () => forwardSignal('SIGINT'));
    process.on('SIGTERM', () => forwardSignal('SIGTERM'));

    await new Promise<void>(resolve => {
        child.on('exit', code => {
            console.log(chalk.gray(`\nhappy-server exited (code ${code ?? 0})`));
            resolve();
        });
    });
    process.exit(0);
}

function parseArgs(args: string[]): ServerOptions | null {
    let port = 3005;
    let host = '127.0.0.1';
    let reset = false;
    let persistServerUrl = true;
    let masterSecret: string | undefined;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-h' || arg === '--help') {
            showHelp();
            return null;
        } else if (arg === '--port' || arg === '-p') {
            port = parseInt(args[++i], 10);
            if (Number.isNaN(port)) {
                console.error(chalk.red('Invalid --port'));
                process.exit(1);
            }
        } else if (arg === '--host') {
            host = args[++i];
        } else if (arg === '--reset') {
            reset = true;
        } else if (arg === '--no-persist') {
            persistServerUrl = false;
        } else if (arg === '--master-secret') {
            masterSecret = args[++i];
        } else {
            console.error(chalk.red(`Unknown arg: ${arg}`));
            showHelp();
            process.exit(1);
        }
    }

    return { port, host, reset, persistServerUrl, masterSecret };
}

function showHelp() {
    console.log(`
${chalk.bold('happy server')} - Run Happy sync server + web app locally (self-host)

${chalk.bold('Usage:')}
  happy server [--port 3005] [--host 127.0.0.1] [--reset] [--no-persist]

${chalk.bold('Options:')}
  --port, -p <n>        Port to listen on (default: 3005)
  --host <ip>           Host to bind (default: 127.0.0.1)
  --reset               Wipe local server data before starting
  --no-persist          Don't write serverUrl into settings.json
  --master-secret <hex> Use a specific master secret (default: auto-generated)

${chalk.bold('Notes:')}
  - Stores data in ${chalk.cyan('$HAPPY_HOME_DIR/server-data/')}
  - Writes ${chalk.cyan('settings.serverUrl')} so happy CLI + daemon point at it automatically
  - Open ${chalk.cyan('http://127.0.0.1:<port>')} for the web app (if bundled)
`);
}

function loadOrCreateMasterSecret(file: string): string {
    if (existsSync(file)) {
        return readFileSync(file, 'utf8').trim();
    }
    const secret = randomBytes(32).toString('hex');
    writeFileSync(file, secret, { mode: 0o600 });
    return secret;
}

function currentPlatform(): string {
    return `${process.arch}-${process.platform}`;
}

/**
 * Path to tools/<name>/ shipped alongside the CLI.
 *
 * pkgroll bundles into dist/, so __dirname at runtime is .../happy-cli/dist; tools/ lives
 * at .../happy-cli/tools. In rare layouts (e.g. running un-built source via tsx from src/
 * commands/), tools/ sits at .../happy-cli/tools and __dirname is .../happy-cli/src/commands,
 * so we walk up until we find a directory that contains tools/.
 */
function resolveToolsPath(name: string): string {
    let dir = __dirname;
    for (let i = 0; i < 5; i++) {
        const candidate = path.join(dir, 'tools', name);
        if (existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return path.resolve(__dirname, '..', 'tools', name);
}

function bundledBinaryName(): string {
    return process.platform === 'win32' ? 'happy-server.exe' : 'happy-server';
}

function ensureExecutable(file: string): void {
    if (process.platform === 'win32') return;
    try {
        const mode = statSync(file).mode;
        // 0o111 = any execute bit. npm tarballs sometimes lose the executable bit
        // (mode preservation differs across npm/pnpm/yarn versions), so re-apply it here.
        if ((mode & 0o111) === 0) chmodSync(file, mode | 0o755);
    } catch {
        // best-effort — spawn will surface a clearer error if this fails
    }
}

/**
 * Resolves the artifacts needed to spawn happy-server.
 *
 * Order:
 *   1. Bundled binary at tools/server/<platform>/happy-server (shipped with npm package)
 *   2. Source-mode fallback for monorepo dev: ../happy-server/sources/standalone.ts via tsx
 */
function resolveServerArtifacts(): ServerArtifacts | undefined {
    const toolsRoot = resolveToolsPath('server');
    const binDir = path.join(toolsRoot, currentPlatform());
    const binary = path.join(binDir, bundledBinaryName());
    if (existsSync(binary)) {
        ensureExecutable(binary);
        return { command: binary, prefixArgs: [], cwd: binDir, bundled: true };
    }

    const sourceEntry = findSourceStandalone();
    if (sourceEntry) {
        const tsx = findTsxBinary(path.dirname(path.dirname(sourceEntry)));
        const useNode = tsx !== 'tsx';
        return {
            command: useNode ? process.execPath : 'tsx',
            prefixArgs: useNode ? [tsx, sourceEntry] : [sourceEntry],
            cwd: path.dirname(path.dirname(sourceEntry)),
            bundled: false,
        };
    }

    return undefined;
}

function findSourceStandalone(): string | undefined {
    const candidates = [
        path.resolve(__dirname, '../../../happy-server/sources/standalone.ts'),
        path.resolve(__dirname, '../../happy-server/sources/standalone.ts'),
        path.resolve(process.cwd(), 'packages/happy-server/sources/standalone.ts'),
        path.resolve(process.cwd(), '../happy-server/sources/standalone.ts'),
    ];
    for (const c of candidates) {
        if (existsSync(c)) return c;
    }
    return undefined;
}

function findWebappDir(): string | undefined {
    const bundled = resolveToolsPath('webapp');
    if (existsSync(path.join(bundled, 'index.html'))) return bundled;

    const candidates = [
        path.resolve(__dirname, '../../../happy-app/dist'),
        path.resolve(__dirname, '../../happy-app/dist'),
        path.resolve(process.cwd(), 'packages/happy-app/dist'),
    ];
    for (const c of candidates) {
        if (existsSync(path.join(c, 'index.html'))) return c;
    }
    return undefined;
}

function findTsxBinary(cwd: string): string {
    try {
        return require_.resolve('tsx/cli', { paths: [cwd] });
    } catch {
        return 'tsx';
    }
}

async function spawnAndWait(art: ServerArtifacts, env: NodeJS.ProcessEnv, args: string[]): Promise<void> {
    const cmdArgs = [...art.prefixArgs, ...args];
    await new Promise<void>((resolve, reject) => {
        const child = spawn(art.command, cmdArgs, { cwd: art.cwd, env, stdio: 'inherit' });
        child.on('error', reject);
        child.on('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`happy-server ${args[0]} exited with code ${code}`));
        });
    });
}

function spawnBackground(art: ServerArtifacts, env: NodeJS.ProcessEnv, args: string[]): ChildProcess {
    const cmdArgs = [...art.prefixArgs, ...args];
    return spawn(art.command, cmdArgs, { cwd: art.cwd, env, stdio: 'inherit' });
}
