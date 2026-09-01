import { resolve } from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { discoverCurrentTranscript } from './adapters/discover';
import type { TranscriptCandidate } from './adapters/types';
import { installSkill, type InstallSkillResult, type InstallSkillTarget } from './installSkill';
import { ShareRecordStore, type PublicShareRecord } from './records';
import {
    inspectSession,
    renewManagedShare,
    revokeManagedShare,
    shareSession,
    type SessionInspection,
    type ShareSessionOptions,
    type ShareSessionResult,
} from './share';

const VERSION = '0.1.0-beta.0';
const DEFAULT_SERVER_URL = 'https://47.115.228.20:8443';

export type CliIo = {
    stdout: (value: string) => void;
    stderr: (value: string) => void;
};

export type CliDependencies = {
    inspectSession: (options: { candidate: TranscriptCandidate }) => Promise<SessionInspection>;
    shareSession: (options: ShareSessionOptions) => Promise<ShareSessionResult>;
    listRecords: () => Promise<PublicShareRecord[]>;
    renewManagedShare: (identifier: string) => Promise<{ publicId: string; expiresAt: string }>;
    revokeManagedShare: (identifier: string) => Promise<{ publicId: string; revoked: true }>;
    discoverCurrentTranscript: (options?: { cwd?: string }) => Promise<TranscriptCandidate>;
    installSkill: (options: { target: InstallSkillTarget }) => Promise<InstallSkillResult>;
    environment: NodeJS.ProcessEnv;
    cwd: () => string;
};

const processIo: CliIo = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
};

class CliExpectedError extends Error {
    constructor(message: string, readonly exitCode: number) {
        super(message);
    }
}

function defaults(): CliDependencies {
    const store = new ShareRecordStore();
    return {
        inspectSession,
        shareSession: (options) => shareSession({ ...options, store }),
        listRecords: () => store.list(),
        renewManagedShare: (identifier) => renewManagedShare(identifier, store),
        revokeManagedShare: (identifier) => revokeManagedShare(identifier, store),
        discoverCurrentTranscript,
        installSkill,
        environment: process.env,
        cwd: () => process.cwd(),
    };
}

function writeJson(io: CliIo, value: unknown): void {
    io.stdout(`${JSON.stringify(value)}\n`);
}

function writeInspection(io: CliIo, inspection: SessionInspection, json: boolean): void {
    if (json) {
        writeJson(io, inspection);
        return;
    }
    io.stdout([
        `Source: ${inspection.source}`,
        `Title: ${inspection.title}`,
        `Messages: ${inspection.messageCount}`,
        `Attachments: ${inspection.attachmentCount} (${inspection.attachmentBytes} bytes)`,
        `Unresolved attachments: ${inspection.unresolvedAttachmentCount}`,
        `Blocking secret findings: ${inspection.blockingFindingCount}`,
        `Privacy warnings: ${inspection.warningFindingCount}`,
        '',
    ].join('\n'));
}

type SourceOptions = {
    current?: boolean;
    source?: TranscriptCandidate['provider'];
    session?: string;
};

async function candidateFromOptions(options: SourceOptions, dependencies: CliDependencies): Promise<TranscriptCandidate> {
    if (options.current) {
        if (options.source || options.session) throw new CliExpectedError('--current cannot be combined with --source or --session', 2);
        return dependencies.discoverCurrentTranscript({ cwd: dependencies.cwd() });
    }
    if (!options.source || !options.session) {
        throw new CliExpectedError('Use --current or provide both --source and --session', 2);
    }
    return { provider: options.source, path: resolve(options.session) };
}

function addSourceOptions(command: Command): Command {
    return command
        .option('--current', 'select the only session matching the current directory')
        .addOption(new Option('--source <provider>', 'transcript provider').choices(['codex', 'claude-code']))
        .option('--session <path>', 'explicit transcript JSONL path');
}

