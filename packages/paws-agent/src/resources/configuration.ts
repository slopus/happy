import { PawsAgentError } from '../client/errors';
import type { SessionConfiguration, TurnConfiguration, ConfigurationOption } from '../client/types';

export function configurationMeta(value?: TurnConfiguration): Record<string, unknown> {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PawsAgentError('INVALID_ARGUMENT', 'Invalid turn configuration');
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
        if (key !== 'model' && key !== 'effort') throw new PawsAgentError('INVALID_ARGUMENT', 'Unknown configuration field');
        const item = value[key];
        if (item === undefined) continue;
        if (item !== null && (typeof item !== 'string' || !item.trim() || item.length > 256)) throw new PawsAgentError('INVALID_ARGUMENT', `Invalid ${key}`);
        if (key === 'effort' && item !== null && !['none','minimal','low','medium','high','xhigh','max','ultra'].includes(item)) throw new PawsAgentError('INVALID_ARGUMENT', 'Invalid reasoning effort');
        result[key] = item;
    }
    return result;
}

export function readConfiguration(metadata: unknown): SessionConfiguration {
    const m = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
    const options = (value: unknown): ConfigurationOption[] => !Array.isArray(value) ? [] : value.flatMap(option => {
        if (!option || typeof option.code !== 'string' || !option.code.trim()) return [];
        return [{ code: option.code, label: typeof option.value === 'string' ? option.value : option.code,
            ...(typeof option.description === 'string' ? { description: option.description } : {}) }];
    });
    return { model: typeof m.currentModelCode === 'string' ? m.currentModelCode : null,
        effort: typeof m.currentThoughtLevelCode === 'string' ? m.currentThoughtLevelCode : null,
        models: options(m.models), efforts: options(m.thoughtLevels) };
}
