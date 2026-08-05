import type { MessageMeta } from '@/sync/typesMessageMeta';
import { getMessageModelEffortLabel } from './messageModelEffort';
import { getTaskPermissionLevelForAgentMode } from './taskPermissionModes';

type Translate = (key: any) => string;

/**
 * Formats immutable per-message execution metadata. It never reads current
 * session overrides, so later composer changes cannot rewrite history.
 */
export function getMessageExecutionModeLabel(
    meta: Pick<MessageMeta, 'permissionMode' | 'model' | 'effort'> | null | undefined,
    flavor: string | null | undefined,
    translate: Translate,
): string | null {
    if (!meta) {
        return null;
    }

    const parts: string[] = [];
    const permissionLevel = getTaskPermissionLevelForAgentMode(flavor, meta.permissionMode);
    if (permissionLevel === 'confirm') {
        parts.push(translate('agentInput.taskPermission.confirm'));
    } else if (permissionLevel === 'full-access') {
        parts.push(translate('agentInput.taskPermission.fullAccess'));
    }

    const modelEffort = getMessageModelEffortLabel(meta, flavor);
    if (modelEffort) {
        parts.push(modelEffort);
    }

    return parts.length > 0 ? parts.join(' · ') : null;
}
