export type OrchestratorSubmitTaskInput = {
    taskKey?: string;
    title?: string;
    provider?: string;
    model?: string;
    prompt?: string;
    dependsOn?: string[];
    timeoutMs?: number;
};

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isOrchestratorSubmitToolName(toolName?: string): boolean {
    if (!toolName) {
        return false;
    }
    const normalized = toolName.replace(/:/g, '__');
    return /(^|__)orchestrator_submit$/.test(normalized);
}

export function parseOrchestratorSubmitTasks(value: unknown): OrchestratorSubmitTaskInput[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((task) => {
        if (!isPlainObject(task)) {
            return [];
        }

        const dependsOn = Array.isArray(task.dependsOn)
            ? task.dependsOn.filter((item): item is string => typeof item === 'string')
            : undefined;

        return [{
            taskKey: asString(task.taskKey),
            title: asString(task.title),
            provider: asString(task.provider),
            model: asString(task.model),
            prompt: asString(task.prompt),
            dependsOn,
            timeoutMs: asNumber(task.timeoutMs),
        } satisfies OrchestratorSubmitTaskInput];
    });
}

export function formatPromptPreview(prompt: string, maxLength = 220): string {
    const trimmed = prompt.trim();
    if (trimmed.length <= maxLength) {
        return trimmed;
    }
    return `${trimmed.slice(0, maxLength)}…`;
}

