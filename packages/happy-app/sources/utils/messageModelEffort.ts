import {
    DEFAULT_EFFORT_LABEL,
    DEFAULT_MODEL_LABEL,
} from '@/components/modelModeOptions';
import type { MessageMeta } from '@/sync/typesMessageMeta';

/**
 * Formats only the immutable per-message mode metadata. Deliberately does not
 * consult the current session config, so changing the composer never rewrites
 * the label shown beside an older user message.
 */
export function getMessageModelEffortLabel(
    meta: Pick<MessageMeta, 'model' | 'effort'> | null | undefined,
): string | null {
    if (!meta) {
        return null;
    }

    const parts: string[] = [];
    if (meta.model !== undefined) {
        parts.push(meta.model ?? DEFAULT_MODEL_LABEL);
    }
    if (meta.effort !== undefined) {
        parts.push(meta.effort ?? DEFAULT_EFFORT_LABEL);
    }

    return parts.length > 0 ? parts.join(' · ') : null;
}
