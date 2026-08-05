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
    flavor?: string | null,
): string | null {
    if (!meta) {
        return null;
    }

    const parts: string[] = [];
    if (meta.model !== undefined) {
        parts.push(meta.model ?? DEFAULT_MODEL_LABEL);
    }
    // ACP runners currently apply per-turn model but not effort. Filter stale
    // or externally supplied effort metadata for those sessions so a historic
    // label never claims a configuration the agent did not receive. Missing
    // flavor follows the repository's legacy convention and means Claude.
    const supportsEffort = !flavor || flavor === 'claude' || flavor === 'codex';
    if (supportsEffort && meta.effort !== undefined) {
        parts.push(meta.effort ?? DEFAULT_EFFORT_LABEL);
    }

    return parts.length > 0 ? parts.join(' · ') : null;
}
