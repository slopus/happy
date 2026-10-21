/**
 * `happy proxy` - configure how Happy reaches its relay server.
 *
 * Mirrors the shape of `happy sandbox`: an interactive `configure`, a `status`
 * view, a `disable`, and a help screen. The configuration is stored in
 * ~/.happy/settings.json under `proxyConfig` and is applied by `configureProxy()`
 * to the relay socket, axios, fetch and spawned agents.
 */
import chalk from 'chalk';
import inquirer from 'inquirer';
import { readSettings } from '@/persistence';
import { configureProxy, describeProxy, getProxyConfig, setProxyConfig } from '@/proxy';
import {
    DEFAULT_PROXY_CONFIG,
    ProxyConfigSchema,
    maskProxyUrl,
    type ManualProxy,
    type ProxyConfig,
    type ProxyMode,
    type ProxyProtocol,
} from '@/proxy/types';

const MODE_CHOICES: Array<{ name: string; value: ProxyMode; hint: string }> = [
    { name: 'Environment variables (default)', value: 'env', hint: 'HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY' },
    { name: 'System proxy settings', value: 'system', hint: 'macOS, Windows and GNOME proxy settings, PAC included' },
    { name: 'PAC script (auto proxy)', value: 'pac', hint: 'resolve proxy.pac per destination' },
    { name: 'Manual proxy', value: 'manual', hint: 'http, https, socks4, socks5 or socks5h' },
    { name: 'No proxy (direct)', value: 'off', hint: 'never use a proxy, ignore the environment' },
];

const PROTOCOL_CHOICES: Array<{ name: string; value: ProxyProtocol }> = [
    { name: 'HTTP', value: 'http' },
    { name: 'HTTPS', value: 'https' },
    { name: 'SOCKS4', value: 'socks4' },
    { name: 'SOCKS4a (resolve host on the proxy)', value: 'socks4a' },
    { name: 'SOCKS5', value: 'socks5' },
    { name: 'SOCKS5h (resolve host on the proxy)', value: 'socks5h' },
];

function parseCommaList(value: string): string[] {
    return value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

interface ConfigureFlags {
    mode?: ProxyMode;
    pacUrl?: string;
    protocol?: ProxyProtocol;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    noProxy?: string[];
    useForChildProcesses?: boolean;
    yes?: boolean;
}

function parseFlags(args: string[]): ConfigureFlags {
    const flags: ConfigureFlags = {};
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const next = () => args[++index];
        switch (arg) {
            case '--mode':
                flags.mode = next() as ProxyMode;
                break;
            case '--pac-url':
                flags.pacUrl = next();
                break;
            case '--protocol':
                flags.protocol = next() as ProxyProtocol;
                break;
            case '--host':
                flags.host = next();
                break;
            case '--port':
                flags.port = Number(next());
                break;
            case '--username':
                flags.username = next();
                break;
            case '--password':
                flags.password = next();
                break;
            case '--no-proxy':
                flags.noProxy = parseCommaList(next() ?? '');
                break;
            case '--child-processes':
                flags.useForChildProcesses = next() !== 'false';
                break;
            case '--no-child-processes':
                flags.useForChildProcesses = false;
                break;
            case '--yes':
            case '-y':
                flags.yes = true;
                break;
            default:
                break;
        }
    }
    return flags;
}

function buildManualProxy(flags: ConfigureFlags, current: ManualProxy | undefined): ManualProxy | undefined {
    if (
        flags.protocol === undefined
        && flags.host === undefined
        && flags.port === undefined
        && current === undefined
    ) {
        return undefined;
    }
    return {
        protocol: flags.protocol ?? current?.protocol ?? 'http',
        host: flags.host ?? current?.host ?? '',
        port: flags.port ?? current?.port ?? 0,
        username: flags.username ?? current?.username,
        password: flags.password ?? current?.password,
    };
}

async function saveConfig(config: ProxyConfig, quiet = false): Promise<void> {
    await setProxyConfig(config);
    if (!quiet) {
        console.log(chalk.green('\nProxy configuration saved.'));
        console.log(chalk.gray(`Stored in ${chalk.bold('settings.json')} as proxyConfig.`));
        await printStatus();
        console.log(chalk.gray('Restart the daemon (`happy daemon stop && happy daemon start`) so it reconnects through the proxy.'));
    }
}

