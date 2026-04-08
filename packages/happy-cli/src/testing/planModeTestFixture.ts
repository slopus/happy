/**
 * Creates an isolated test fixture directory for plan mode integration tests.
 *
 * Sets up a minimal project with hello-world.js in a git repo under /tmp/,
 * so Claude Code has a valid working directory with version control.
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

const HELLO_WORLD_JS = `function greet(name) {
    console.log("Hello, " + name + "!");
}

greet("World");
`;

export function createPlanModeFixture(): { dir: string; cleanup: () => void } {
    const dir = join('/tmp', `happy-testing-ground-${randomBytes(4).toString('hex')}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hello-world.js'), HELLO_WORLD_JS);
    execSync('git init && git add -A && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
    return {
        dir,
        cleanup: () => rmSync(dir, { force: true, recursive: true }),
    };
}
