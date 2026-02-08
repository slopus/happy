import { readFileSync } from 'node:fs';
import { logError, logWarn } from './log';

type PromptVars = Record<string, string | number | boolean | null | undefined>;

function coerceVarValue(value: PromptVars[string]): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    return String(value);
}

const templatePattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function renderPromptTemplate(template: string, vars: PromptVars): string {
    const missing = new Set<string>();

    const rendered = template.replace(templatePattern, (_match, key: string) => {
        if (!(key in vars)) {
            missing.add(key);
            return '';
        }
        return coerceVarValue(vars[key]);
    });

    if (missing.size > 0) {
        logWarn('Prompt template missing variables', {
            keys: [...missing.values()].slice(0, 50),
        });
    }

    return rendered;
}

const cachedFiles = new Map<string, string>();

export function loadPromptFile(filePath: string): string {
    const cached = cachedFiles.get(filePath);
    if (cached !== undefined) {
        return cached;
    }

    try {
        const content = readFileSync(filePath, 'utf8');
        cachedFiles.set(filePath, content);
        return content;
    } catch (error) {
        logError('Failed to read prompt file', {
            filePath,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
}

export function loadAndRenderPromptFile(filePath: string, vars: PromptVars): string {
    const template = loadPromptFile(filePath);
    return renderPromptTemplate(template, vars).trim();
}