async function promptConfigure(flags: ConfigureFlags): Promise<ProxyConfig | undefined> {
    const settings = await readSettings();
    const current = settings.proxyConfig ?? getProxyConfig() ?? DEFAULT_PROXY_CONFIG;

    const { mode } = flags.mode
        ? { mode: flags.mode }
        : await inquirer.prompt<{ mode: ProxyMode }>([
            {
                type: 'list',
                name: 'mode',
                message: 'How should Happy find a proxy?',
                default: current.mode,
                choices: MODE_CHOICES.map((choice) => ({
                    name: `${choice.name}  ${chalk.gray(choice.hint)}`,
                    value: choice.value,
                })),
            },
        ]);

    let pacUrl = flags.pacUrl ?? current.pacUrl;
    if (mode === 'pac' && !flags.pacUrl) {
        ({ pacUrl } = await inquirer.prompt<{ pacUrl: string }>([
            {
                type: 'input',
                name: 'pacUrl',
                message: 'PAC script URL (http(s):// or file://):',
                default: current.pacUrl,
                validate: (value: string) => (value.trim().length > 0 ? true : 'A PAC URL is required'),
            },
        ]));
    }

    let manual = buildManualProxy(flags, current.manual);
    if (mode === 'manual' && !flags.host) {
        const answers = await inquirer.prompt<{
            protocol: ProxyProtocol;
            host: string;
            port: number;
            username: string;
            password: string;
        }>([
            {
                type: 'list',
                name: 'protocol',
                message: 'Proxy protocol:',
                default: current.manual?.protocol ?? 'http',
                choices: PROTOCOL_CHOICES,
            },
            {
                type: 'input',
                name: 'host',
                message: 'Proxy host:',
                default: current.manual?.host,
                validate: (value: string) => (value.trim().length > 0 ? true : 'A host is required'),
            },
            {
                type: 'number',
                name: 'port',
                message: 'Proxy port:',
                default: current.manual?.port,
                validate: (value: number) => (Number.isInteger(value) && value > 0 && value < 65536 ? true : 'Enter a port between 1 and 65535'),
            },
            {
                type: 'input',
                name: 'username',
                message: 'Username (optional):',
                default: current.manual?.username,
            },
            {
                type: 'password',
                name: 'password',
                message: 'Password (optional):',
                default: current.manual?.password,
            },
        ]);
        manual = {
            protocol: answers.protocol,
            host: answers.host.trim(),
            port: Number(answers.port),
            username: answers.username?.trim() || undefined,
            password: answers.password || undefined,
        };
    }

    let noProxy = flags.noProxy ?? current.noProxy ?? [];
    if (!flags.yes && flags.noProxy === undefined) {
        const answer = await inquirer.prompt<{ noProxy: string }>([
            {
                type: 'input',
                name: 'noProxy',
                message: 'Never proxy these hosts (comma separated, optional):',
                default: (current.noProxy ?? []).join(','),
            },
        ]);
        noProxy = parseCommaList(answer.noProxy);
    }

    let useForChildProcesses = flags.useForChildProcesses ?? current.useForChildProcesses ?? true;
    if (!flags.yes && flags.useForChildProcesses === undefined) {
        const answer = await inquirer.prompt<{ useForChildProcesses: boolean }>([
            {
                type: 'confirm',
                name: 'useForChildProcesses',
                message: 'Also export the proxy to spawned agents (claude, codex, ...)?',
                default: current.useForChildProcesses ?? true,
            },
        ]);
        useForChildProcesses = answer.useForChildProcesses;
    }

    const candidate: ProxyConfig = {
        mode,
        manual: mode === 'manual' ? manual : current.manual,
        pacUrl: mode === 'pac' ? pacUrl : current.pacUrl,
        noProxy,
        useForChildProcesses,
    };

    const parsed = ProxyConfigSchema.safeParse(candidate);
    if (!parsed.success) {
        console.log(chalk.red(`Invalid proxy configuration: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`));
        return undefined;
    }

    console.log(chalk.bold('\nProxy configuration summary:'));
    console.log(JSON.stringify({ ...parsed.data, manual: parsed.data.manual ? { ...parsed.data.manual, password: parsed.data.manual.password ? '***' : undefined } : undefined }, null, 2));

    if (!flags.yes) {
        const { confirmSave } = await inquirer.prompt<{ confirmSave: boolean }>([
            {
                type: 'confirm',
                name: 'confirmSave',
                message: 'Save this proxy configuration?',
                default: true,
            },
        ]);
        if (!confirmSave) {
            console.log(chalk.yellow('Proxy configuration cancelled.'));
            return undefined;
        }
    }

    return parsed.data;
}

