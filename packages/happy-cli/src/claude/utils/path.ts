import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** `env` is the one Claude runs with: `--claude-env` can point CLAUDE_CONFIG_DIR elsewhere. */
export function getProjectPath(workingDirectory: string, env: NodeJS.ProcessEnv = process.env) {
    const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9-]/g, '-');
    const claudeConfigDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectId);
}