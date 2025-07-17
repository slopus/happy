import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

export function claudeCheckSession(sessionId: string, path: string) {
    const projectName = resolve(path).replace(/\//g, '-')
    const projectDir = join(homedir(), '.claude', 'projects', projectName);

    // Check if session id is in the project dir
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);
    const sessionExists = existsSync(sessionFile);
    if (!sessionExists) {
        return false;
    }

    // Check if session contains any messages
    const sessionData = readFileSync(sessionFile, 'utf-8').split('\n');
    const hasGoodMessage = !!sessionData.find((v) => {
        try {
            return typeof JSON.parse(v).uuid === 'string'
        } catch (e) {
            return false;
        }
    });

    return hasGoodMessage;
}