async function printStatus(): Promise<void> {
    const status = await describeProxy();
    const config = status.config;

    console.log(chalk.bold('\nProxy status'));
    console.log(`Mode: ${chalk.cyan(config.mode)}`);
    if (config.mode === 'manual' && config.manual) {
        const proxyUrl = `${config.manual.protocol}://${config.manual.host}:${config.manual.port}`;
        console.log(`Manual proxy: ${chalk.cyan(maskProxyUrl(proxyUrl))}`);
    }
    if (config.mode === 'pac') {
        console.log(`PAC script: ${chalk.cyan(config.pacUrl ?? 'not set')}`);
    }
    console.log(`Child processes inherit proxy: ${config.useForChildProcesses ? chalk.green('yes') : chalk.gray('no')}`);

    if (status.resolved) {
        const label = status.resolved.source === 'pac' ? 'PAC script' : 'Proxy';
        console.log(`Relay ${status.serverUrl}: ${chalk.cyan(maskProxyUrl(status.resolved.url))} ${chalk.gray(`(${status.resolved.source})`)}`);
        console.log(`Usable: ${status.agentReady ? chalk.green('yes') : chalk.red('no')}`);
    } else {
        console.log(`Relay ${status.serverUrl}: ${chalk.gray('direct (no proxy)')}`);
    }

    if (status.system) {
        const system = status.system;
        const detail = system.mode === 'pac'
            ? `PAC ${system.pacUrl}`
            : system.mode === 'manual'
                ? maskProxyUrl(system.httpsProxy ?? system.httpProxy ?? system.socksProxy ?? '')
                : 'none configured';
        console.log(`System proxy (${system.source}): ${chalk.cyan(detail)}`);
        if (system.exceptions.length > 0) {
            console.log(`System bypass: ${chalk.gray(system.exceptions.join(', '))}`);
        }
    }
    if (config.noProxy.length > 0) {
        console.log(`Configured bypass: ${chalk.gray(config.noProxy.join(', '))}`);
    }
    const environmentKeys = Object.keys(status.environment);
    if (environmentKeys.length > 0) {
        console.log(chalk.bold('\nProxy environment variables'));
        for (const key of environmentKeys) {
            console.log(`  ${key}=${status.environment[key]}`);
        }
    }
}

export async function handleProxyConfigure(args: string[]): Promise<void> {
    const flags = parseFlags(args);
    const config = await promptConfigure(flags);
    if (config) {
        await saveConfig(config);
    }
}

export async function handleProxyStatus(): Promise<void> {
    await configureProxy();
    await printStatus();
}

export async function handleProxyDisable(): Promise<void> {
    await configureProxy();
    const current = getProxyConfig();
    await saveConfig({ ...current, mode: 'off' });
}

export function handleProxyHelp(): void {
    console.log(`
${chalk.bold('happy proxy')} - Proxy configuration

${chalk.bold('Usage:')}
  happy proxy configure        Configure the proxy interactively
  happy proxy status           Show the proxy in effect
  happy proxy disable          Disable proxying (mode: off)
  happy proxy help             Show this help

${chalk.bold('Modes:')}
  env       Use HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY (default)
  system    Use the operating system proxy settings, including PAC
  pac       Resolve a specific PAC script per destination
  manual    Use an explicit http, https, socks4, socks5 or socks5h proxy
  off       Never proxy, and ignore the environment

${chalk.bold('Non-interactive flags:')}
  --mode <mode>            env | system | pac | manual | off
  --pac-url <url>          PAC script URL for --mode pac
  --protocol <protocol>    http | https | socks4 | socks4a | socks5 | socks5h
  --host <host> --port <port> --username <user> --password <pass>
  --no-proxy <list>        Comma separated bypass list
  --no-child-processes     Do not export the proxy to spawned agents
  --yes                    Skip the confirmation prompt

${chalk.bold('Examples:')}
  happy proxy configure --mode manual --protocol http --host 127.0.0.1 --port 7890 --yes
  happy proxy configure --mode system --yes
  happy proxy configure --mode pac --pac-url https://wpad.example.com/proxy.pac --yes
  happy proxy configure --mode manual --protocol socks5h --host 127.0.0.1 --port 1080 --yes
`);
}

export async function handleProxyCommand(args: string[]): Promise<void> {
    const subcommand = args[0];
    if (subcommand === 'status') {
        await handleProxyStatus();
        return;
    }
    if (subcommand === 'disable') {
        await handleProxyDisable();
        return;
    }
    if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        handleProxyHelp();
        return;
    }
    if (subcommand === undefined || subcommand === 'configure') {
        await handleProxyConfigure(args.slice(1));
        return;
    }
    console.log(chalk.red(`Unknown proxy subcommand: ${subcommand}`));
    handleProxyHelp();
}
