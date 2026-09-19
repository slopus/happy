import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CodexAppServerClient } from './codexAppServerClient';

it('waits for the producer to finish its last credential write before returning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-shutdown-'));
    const output = join(root, 'last-write');
    const child = spawn(process.execPath, ['-e', `
        process.on('SIGTERM', () => setTimeout(() => {
            require('node:fs').writeFileSync(process.argv[1], 'saved');
            process.exit(0);
        }, 100));
        setInterval(() => {}, 1000);
        process.stdout.write('ready');
    `, output], { stdio: 'pipe' });
    try {
        await once(child.stdout!, 'data');
        const client = new CodexAppServerClient();
        // Exercise shutdown with a real OS process, without starting Codex or using an account.
        (client as unknown as { process: ChildProcess }).process = child;
        await client.disconnect({ waitForExit: true });
        expect(child.exitCode).toBe(0);
        expect(await readFile(output, 'utf8')).toBe('saved');
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
        }
        await rm(root, { recursive: true, force: true });
    }
});
