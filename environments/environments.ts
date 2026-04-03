import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import * as crypto from "crypto";
import { execSync, spawn, spawnSync } from "child_process";
import { pathToFileURL } from "url";

// ============================================================================
// Configuration
// ============================================================================

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ENVIRONMENTS_ROOT = path.join(REPO_ROOT, "environments");
const ENVIRONMENTS_DATA_DIR = path.join(ENVIRONMENTS_ROOT, "data");
const ENVIRONMENTS_DIR = path.join(ENVIRONMENTS_DATA_DIR, "envs");
const CURRENT_ENV_PATH = path.join(ENVIRONMENTS_DATA_DIR, "current.json");
const LAB_RAT_PROJECT_TEMPLATE_DIR = path.join(ENVIRONMENTS_ROOT, "lab-rat-todo-project");

// ============================================================================
// Name generation (expanded from packages/happy-app/sources/utils/generateWorktreeName.ts)
// ============================================================================

const adjectives = [
    "clever", "happy", "swift", "bright", "calm",
    "bold", "quiet", "brave", "wise", "eager",
    "gentle", "quick", "sharp", "smooth", "fresh",
    "warm", "cool", "vivid", "lucid", "nimble",
    "keen", "fair", "grand", "sleek", "merry",
    "noble", "agile", "witty", "crisp", "snug",
    "jolly", "lush", "deft", "tidy", "stout",
    "plush", "brisk", "prime", "true", "zesty",
];

const nouns = [
    "ocean", "forest", "cloud", "star", "river",
    "mountain", "valley", "bridge", "beacon", "harbor",
    "garden", "meadow", "canyon", "island", "desert",
    "glacier", "aurora", "lagoon", "summit", "prairie",
    "reef", "grove", "delta", "ridge", "oasis",
    "crater", "fjord", "marsh", "bluff", "dune",
    "spring", "atlas", "comet", "ember", "frost",
    "pearl", "cedar", "maple", "birch", "coral",
];

function randomChoice<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
}

function generateName(): string {
    return `${randomChoice(adjectives)}-${randomChoice(nouns)}`;
}

// ============================================================================
// Port allocation
// ============================================================================

function allocatePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (!addr || typeof addr === "string") {
                server.close();
                reject(new Error("Failed to allocate port"));
                return;
            }
            const port = addr.port;
            server.close(() => resolve(port));
        });
        server.on("error", reject);
    });
}

// ============================================================================
// Types
// ============================================================================

export interface EnvironmentConfig {
    name: string;
    serverPort: number;
    expoPort: number;
    createdAt: string;
    template: string;
    projectTemplate: string;
    projectPath: string;
    authenticatedWebUrl?: string;
    cliCommand?: string;
}

interface CurrentConfig {
    current: string;
}

// ============================================================================
// Helpers
// ============================================================================

function ensureEnvironmentsDir() {
    fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true });
}

function readCurrentConfig(): CurrentConfig | null {
    if (!fs.existsSync(CURRENT_ENV_PATH)) return null;
    return JSON.parse(fs.readFileSync(CURRENT_ENV_PATH, "utf-8"));
}

function writeCurrentConfig(current: string) {
    fs.mkdirSync(ENVIRONMENTS_DATA_DIR, { recursive: true });
    fs.writeFileSync(CURRENT_ENV_PATH, JSON.stringify({ current }, null, 4) + "\n");
}

