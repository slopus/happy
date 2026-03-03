import * as fs from "fs";
import * as path from "path";
import * as net from "net";
import { execSync, spawnSync } from "child_process";

// ============================================================================
// Configuration
// ============================================================================

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ENVIRONMENTS_DIR = path.join(REPO_ROOT, ".environments");

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

interface EnvironmentConfig {
    name: string;
    serverPort: number;
    expoPort: number;
    createdAt: string;
    template: string;
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
    const configPath = path.join(ENVIRONMENTS_DIR, "current.json");
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function writeCurrentConfig(current: string) {
    const configPath = path.join(ENVIRONMENTS_DIR, "current.json");
    fs.writeFileSync(configPath, JSON.stringify({ current }, null, 4) + "\n");
}

function readEnvironmentConfig(name: string): EnvironmentConfig {
    const configPath = path.join(ENVIRONMENTS_DIR, name, "environment.json");
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

function listEnvironments(): string[] {
    if (!fs.existsSync(ENVIRONMENTS_DIR)) return [];
    return fs.readdirSync(ENVIRONMENTS_DIR).filter(entry => {
        const envJsonPath = path.join(ENVIRONMENTS_DIR, entry, "environment.json");
        return fs.existsSync(envJsonPath);
    });
}

function isPortInUse(port: number): boolean {
    try {
        const result = execSync(`lsof -i tcp:${port} -sTCP:LISTEN -t 2>/dev/null`, { encoding: "utf-8" });
        return result.trim().length > 0;
    } catch {
        return false;
    }
}

// ============================================================================
// Commands
// ============================================================================

async function commandNew() {
    ensureEnvironmentsDir();

    // Generate a unique name
    const existing = new Set(listEnvironments());
    let name = generateName();
    let attempts = 0;
    while (existing.has(name) && attempts < 100) {
        name = generateName();
        attempts++;
    }
    if (existing.has(name)) {
        console.error("Failed to generate a unique environment name after 100 attempts.");
        process.exit(1);
    }

    // Allocate ports
    const serverPort = await allocatePort();
    const expoPort = await allocatePort();

    // Create directory structure
    const envDir = path.join(ENVIRONMENTS_DIR, name);
    fs.mkdirSync(path.join(envDir, "server", "pglite"), { recursive: true });
    fs.mkdirSync(path.join(envDir, "server", "logs"), { recursive: true });
    fs.mkdirSync(path.join(envDir, "cli", "home"), { recursive: true });

    // Write environment.json
    const config: EnvironmentConfig = {
        name,
        serverPort,
        expoPort,
        createdAt: new Date().toISOString(),
        template: "empty",
    };
    fs.writeFileSync(
        path.join(envDir, "environment.json"),
        JSON.stringify(config, null, 4) + "\n"
    );

    // Write env.sh
    const envSh = buildEnvSh(name, envDir, serverPort, expoPort);
    fs.writeFileSync(path.join(envDir, "env.sh"), envSh);

    // Run migration
    console.log(`Running database migration for ${name}...`);
    const migrationEnv = buildEnvVars(envDir, serverPort, expoPort);
    const standaloneTs = path.join(REPO_ROOT, "packages", "happy-server", "sources", "standalone.ts");
    const result = spawnSync(
        "npx",
        ["tsx", standaloneTs, "migrate"],
        {
            cwd: path.join(REPO_ROOT, "packages", "happy-server"),
            env: { ...process.env, ...migrationEnv },
            stdio: "inherit",
        }
    );
    if (result.status !== 0) {
        console.error(`Migration failed with exit code ${result.status}`);
        process.exit(1);
    }

    // Update current.json
    writeCurrentConfig(name);

    // Print output
    console.log("");
    console.log(`Environment created: ${name}`);
    console.log(`  Server: http://localhost:${serverPort}`);
    console.log(`  Webapp: http://localhost:${expoPort}`);
    console.log("");
    const envShRelative = path.relative(process.cwd(), path.join(envDir, "env.sh"));
    console.log("Start in separate terminals:");
    console.log("");
    console.log(`  Server:  yarn env:server`);
    console.log(`  Webapp:  yarn env:web`);
    console.log("");
    console.log("CLI (from any terminal, anywhere):");
    console.log("");
    console.log(`  source ${envShRelative}`);
    console.log(`  happy`);
    console.log("");
    console.log(`Full env.sh path: ${path.join(envDir, "env.sh")}`);
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

        console.log(`${marker} ${envName}`);
        console.log(`     Server: :${config.serverPort} (${serverStatus})`);
        console.log(`     Webapp: :${config.expoPort} (${expoStatus})`);
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
        const configPath = path.join(ENVIRONMENTS_DIR, "current.json");
        fs.unlinkSync(configPath);
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
}

function commandRun(service: string) {
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
                    env: mergedEnv,
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
                [cliBin],
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
    return {
        // Server
        HANDY_MASTER_SECRET: "happy-dev-secret",
        PORT: String(serverPort),
        NODE_ENV: "development",
        DATA_DIR: path.join(envDir, "server"),
        PGLITE_DIR: path.join(envDir, "server", "pglite"),
        DATABASE_URL: "",
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: "true",
        METRICS_ENABLED: "false",

        // App (Expo)
        EXPO_PUBLIC_SERVER_URL: `http://localhost:${serverPort}`,
        EXPO_PUBLIC_HAPPY_SERVER_URL: `http://localhost:${serverPort}`,
        EXPO_PORT: String(expoPort),

        // CLI
        HAPPY_SERVER_URL: `http://localhost:${serverPort}`,
        HAPPY_WEBAPP_URL: `http://localhost:${expoPort}`,
        HAPPY_HOME_DIR: path.join(envDir, "cli", "home"),
        HAPPY_VARIANT: "dev",
        DEBUG: "1",
    };
}

function buildEnvSh(name: string, envDir: string, serverPort: number, expoPort: number): string {
    const vars = buildEnvVars(envDir, serverPort, expoPort);
    const lines: string[] = [
        `# Happy Dev Environment: ${name}`,
        `# Generated by scripts/environments.ts`,
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
    lines.push(`export DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING=true`);
    lines.push(`export METRICS_ENABLED=false`);
    lines.push("");

    lines.push("# App (Expo)");
    lines.push(`export EXPO_PUBLIC_SERVER_URL="${vars.EXPO_PUBLIC_SERVER_URL}"`);
    lines.push(`export EXPO_PUBLIC_HAPPY_SERVER_URL="${vars.EXPO_PUBLIC_HAPPY_SERVER_URL}"`);
    lines.push(`export EXPO_PORT=${vars.EXPO_PORT}`);
    lines.push("");

    lines.push("# CLI");
    lines.push(`export HAPPY_SERVER_URL="${vars.HAPPY_SERVER_URL}"`);
    lines.push(`export HAPPY_WEBAPP_URL="${vars.HAPPY_WEBAPP_URL}"`);
    lines.push(`export HAPPY_HOME_DIR="${vars.HAPPY_HOME_DIR}"`);
    lines.push(`export HAPPY_VARIANT=dev`);
    lines.push(`export DEBUG=1`);
    lines.push("");

    const cliBin = path.join(REPO_ROOT, "packages", "happy-cli", "bin", "happy.mjs");
    lines.push("# 'happy' command — works from anywhere after sourcing");
    lines.push(`alias happy='node ${cliBin}'`);
    lines.push("");

    return lines.join("\n");
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

const [subcommand, ...args] = process.argv.slice(2);

switch (subcommand) {
    case "new":
        commandNew().catch(err => {
            console.error(err);
            process.exit(1);
        });
        break;
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
        commandRun(args[0]);
        break;
    case "tailscale":
        commandTailscale();
        break;
    default:
        console.log(`Happy Environment Manager

Usage:
  yarn env:new              Create a new isolated dev environment
  yarn env:list             List all environments with status
  yarn env:use <name>       Switch to a different environment
  yarn env:remove <name>    Delete an environment
  yarn env:current          Print current environment's env.sh path

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
