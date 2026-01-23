import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { applyLightDefaultEnv } from '@/flavors/light/env';
import { buildLightDevPlan } from './dev.lightPlan';

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

    const dataDir = env.HAPPY_SERVER_LIGHT_DATA_DIR!;
    const filesDir = env.HAPPY_SERVER_LIGHT_FILES_DIR!;
    const plan = buildLightDevPlan();

    // Ensure dirs exist so SQLite can create the DB file.
    await mkdir(dataDir, { recursive: true });
    await mkdir(filesDir, { recursive: true });

    // Ensure sqlite schema is present, then apply migrations (idempotent).
    await run('yarn', ['-s', 'schema:sync', '--quiet'], env);
    await run('yarn', plan.prismaDeployArgs, env);

    // Run the light flavor.
    await run('yarn', plan.startLightArgs, env);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