function readEnvironmentConfig(name: string): EnvironmentConfig {
    const configPath = path.join(ENVIRONMENTS_DIR, name, "environment.json");
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function writeEnvironmentConfig(config: EnvironmentConfig) {
    const envDir = path.join(ENVIRONMENTS_DIR, config.name);
    const configPath = path.join(ENVIRONMENTS_DIR, config.name, "environment.json");
    fs.writeFileSync(
        configPath,
        JSON.stringify({ ...config, cliCommand: buildCliCommand(envDir) }, null, 4) + "\n"
    );
    fs.writeFileSync(
        path.join(envDir, "env.sh"),
        buildEnvSh(config.name, envDir, config.serverPort, config.expoPort),
    );
    writeEnvCommands(envDir);
}

function listEnvironments(): string[] {
    if (!fs.existsSync(ENVIRONMENTS_DIR)) return [];
    return fs.readdirSync(ENVIRONMENTS_DIR).filter(entry => {
        const envJsonPath = path.join(ENVIRONMENTS_DIR, entry, "environment.json");
        return fs.existsSync(envJsonPath);
    });
}

function ensureLabRatProjectTemplate() {
    if (!fs.existsSync(LAB_RAT_PROJECT_TEMPLATE_DIR)) {
        throw new Error(`Missing lab-rat project template at ${LAB_RAT_PROJECT_TEMPLATE_DIR}`);
    }
}

function copyLabRatProject(envDir: string): string {
    ensureLabRatProjectTemplate();
    const targetDir = path.join(envDir, "project");
    fs.cpSync(LAB_RAT_PROJECT_TEMPLATE_DIR, targetDir, { recursive: true });
    return targetDir;
}

function isPortInUse(port: number): boolean {
    try {
        const result = execSync(`lsof -i tcp:${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: "utf-8" });
        return result.trim().length > 0;
    } catch {
        return false;
    }
}

function readDevAuth(envDir: string): { secret: string; token: string } | null {
    const accessKeyPath = path.join(envDir, "cli", "home", "access.key");
    if (!fs.existsSync(accessKeyPath)) {
        return null;
    }

    try {
        const credentials = JSON.parse(fs.readFileSync(accessKeyPath, "utf-8")) as {
            secret?: string;
            token?: string;
        };

        if (!credentials.secret || !credentials.token) {
            return null;
        }

        return {
            token: credentials.token,
            secret: Buffer.from(credentials.secret, "base64").toString("base64url"),
        };
    } catch {
        return null;
    }
}

// ============================================================================
// PID file management
// ============================================================================

function writePidFile(envDir: string, service: string, pid: number): void {
    const pidsDir = path.join(envDir, "pids");
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.writeFileSync(path.join(pidsDir, `${service}.pid`), String(pid));
}

function readPidFile(envDir: string, service: string): number | null {
    const pidPath = path.join(envDir, "pids", `${service}.pid`);
    if (!fs.existsSync(pidPath)) return null;
    const raw = fs.readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
}

function removePidFile(envDir: string, service: string): void {
    const pidPath = path.join(envDir, "pids", `${service}.pid`);
    try { fs.unlinkSync(pidPath); } catch {}
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function killProcess(pid: number): void {
    try {
        // Kill entire process group (detached processes get their own group)
        process.kill(-pid, "SIGTERM");
    } catch {
        try { process.kill(pid, "SIGTERM"); } catch {}
    }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try { if (await check()) return; } catch {}
        await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function spawnService(
    command: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string | undefined>; logFile: string },
): number {
    fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
    const logFd = fs.openSync(opts.logFile, "a");
    const child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", logFd, logFd],
        detached: true,
    });
    child.unref();
    fs.closeSync(logFd);
    return child.pid!;
}

export const VALID_TEMPLATES = ["authenticated-empty", "empty"] as const;
export type Template = (typeof VALID_TEMPLATES)[number];

export function getEnvironmentDir(name: string): string {
    return path.join(ENVIRONMENTS_DIR, name);
}

export function getEnvironmentConfig(name: string): EnvironmentConfig {
    return readEnvironmentConfig(name);
}

export function setEnvironmentTemplate(name: string, template: Template): void {
    const config = readEnvironmentConfig(name);
    writeEnvironmentConfig({ ...config, template });
}

export async function createEnvironment(opts?: { noSwitch?: boolean }): Promise<string> {
    ensureEnvironmentsDir();

    const existing = new Set(listEnvironments());
    let name = generateName();
    let attempts = 0;
    while (existing.has(name) && attempts < 100) {
        name = generateName();
        attempts++;
    }
    if (existing.has(name)) {
        throw new Error("Failed to generate a unique environment name after 100 attempts.");
    }

    const serverPort = await allocatePort();
    const expoPort = await allocatePort();

    const envDir = path.join(ENVIRONMENTS_DIR, name);
    fs.mkdirSync(path.join(envDir, "server", "pglite"), { recursive: true });
    fs.mkdirSync(path.join(envDir, "server", "logs"), { recursive: true });
    fs.mkdirSync(path.join(envDir, "cli", "home"), { recursive: true });
    const projectPath = copyLabRatProject(envDir);

    const config: EnvironmentConfig = {
        name,
        serverPort,
        expoPort,
        createdAt: new Date().toISOString(),
        template: "empty",
        projectTemplate: "lab-rat-todo-project",
        projectPath,
    };
    writeEnvironmentConfig(config);

    console.log(`Running database migration for ${name}...`);
    const migrationEnv = buildEnvVars(envDir, serverPort, expoPort);
    const standaloneTs = path.join(REPO_ROOT, "packages", "happy-server", "sources", "standalone.ts");
    const result = spawnSync(
        "tsx",
        [standaloneTs, "migrate"],
        {
            cwd: path.join(REPO_ROOT, "packages", "happy-server"),
            env: { ...process.env, ...migrationEnv },
            stdio: "inherit",
        }
    );
    if (result.status !== 0) {
        throw new Error(`Migration failed with exit code ${result.status}`);
    }

    if (!opts?.noSwitch) {
        writeCurrentConfig(name);
    }

    console.log("");
    console.log(`Environment created: ${name}`);
    console.log(`  Server: http://localhost:${serverPort}`);
    console.log(`  Webapp: http://localhost:${expoPort}`);
    console.log(`  Project: ${projectPath}`);
    console.log("");
    const envShRelative = path.relative(process.cwd(), path.join(envDir, "env.sh"));
    console.log("Start in separate terminals:");
    console.log("");
    console.log(`  Server:  yarn env:server`);
    console.log(`  Webapp:  yarn env:web`);
    console.log("");
    console.log("CLI (from any terminal, anywhere):");
    console.log("");
    console.log(`  One-liner: ${buildCliCommand(envDir)}`);
    console.log("");
    console.log(`  source ${envShRelative}`);
    console.log(`  happy`);
    console.log("");
    console.log(`Full env.sh path: ${path.join(envDir, "env.sh")}`);

    return name;
}

export async function startEnvironmentServices(name: string): Promise<void> {
    const envDir = getEnvironmentDir(name);
    const config = readEnvironmentConfig(name);
    const envVars = buildEnvVars(envDir, config.serverPort, config.expoPort);
    const mergedEnv: Record<string, string | undefined> = { ...process.env, ...envVars };

    const serverLogFile = path.join(envDir, "server", "stdout.log");
    console.log(`Starting server on port ${config.serverPort}...`);
    const serverPid = spawnService("yarn", ["standalone", "serve"], {
        cwd: path.join(REPO_ROOT, "packages", "happy-server"),
        env: mergedEnv,
        logFile: serverLogFile,
    });
    writePidFile(envDir, "server", serverPid);

    const serverUrl = `http://localhost:${config.serverPort}`;
    try {
        await waitFor(async () => {
            const res = await fetch(`${serverUrl}/`);
            return res.ok;
        }, 30_000, "server");
    } catch {
        throw new Error(`Server failed to start. Check logs: ${serverLogFile}`);
    }
    console.log(`  Server is healthy.`);

    const webLogFile = path.join(envDir, "web", "stdout.log");
    fs.mkdirSync(path.join(envDir, "web"), { recursive: true });
    console.log(`Starting web on port ${config.expoPort}...`);
    const webPid = spawnService("yarn", ["web", "--port", String(config.expoPort)], {
        cwd: path.join(REPO_ROOT, "packages", "happy-app"),
        env: { ...mergedEnv, BROWSER: "none" },
        logFile: webLogFile,
    });
    writePidFile(envDir, "web", webPid);

    try {
        await waitFor(() => isPortInUse(config.expoPort), 30_000, "web");
    } catch {
        throw new Error(`Web failed to start. Check logs: ${webLogFile}`);
    }
    console.log(`  Web is listening.`);
}

export async function seedEnvironment(name: string): Promise<void> {
    const envDir = getEnvironmentDir(name);
    const config = readEnvironmentConfig(name);
    const serverUrl = `http://localhost:${config.serverPort}`;

    try {
        const res = await fetch(`${serverUrl}/`);
        if (!res.ok) throw new Error(`Status ${res.status}`);
    } catch {
        throw new Error(`Server not reachable at ${serverUrl}. Start it first: yarn env:server`);
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
    const rawPublicKey = Buffer.from(jwk.x || "", "base64url");

    const challenge = crypto.randomBytes(32);
    const signature = crypto.sign(null, challenge, privateKey);

    const toBase64 = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64");
    const toBase64Url = (buf: Buffer | Uint8Array) =>
        Buffer.from(buf).toString("base64url");

    const authRes = await fetch(`${serverUrl}/v1/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            publicKey: toBase64(rawPublicKey),
            challenge: toBase64(challenge),
            signature: toBase64(signature),
        }),
    });
    if (!authRes.ok) {
        throw new Error(`Auth failed: ${authRes.status} ${await authRes.text()}`);
    }
    const { token } = (await authRes.json()) as { token: string };

    const secret = crypto.randomBytes(32);
    const secretBase64 = toBase64(secret);

    const cliHome = path.join(envDir, "cli", "home");
    fs.mkdirSync(cliHome, { recursive: true });

    fs.writeFileSync(
        path.join(cliHome, "access.key"),
        JSON.stringify({ secret: secretBase64, token }, null, 2),
    );

    fs.writeFileSync(
        path.join(cliHome, "settings.json"),
        JSON.stringify(
            {
                schemaVersion: 2,
                onboardingCompleted: true,
                machineId: crypto.randomUUID(),
            },
            null,
            2,
        ),
    );

    const authenticatedWebUrl = buildAuthenticatedWebUrl(config.expoPort, token, secretBase64);
    writeEnvironmentConfig({ ...config, authenticatedWebUrl });

    const daemonStatePath = path.join(envDir, "cli", "home", "daemon.state.json");
    if (fs.existsSync(daemonStatePath)) {
        try {
            const daemonState = JSON.parse(fs.readFileSync(daemonStatePath, "utf-8"));
            if (daemonState.pid && isProcessAlive(daemonState.pid)) {
                console.log(`Stopping existing daemon (PID ${daemonState.pid})...`);
                killProcess(daemonState.pid);
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch {}
    }

    const envVars = buildEnvVars(envDir, config.serverPort, config.expoPort);
    const daemonEnv = { ...process.env, ...envVars };
    delete daemonEnv.CLAUDECODE;

    const happyBin = path.join(REPO_ROOT, "packages", "happy-cli", "bin", "happy.mjs");
    const daemon = spawn("node", [happyBin, "daemon", "start"], {
        env: daemonEnv,
        stdio: "ignore",
        detached: true,
    });
    daemon.unref();

    const machineRegistered = await waitFor(async () => {
        const res = await fetch(`${serverUrl}/v1/machines`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return false;
        const machines = (await res.json()) as unknown[];
        return machines.length > 0;
    }, 10_000, "machine registration").then(() => true, () => false);

    console.log(`  Seeded: credentials written, daemon ${machineRegistered ? "registered" : "starting"}`);
    console.log(`  Auth URL: ${authenticatedWebUrl}`);
}

export function stopEnvironment(name: string): void {
    const envDir = getEnvironmentDir(name);
    let killed = 0;

    for (const service of ["server", "web"] as const) {
        const pid = readPidFile(envDir, service);
        if (pid !== null) {
            if (isProcessAlive(pid)) {
                console.log(`Stopping ${service} (PID ${pid})...`);
                killProcess(pid);
                killed++;
            } else {
                console.log(`${service} PID ${pid} already dead.`);
            }
            removePidFile(envDir, service);
        }
    }

    const daemonStatePath = path.join(envDir, "cli", "home", "daemon.state.json");
    if (fs.existsSync(daemonStatePath)) {
        try {
            const daemonState = JSON.parse(fs.readFileSync(daemonStatePath, "utf-8"));
            if (daemonState.pid && isProcessAlive(daemonState.pid)) {
                console.log(`Stopping daemon (PID ${daemonState.pid})...`);
                killProcess(daemonState.pid);
                killed++;
            }
        } catch {}
    }

    if (killed === 0) {
        console.log(`No running services found for "${name}".`);
    } else {
        console.log("");
        console.log(`Environment "${name}" is down. Stopped ${killed} process(es).`);
    }
}

export function removeEnvironment(name: string): void {
    const envDir = getEnvironmentDir(name);
    const currentConfig = readCurrentConfig();
    if (currentConfig?.current === name && fs.existsSync(CURRENT_ENV_PATH)) {
        fs.unlinkSync(CURRENT_ENV_PATH);
    }
    fs.rmSync(envDir, { recursive: true, force: true });
    console.log(`Removed environment: ${name}`);
}

// ============================================================================
// Commands
// ============================================================================

async function commandNew(opts?: { noSwitch?: boolean }): Promise<string> {
    return createEnvironment(opts);
}

function commandList() {
    const envs = listEnvironments();
    if (envs.length === 0) {
        console.log("No environments. Run `yarn env:new` to create one.");
        return;
    }

    const currentConfig = readCurrentConfig();
    const currentName = currentConfig?.current;

    console.log("Environments:");
    console.log("");
    for (const envName of envs) {
        const config = readEnvironmentConfig(envName);
        const isCurrent = envName === currentName;
        const marker = isCurrent ? " *" : "  ";

        const serverUp = isPortInUse(config.serverPort);
        const expoUp = isPortInUse(config.expoPort);

        const serverStatus = serverUp ? "running" : "stopped";
        const expoStatus = expoUp ? "running" : "stopped";

        const serverUrl = `http://localhost:${config.serverPort}`;
        const bundlerUrl = `http://localhost:${config.expoPort}`;
        const webAppUrl = config.authenticatedWebUrl ?? bundlerUrl;

        console.log(`${marker} ${envName}`);
        console.log(`     Server:  ${serverUrl} (${serverStatus})`);
        console.log(`     Bundler: ${bundlerUrl} (${expoStatus})`);
        console.log(`     Web app: ${webAppUrl}`);
        console.log(`     Created: ${config.createdAt}`);
        console.log("");
    }
}

function commandUse(name: string) {
    const envDir = path.join(ENVIRONMENTS_DIR, name);
    if (!fs.existsSync(path.join(envDir, "environment.json"))) {
        console.error(`Environment "${name}" not found.`);
        console.error(`Available: ${listEnvironments().join(", ") || "(none)"}`);
        process.exit(1);
    }
    writeCurrentConfig(name);
    console.log(`Switched to environment: ${name}`);
}

function commandRemove(name: string) {
    const envDir = path.join(ENVIRONMENTS_DIR, name);
    if (!fs.existsSync(path.join(envDir, "environment.json"))) {
        console.error(`Environment "${name}" not found.`);
        process.exit(1);
    }

    // Check if it's the current environment
    const currentConfig = readCurrentConfig();
    if (currentConfig?.current === name) {
        // Clear current
        fs.unlinkSync(CURRENT_ENV_PATH);
    }

    fs.rmSync(envDir, { recursive: true, force: true });
    console.log(`Removed environment: ${name}`);
}

function commandCurrent() {
    const currentConfig = readCurrentConfig();
    if (!currentConfig?.current) {
        console.error("No current environment. Run `yarn env:new` or `yarn env:use <name>`.");
        process.exit(1);
    }
    const envShPath = path.join(ENVIRONMENTS_DIR, currentConfig.current, "env.sh");
    if (!fs.existsSync(envShPath)) {
        console.error(`Current environment "${currentConfig.current}" is missing. Run \`yarn env:new\`.`);
        process.exit(1);
    }
    console.log(envShPath);

    const config = readEnvironmentConfig(currentConfig.current);
    const webAppUrl = config.authenticatedWebUrl ?? `http://localhost:${config.expoPort}`;
    console.log(`\nServer:  http://localhost:${config.serverPort}`);
    console.log(`Bundler: http://localhost:${config.expoPort}`);
    console.log(`Web app: ${webAppUrl}`);
}

function commandRun(service: string, serviceArgs: string[] = []) {
    const currentConfig = readCurrentConfig();
    if (!currentConfig?.current) {
        console.error("No current environment. Run `yarn env:new` first.");
        process.exit(1);
    }

    const envName = currentConfig.current;
    const envDir = path.join(ENVIRONMENTS_DIR, envName);
    const envJsonPath = path.join(envDir, "environment.json");

    if (!fs.existsSync(envJsonPath)) {
        console.error(`Environment "${envName}" not found. Run \`yarn env:new\`.`);
        process.exit(1);
    }

    const config = readEnvironmentConfig(envName);
    const envVars = buildEnvVars(envDir, config.serverPort, config.expoPort);
    const mergedEnv = { ...process.env, ...envVars };

    switch (service) {
        case "server": {
            console.log(`Starting server for environment "${envName}" on port ${config.serverPort}...`);
            const result = spawnSync(
                "yarn",
                ["standalone", "serve"],
                {
                    cwd: path.join(REPO_ROOT, "packages", "happy-server"),
                    env: mergedEnv,
                    stdio: "inherit",
                }
            );
            process.exit(result.status ?? 1);
            break;
        }
        case "web": {
            console.log(`Starting web app for environment "${envName}" on port ${config.expoPort}...`);
            const result = spawnSync(
                "yarn",
                ["web", "--port", String(config.expoPort)],
                {
                    cwd: path.join(REPO_ROOT, "packages", "happy-app"),
                    // Expo treats `--web` as "open in browser". Disable that for env-managed runs.
                    env: { ...mergedEnv, BROWSER: "none" },
                    stdio: "inherit",
                }
            );
            process.exit(result.status ?? 1);
            break;
        }
        case "ios": {
            console.log(`Starting iOS app for environment "${envName}"...`);
            const result = spawnSync(
                "yarn",
                ["ios"],
                {
                    cwd: path.join(REPO_ROOT, "packages", "happy-app"),
                    env: mergedEnv,
                    stdio: "inherit",
                }
            );
            process.exit(result.status ?? 1);
            break;
        }
        case "android": {
            console.log(`Starting Android app for environment "${envName}"...`);
            const result = spawnSync(
                "yarn",
                ["android"],
                {
                    cwd: path.join(REPO_ROOT, "packages", "happy-app"),
                    env: mergedEnv,
                    stdio: "inherit",
                }
            );
            process.exit(result.status ?? 1);
            break;
        }
        case "cli": {
            console.log(`Starting CLI for environment "${envName}"...`);
            const cliBin = path.join(REPO_ROOT, "packages", "happy-cli", "bin", "happy.mjs");
            const result = spawnSync(
                "node",
                [cliBin, ...serviceArgs],
                {
                    env: mergedEnv,
                    stdio: "inherit",
                }
            );
            process.exit(result.status ?? 1);
            break;
        }
        default:
            console.error(`Unknown service: "${service}". Use: server, web, ios, android, cli`);
            process.exit(1);
    }
}

// ============================================================================
// env.sh builder
// ============================================================================

function buildEnvVars(envDir: string, serverPort: number, expoPort: number): Record<string, string> {
    const devAuth = readDevAuth(envDir);
    const projectDir = path.join(envDir, "project");

    return {
        // Server
        HANDY_MASTER_SECRET: "happy-dev-secret",
        PORT: String(serverPort),
        NODE_ENV: "development",
        DATA_DIR: path.join(envDir, "server"),
        PGLITE_DIR: path.join(envDir, "server", "pglite"),
        DATABASE_URL: "",
        METRICS_ENABLED: "false",

        // App (Expo)
        EXPO_PUBLIC_SERVER_URL: `http://localhost:${serverPort}`,
        EXPO_PUBLIC_HAPPY_SERVER_URL: `http://localhost:${serverPort}`,
        EXPO_PUBLIC_LOG_SERVER_URL: "http://localhost:8787",
        EXPO_PORT: String(expoPort),

        // CLI
        HAPPY_SERVER_URL: `http://localhost:${serverPort}`,
        HAPPY_WEBAPP_URL: `http://localhost:${expoPort}`,
        HAPPY_HOME_DIR: path.join(envDir, "cli", "home"),
        HAPPY_PROJECT_DIR: projectDir,
        HAPPY_VARIANT: "dev",
        DEBUG: "1",
        ...(devAuth ? {
            EXPO_PUBLIC_DEV_TOKEN: devAuth.token,
            EXPO_PUBLIC_DEV_SECRET: devAuth.secret,
        } : {}),
    };
}

function buildEnvSh(name: string, envDir: string, serverPort: number, expoPort: number): string {
    const vars = buildEnvVars(envDir, serverPort, expoPort);
    const lines: string[] = [
        `# Happy Dev Environment: ${name}`,
        `# Generated by environments/environments.ts`,
        `# Source this file in your terminal: source ${path.join(envDir, "env.sh")}`,
        "",
    ];

    // Group exports by section
    lines.push("# Server");
    lines.push(`export HANDY_MASTER_SECRET="${vars.HANDY_MASTER_SECRET}"`);
    lines.push(`export PORT=${vars.PORT}`);
    lines.push(`export NODE_ENV="${vars.NODE_ENV}"`);
    lines.push(`export DATA_DIR="${vars.DATA_DIR}"`);
    lines.push(`export PGLITE_DIR="${vars.PGLITE_DIR}"`);
    lines.push(`export DATABASE_URL=""`);
    lines.push(`export METRICS_ENABLED=false`);
    lines.push("");

    lines.push("# App (Expo)");
    lines.push(`export EXPO_PUBLIC_SERVER_URL="${vars.EXPO_PUBLIC_SERVER_URL}"`);
    lines.push(`export EXPO_PUBLIC_HAPPY_SERVER_URL="${vars.EXPO_PUBLIC_HAPPY_SERVER_URL}"`);
    lines.push(`export EXPO_PUBLIC_LOG_SERVER_URL="${vars.EXPO_PUBLIC_LOG_SERVER_URL}"`);
    if (vars.EXPO_PUBLIC_DEV_TOKEN && vars.EXPO_PUBLIC_DEV_SECRET) {
        lines.push(`export EXPO_PUBLIC_DEV_TOKEN="${vars.EXPO_PUBLIC_DEV_TOKEN}"`);
        lines.push(`export EXPO_PUBLIC_DEV_SECRET="${vars.EXPO_PUBLIC_DEV_SECRET}"`);
    }
    lines.push(`export EXPO_PORT=${vars.EXPO_PORT}`);
    lines.push("");

    lines.push("# CLI");
    lines.push(`export HAPPY_SERVER_URL="${vars.HAPPY_SERVER_URL}"`);
    lines.push(`export HAPPY_WEBAPP_URL="${vars.HAPPY_WEBAPP_URL}"`);
    lines.push(`export HAPPY_HOME_DIR="${vars.HAPPY_HOME_DIR}"`);
    lines.push(`export HAPPY_PROJECT_DIR="${vars.HAPPY_PROJECT_DIR}"`);
    lines.push(`export HAPPY_VARIANT=dev`);
    lines.push(`export DEBUG=1`);
    lines.push(`export PATH="${path.join(envDir, "bin")}:$PATH"`);
    lines.push("");
    lines.push("# Commands exposed by this env");
    lines.push("# - happy");
    lines.push("");

    return lines.join("\n");
}

function writeEnvCommands(envDir: string): void {
    const binDir = path.join(envDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const commands = [
        {
            name: "happy",
            entrypoint: path.join(REPO_ROOT, "packages", "happy-cli", "bin", "happy.mjs"),
        },
    ];

    for (const command of commands) {
        const wrapperPath = path.join(binDir, command.name);
        const wrapper = [
            "#!/usr/bin/env bash",
            `exec node ${JSON.stringify(command.entrypoint)} "$@"`,
            "",
        ].join("\n");
        fs.writeFileSync(wrapperPath, wrapper);
        fs.chmodSync(wrapperPath, 0o755);
    }
}

function buildAuthenticatedWebUrl(expoPort: number, token: string, secret: string): string {
    const webParams = new URLSearchParams({
        dev_token: token,
        dev_secret: Buffer.from(secret, "base64").toString("base64url"),
    });
    return `http://localhost:${expoPort}/?${webParams}`;
}

function buildCliCommand(envDir: string): string {
    return `source "${path.join(envDir, "env.sh")}" && happy`;
}

// ============================================================================
// Seed auth
// ============================================================================

async function commandSeed(targetName?: string) {
    const envName = targetName ?? readCurrentConfig()?.current;
    if (!envName) {
        console.error("No current environment. Run `yarn env:new` first.");
        process.exit(1);
    }
    await seedEnvironment(envName);
}

// ============================================================================
// Up / Down
// ============================================================================

async function commandUp(template: Template, opts?: { noSwitch?: boolean }) {
    const envName = await createEnvironment(opts);
    const envDir = getEnvironmentDir(envName);
    const config = readEnvironmentConfig(envName);

    setEnvironmentTemplate(envName, template);
    await startEnvironmentServices(envName);

    // Seed if template requires it
    if (template === "authenticated-empty") {
        // Always rebuild CLI so the daemon binary matches this worktree
        console.log("Building CLI (needed for daemon)...");
        const envVars = buildEnvVars(envDir, config.serverPort, config.expoPort);
        const mergedEnv: Record<string, string | undefined> = { ...process.env, ...envVars };
        const buildResult = spawnSync("yarn", ["build"], {
            cwd: path.join(REPO_ROOT, "packages", "happy-cli"),
            env: mergedEnv,
            stdio: "inherit",
        });
        if (buildResult.status !== 0) {
            console.error("CLI build failed.");
            process.exit(1);
        }

        console.log("Seeding auth + starting daemon...");
        await seedEnvironment(envName);
    }

    // Print summary
    const finalConfig = readEnvironmentConfig(envName);
    console.log("");
    console.log(`Environment "${envName}" is up!`);
    console.log(`  Server: http://localhost:${config.serverPort}`);
    console.log(`  Web:    http://localhost:${config.expoPort}`);
    console.log(`  Project: ${finalConfig.projectPath}`);

    if (finalConfig.authenticatedWebUrl) {
        console.log(`  Open:   ${finalConfig.authenticatedWebUrl}`);
    }
    if (finalConfig.cliCommand) {
        console.log(`  CLI:    ${finalConfig.cliCommand}`);
    }

    console.log(`  Logs:   ${path.relative(process.cwd(), path.join(envDir, "server", "stdout.log"))}`);
    console.log(`          ${path.relative(process.cwd(), path.join(envDir, "web", "stdout.log"))}`);
    console.log(`  Stop:   yarn env:down`);
    console.log("");
}

function commandDown(targetName?: string) {
    const envName = targetName ?? readCurrentConfig()?.current;
    if (!envName) {
        console.error("No current environment. Nothing to stop.");
        process.exit(1);
    }
    stopEnvironment(envName);
}

// ============================================================================
// Tailscale
// ============================================================================

function commandTailscale() {
    const currentConfig = readCurrentConfig();
    if (!currentConfig?.current) {
        console.error("No current environment. Run `yarn env:new` first.");
        process.exit(1);
    }

    const config = readEnvironmentConfig(currentConfig.current);

    // Get tailscale hostname
    let hostname: string;
    try {
        const statusJson = execSync("tailscale status --self --json", { encoding: "utf-8" });
        const status = JSON.parse(statusJson);
        hostname = status.Self.DNSName.replace(/\.$/, "");
    } catch {
        console.error("Failed to get Tailscale hostname. Is Tailscale running?");
        process.exit(1);
    }

    // Reset existing funnels
    try { execSync("tailscale funnel reset", { stdio: "ignore" }); } catch {}

    // Expose web app on 443 and server on 8443
    try {
        execSync(`tailscale funnel --bg ${config.expoPort}`, { stdio: "inherit" });
        execSync(`tailscale funnel --bg --https=8443 ${config.serverPort}`, { stdio: "inherit" });
    } catch (e: any) {
        console.error("Failed to set up Tailscale funnel:", e.message);
        process.exit(1);
    }

    console.log("");
    console.log(`Tailscale funnel active for "${currentConfig.current}":`);
    console.log("");
    console.log(`  Web:    https://${hostname}`);
    console.log(`  Server: https://${hostname}:8443`);
    console.log("");
}

// ============================================================================
// CLI entry point
// ============================================================================

async function main(): Promise<void> {
    const [subcommand, ...args] = process.argv.slice(2);

    switch (subcommand) {
        case "new": {
            const noSwitch = args.includes("--no-switch");
            await commandNew({ noSwitch });
            break;
        }
        case "list":
            commandList();
            break;
        case "use":
            if (!args[0]) {
                console.error("Usage: yarn env:use <name>");
                process.exit(1);
            }
            commandUse(args[0]);
            break;
        case "remove":
            if (!args[0]) {
                console.error("Usage: yarn env:remove <name>");
                process.exit(1);
            }
            commandRemove(args[0]);
            break;
        case "current":
            commandCurrent();
            break;
        case "run":
            if (!args[0]) {
                console.error("Usage: yarn env:server | yarn env:web | yarn env:cli");
                process.exit(1);
            }
            commandRun(args[0], args.slice(1));
            break;
        case "seed":
            await commandSeed();
            break;
        case "up": {
            const templateIdx = args.indexOf("--template");
            const template = templateIdx !== -1 ? args[templateIdx + 1] : undefined;
            if (!template || !VALID_TEMPLATES.includes(template as Template)) {
                console.error(`Usage: yarn env:up --template <${VALID_TEMPLATES.join("|")}>`);
                process.exit(1);
            }
            const noSwitch = args.includes("--no-switch");
            await commandUp(template as Template, { noSwitch });
            break;
        }
        case "down":
            commandDown(args[0]);
            break;
        case "tailscale":
            commandTailscale();
            break;
        default:
            console.log(`Happy Environment Manager

Usage:
  yarn env:up --template <t>  Create + start everything (templates: ${VALID_TEMPLATES.join(", ")})
  yarn env:up:authenticated   Create + start everything with the authenticated template
  yarn env:down               Stop all services for current environment

  yarn env:new              Create a new isolated dev environment
  yarn env:list             List all environments with status
  yarn env:use <name>       Switch to a different environment
  yarn env:remove <name>    Delete an environment
  yarn env:current          Print current environment's env.sh path
  yarn env:seed             Seed auth for CLI + web (requires server running)

  yarn env:server           Start the server (current environment)
  yarn env:web              Start the web app (current environment)
  yarn env:ios              Start the iOS app (current environment)
  yarn env:android          Start the Android app (current environment)
  yarn env:cli              Start the CLI (current environment)

  yarn env:tailscale        Expose server + web via Tailscale funnel
`);
            if (subcommand && subcommand !== "--help" && subcommand !== "-h") {
                process.exit(1);
            }
    }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (executedPath === import.meta.url) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
