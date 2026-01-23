import { spawn } from 'node:child_process';
import tmp from 'tmp';

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            env: env as Record<string, string>,
            stdio: 'inherit',
            shell: false,
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
}

function parseNameArg(argv: string[]): { name: string | null; passthrough: string[] } {
    const passthrough: string[] = [];
    let name: string | null = null;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--name') {
            const next = argv[i + 1];
            if (!next) {
                throw new Error('Missing value for --name');
            }
            name = next;
            i++;
            continue;
        }
        if (a.startsWith('--name=')) {
            name = a.slice('--name='.length);
            continue;
        }
        passthrough.push(a);
    }

    return { name, passthrough };
}

async function main() {
    const { name, passthrough } = parseNameArg(process.argv.slice(2));
    if (!name || !name.trim()) {
        throw new Error('Missing --name. Example: yarn migrate:light:new -- --name add_my_table');
    }

    const env: NodeJS.ProcessEnv = { ...process.env };

    // Use an isolated temp DB file so creating migrations never touches a user's real light DB.
    const dbFile = tmp.fileSync({ prefix: 'happy-server-light-migrate-', postfix: '.sqlite' }).name;
    env.DATABASE_URL = `file:${dbFile}`;

    await run('yarn', ['-s', 'schema:sync', '--quiet'], env);
    await run(
        'yarn',
        [
            '-s',
            'prisma',
            'migrate',
            'dev',
            '--schema',
            'prisma/sqlite/schema.prisma',
            '--name',
            name,
            '--create-only',
            '--skip-generate',
            '--skip-seed',
            ...passthrough,
        ],
        env
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