function createProgram(io: CliIo, dependencies: CliDependencies) {
    const program = new Command()
        .name('paws-share')
        .description('Publish Codex and Claude Code sessions as read-only Paws snapshots')
        .version(VERSION)
        .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
        .exitOverride();

    addSourceOptions(program.command('inspect').description('Inspect a local session before sharing'))
        .option('--json', 'print JSON output')
        .action(async (options: SourceOptions & { json?: boolean }) => {
            const candidate = await candidateFromOptions(options, dependencies);
            writeInspection(io, await dependencies.inspectSession({ candidate }), Boolean(options.json));
        });

    addSourceOptions(program.command('share').description('Create a public snapshot link'))
        .option('--server <url>', 'Paws Share server URL')
        .option('--yes', 'confirm that the inspected snapshot will become public')
        .option('--allow-sensitive', 'override high-confidence secret findings')
        .option('--json', 'print JSON output')
        .action(async (options: SourceOptions & {
            server?: string;
            yes?: boolean;
            allowSensitive?: boolean;
            json?: boolean;
        }) => {
            const candidate = await candidateFromOptions(options, dependencies);
            if (!options.yes) {
                writeInspection(io, await dependencies.inspectSession({ candidate }), Boolean(options.json));
                throw new CliExpectedError('Public sharing requires explicit --yes after reviewing the disclosure', 2);
            }
            const serverUrl = options.server
                ?? dependencies.environment.PAWS_SHARE_SERVER_URL
                ?? dependencies.environment.HAPPY_SERVER_URL
                ?? DEFAULT_SERVER_URL;
            const result = await dependencies.shareSession({
                candidate,
                serverUrl,
                allowSensitive: Boolean(options.allowSensitive),
            });
            if (options.json) writeJson(io, result);
            else io.stdout(`Public link: ${result.publicUrl}\nExpires: ${result.expiresAt}\nManaged locally as: ${result.recordId}\n`);
        });

    program.command('list')
        .description('List locally managed public links')
        .option('--json', 'print JSON output')
        .action(async (options: { json?: boolean }) => {
            const records = await dependencies.listRecords();
            if (options.json) writeJson(io, records);
            else if (records.length === 0) io.stdout('No locally managed shares.\n');
            else io.stdout(`${records.map((record) => `${record.publicId}\t${record.source}\t${record.title}\t${record.expiresAt}`).join('\n')}\n`);
        });

    program.command('renew')
        .description('Renew a managed public link')
        .argument('<public-id>', 'local public ID')
        .option('--json', 'print JSON output')
        .action(async (identifier: string, options: { json?: boolean }) => {
            const result = await dependencies.renewManagedShare(identifier);
            if (options.json) writeJson(io, result);
            else io.stdout(`Renewed ${result.publicId} until ${result.expiresAt}\n`);
        });

    program.command('revoke')
        .description('Revoke a managed public link')
        .argument('<public-id>', 'local public ID')
        .option('--json', 'print JSON output')
        .action(async (identifier: string, options: { json?: boolean }) => {
            const result = await dependencies.revokeManagedShare(identifier);
            if (options.json) writeJson(io, result);
            else io.stdout(`Revoked ${result.publicId}\n`);
        });

    program.command('install-skill')
        .description('Install the portable session-sharing Agent Skill')
        .addOption(new Option('--target <agent>', 'agent skill root').choices(['codex', 'claude-code', 'all']).default('all'))
        .option('--json', 'print JSON output')
        .action(async (options: { target: InstallSkillTarget; json?: boolean }) => {
            const result = await dependencies.installSkill({ target: options.target });
            if (options.json) writeJson(io, result);
            else io.stdout(`${result.installed.map((path) => `Installed ${path}`).join('\n')}\n`);
        });
    return program;
}

function normalizeLegacyManagementId(argv: string[]): string[] {
    const commandIndex = argv.findIndex((value, index) => index >= 2 && (value === 'renew' || value === 'revoke'));
    if (commandIndex < 0) return argv;
    const commandArguments = argv.slice(commandIndex + 1);
    if (commandArguments.includes('--')) return argv;
    const identifier = commandArguments.find((value) => value !== '--json');
    if (!identifier || !/^-[A-Za-z0-9_-]{42}$/.test(identifier)) return argv;
    if (commandArguments.some((value) => value !== '--json' && value !== identifier)) return argv;
    return [
        ...argv.slice(0, commandIndex + 1),
        ...commandArguments.filter((value) => value === '--json'),
        '--',
        identifier,
    ];
}

export async function runCli(
    argv = process.argv,
    io: CliIo = processIo,
    overrides: Partial<CliDependencies> = {},
): Promise<number> {
    const dependencies = { ...defaults(), ...overrides };
    try {
        await createProgram(io, dependencies).parseAsync(normalizeLegacyManagementId(argv));
        return 0;
    } catch (error) {
        if (error instanceof CommanderError) {
            if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return 0;
            return error.exitCode;
        }
        if (error instanceof CliExpectedError) {
            io.stderr(`Error: ${error.message}\n`);
            return error.exitCode;
        }
        io.stderr(`Error: ${error instanceof Error ? error.message : 'Unknown failure'}\n`);
        return 1;
    }
}
