import chalk from 'chalk';
import inquirer from 'inquirer';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import {
    SandboxConfigSchema,
    readSettings,
    updateSettings,
    type SandboxConfig,
} from '@/persistence';

const DEFAULT_WORKSPACE_ROOT = '~/Workspace';
const DEFAULT_DENY_READ_PATHS = ['~/.ssh', '~/.aws', '~/.gnupg'];

type ScopeMode = 'workspace' | 'project';

function workspaceCandidatesForPlatform(platform: NodeJS.Platform): string[] {
    if (platform === 'darwin') {
        return ['~/Developer', '~/Develop', '~/Workspace'];
    }
    if (platform === 'linux') {
        return ['~/Workspace', '~/Developer', '~/Develop'];
    }
    return ['~/Developer', '~/Develop', '~/Workspace'];
}

export function detectWorkspaceRootSuggestions(options?: {
    platform?: NodeJS.Platform;
    home?: string;
    pathExists?: (path: string) => boolean;
}): string[] {
    const platform = options?.platform ?? process.platform;
    const home = options?.home ?? homedir();
    const pathExists = options?.pathExists ?? existsSync;
    const candidates = workspaceCandidatesForPlatform(platform);
    const existing = candidates.filter((candidate) => {
        const absolutePath = candidate.replace(/^~(?=\/|$)/, home);
        return pathExists(absolutePath);
    });
    if (existing.length > 0) {
        return existing;
    }

    return [candidates[0] ?? DEFAULT_WORKSPACE_ROOT];
}

export async function handleSandboxCommand(args: string[]): Promise<void> {
    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        handleSandboxHelp();
        return;
    }

    switch (subcommand) {
        case 'configure':
            await handleSandboxConfigure();
            break;
        case 'status':
            await handleSandboxStatus();
            break;
        case 'disable':
            await handleSandboxDisable();
            break;
        default:
            console.error(chalk.red(`Unknown sandbox subcommand: ${subcommand}`));
            handleSandboxHelp();
            process.exit(1);
    }
}

export async function handleSandboxConfigure(): Promise<void> {
    const workspaceRootSuggestions = detectWorkspaceRootSuggestions();
    const workspaceRootDefault = workspaceRootSuggestions[0] ?? DEFAULT_WORKSPACE_ROOT;

    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'scopeMode',
            message: 'How should file access be scoped?',
            default: 'workspace',
            choices: [
                { name: 'workspace - Full workspace root directory', value: 'workspace' },
                { name: 'per-project - Only current project directory', value: 'project' },
            ],
        },
        {
            type: 'list',
            name: 'workspaceRoot',
            message: 'Pick your workspace root directory',
            when: (currentAnswers) => currentAnswers.scopeMode === 'workspace',
            default: workspaceRootDefault,
            choices: workspaceRootSuggestions.map((pathValue) => ({
                name: `${pathValue}${existsSync(pathValue.replace(/^~(?=\/|$)/, homedir())) ? '' : ' (suggested)'}`,
                value: pathValue,
            })),
        },
        {
            type: 'list',
            name: 'networkMode',
            message: 'How should network access be handled?',
            default: 'allowed',
            choices: [
                { name: 'allowed - Allow all network access (default)', value: 'allowed' },
                { name: 'blocked - Block all network access (most secure)', value: 'blocked' },
            ],
        },
        {
            type: 'confirm',
            name: 'allowLocalBinding',
            message: 'Allow binding to localhost ports? (for dev servers)',
            default: true,
        },
    ]);

    const scopeMode: ScopeMode = answers.scopeMode;
    const sandboxConfig: SandboxConfig = SandboxConfigSchema.parse({
        enabled: true,
        workspaceRoot: scopeMode === 'workspace' ? answers.workspaceRoot || workspaceRootDefault : undefined,
        sessionIsolation: scopeMode === 'workspace' ? 'workspace' : 'strict',
        customWritePaths: [],
        denyReadPaths: DEFAULT_DENY_READ_PATHS,
        extraWritePaths: ['/tmp'],
        denyWritePaths: ['.env'],
        networkMode: answers.networkMode,
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: Boolean(answers.allowLocalBinding),
    });

    console.log(chalk.bold('\nSandbox configuration summary:'));
    console.log(JSON.stringify(sandboxConfig, null, 2));

    const { confirmSave } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'confirmSave',
            message: 'Save and enable this sandbox configuration?',
            default: true,
        },
    ]);

    if (!confirmSave) {
        console.log(chalk.yellow('Sandbox configuration cancelled.'));
        return;
    }

    await updateSettings((settings) => ({
        ...settings,
        sandboxConfig,
    }));

    console.log(chalk.green('Sandbox configuration saved and enabled.'));
    console.log(chalk.gray('Use --no-sandbox to bypass sandboxing for a single session.'));
}

export async function handleSandboxStatus(): Promise<void> {
    const settings = await readSettings();
    const config = settings.sandboxConfig;

    if (!config) {
        console.log('Sandbox is not configured. Run `happy sandbox configure`.');
        return;
    }

    console.log(chalk.bold('Sandbox status'));
    console.log(`Enabled: ${config.enabled ? 'yes' : 'no'}`);
    const scope = config.sessionIsolation === 'workspace' ? 'workspace' : 'per-project';
    console.log(`Scope: ${scope}`);
    if (scope === 'workspace') {
        console.log(`Workspace root: ${config.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT}`);
    }
    console.log(`Network mode: ${config.networkMode}`);
    console.log(`Allow localhost binding: ${config.allowLocalBinding ? 'yes' : 'no'}`);
}

export async function handleSandboxDisable(): Promise<void> {
    await updateSettings((settings) => ({
        ...settings,
        sandboxConfig: SandboxConfigSchema.parse({
            ...(settings.sandboxConfig ?? {}),
            enabled: false,
        }),
    }));

    console.log(chalk.green('Sandbox disabled.'));
}

export function handleSandboxHelp(): void {
    console.log(`
${chalk.bold('happy sandbox')} - Sandbox management

${chalk.bold('Usage:')}
  happy sandbox configure      Configure sandbox settings interactively
  happy sandbox status         Show current sandbox configuration
  happy sandbox disable        Disable sandboxing
  happy sandbox help           Show this help
`);
}
