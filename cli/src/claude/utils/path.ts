import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getProjectPath(workingDirectory: string) {
    const projectId = resolve(workingDirectory).replace(/[\\\/\.: _]/g, '-');
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectId);
}