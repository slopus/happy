import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { applyLightDefaultEnv } from '@/flavors/light/env';

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

async function findBaselineMigrationDir(): Promise<string> {
    const entries = await readdir('prisma/sqlite/migrations', { withFileTypes: true });
    const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    const first = dirs[0];
    if (!first) {
        throw new Error('No prisma/sqlite/migrations/* directories found to use as a baseline.');
    }
    return first;
}

async function main() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    applyLightDefaultEnv(env);

    const dataDir = env.HAPPY_SERVER_LIGHT_DATA_DIR!;
    await mkdir(dataDir, { recursive: true });

    await run('yarn', ['-s', 'schema:sync', '--quiet'], env);

    const baseline = await findBaselineMigrationDir();
    await run(
        'yarn',
        ['-s', 'prisma', 'migrate', 'resolve', '--schema', 'prisma/sqlite/schema.prisma', '--applied', baseline],
        env
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
