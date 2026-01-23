import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getProjectPath(workingDirectory: string, claudeConfigDirOverride?: string | null) {
    const projectId = resolve(workingDirectory).replace(/[\\\/\.: _]/g, '-');
    const claudeConfigDirRaw = claudeConfigDirOverride ?? process.env.CLAUDE_CONFIG_DIR ?? '';
    const claudeConfigDirTrimmed = claudeConfigDirRaw.trim();
    const claudeConfigDir = claudeConfigDirTrimmed ? claudeConfigDirTrimmed : join(homedir(), '.claude');
    return join(claudeConfigDir, 'projects', projectId);
}
