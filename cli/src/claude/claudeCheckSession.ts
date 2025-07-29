import { logger } from "@/ui/logger";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectPath } from "./path";

export function claudeCheckSession(sessionId: string, path: string) {
    const projectDir = getProjectPath(path);

    // Check if session id is in the project dir
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);
    const sessionExists = existsSync(sessionFile);
    if (!sessionExists) {
        logger.debug(`[claudeCheckSession] Path ${sessionFile} does not exist`);
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