import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';

/** Share local mode's override, package-manager and platform-shim resolution. */
export function installedClaudeExecutable(): string {
    const resolver = join(projectPath(), 'scripts', 'claude_version_utils.cjs');
    const output = execFileSync(process.execPath, ['-e', 'const r=require(process.argv[1]).findGlobalClaudeCliPath();process.stdout.write(JSON.stringify(r))', resolver], {
        encoding: 'utf8', timeout: 3_000, maxBuffer: 16 * 1024, windowsHide: true,
    });
    const result = JSON.parse(output);
    if (!result?.path) throw new Error('Claude CLI is unavailable');
    return result.path;
}
