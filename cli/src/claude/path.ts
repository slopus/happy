import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function getProjectPath(workingDirectory: string) {
    const projectId = resolve(workingDirectory).replace(/[\/\.]/g, '-');
    return join(homedir(), '.claude', 'projects', projectId);
}