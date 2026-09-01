import { Command, CommanderError } from 'commander';

const VERSION = '0.1.0-beta.0';

export type CliIo = {
    stdout: (value: string) => void;
    stderr: (value: string) => void;
};

const processIo: CliIo = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
};

function createProgram(io: CliIo) {
    const program = new Command()
        .name('paws-share')
        .description('Publish Codex and Claude Code sessions as read-only Paws snapshots')
        .version(VERSION)
        .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
        .exitOverride();

    program.command('inspect').description('Inspect a local session before sharing');
    program.command('share').description('Create a public snapshot link');
    program.command('list').description('List locally managed public links');
    program.command('renew').description('Renew a managed public link');
    program.command('revoke').description('Revoke a managed public link');
    program.command('install-skill').description('Install the portable session-sharing Agent Skill');
    return program;
}

export async function runCli(argv = process.argv, io: CliIo = processIo): Promise<number> {
    try {
        await createProgram(io).parseAsync(argv);
        return 0;
    } catch (error) {
        if (error instanceof CommanderError) {
            if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return 0;
            return error.exitCode;
        }
        throw error;
    }
}
