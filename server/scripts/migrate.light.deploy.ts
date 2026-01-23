import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { applyLightDefaultEnv } from '@/flavors/light/env';
import { requireLightDataDir } from './migrate.light.deployPlan';

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

async function main() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    applyLightDefaultEnv(env);

    const dataDir = requireLightDataDir(env);
    await mkdir(dataDir, { recursive: true });

    await run('yarn', ['-s', 'schema:sync', '--quiet'], env);
    await run('yarn', ['-s', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/sqlite/schema.prisma'], env);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
