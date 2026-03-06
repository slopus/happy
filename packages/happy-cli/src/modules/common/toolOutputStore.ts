import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

export interface ToolOutputRecord {
    callId: string;
    toolName: string;
    agent: 'claude' | 'codex' | 'gemini';
    result: unknown;
    timestamp: number;
}

const toolOutputsDir = join(configuration.happyHomeDir, 'tool-outputs');

function ensureToolOutputsDir(): void {
    if (!existsSync(toolOutputsDir)) {
        mkdirSync(toolOutputsDir, { recursive: true });
    }
}

function getFilePath(sessionId: string): string {
    return join(toolOutputsDir, `${sessionId}.json`);
}

export function saveToolOutputRecord(sessionId: string, record: ToolOutputRecord): void {
    try {
        ensureToolOutputsDir();
        const filePath = getFilePath(sessionId);

        let existing: ToolOutputRecord[] = [];
        if (existsSync(filePath)) {
            try {
                existing = JSON.parse(readFileSync(filePath, 'utf-8'));
            } catch {
                existing = [];
            }
        }

        existing.push(record);
        writeFileSync(filePath, JSON.stringify(existing), 'utf-8');
        logger.debug(`[ToolOutputStore] Saved output for ${record.toolName} (${record.callId}) in session ${sessionId}`);
    } catch (error) {
        logger.warn('[ToolOutputStore] Failed to save tool output record:', error);
    }
}

export function getToolOutputRecord(sessionId: string, callId: string): ToolOutputRecord | null {
    try {
        const filePath = getFilePath(sessionId);
        if (!existsSync(filePath)) return null;

        const records: ToolOutputRecord[] = JSON.parse(readFileSync(filePath, 'utf-8'));
        return records.find((record) => record.callId === callId) || null;
    } catch (error) {
        logger.warn('[ToolOutputStore] Failed to get tool output record:', error);
        return null;
    }
}
