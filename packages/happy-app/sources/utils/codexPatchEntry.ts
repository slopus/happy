/**
 * Reading Codex / Gemini `apply_patch` payloads.
 *
 * The shape varies by provider version — a map or a list, a unified diff or a
 * pair of blobs — so everything that decides "what changed in this file" lives
 * here, away from the rendering, where it can be tested against real payloads.
 */

export type CodexPatchEntry = {
    diff?: string;
    unified_diff?: string;
    type?: string;
    content?: string;
    move_path?: string | null;
    oldContent?: string;
    newContent?: string;
    old_content?: string;
    new_content?: string;
    kind?: {
        type?: string;
        move_path?: string | null;
    };
    add?: {
        content?: string;
    };
    modify?: {
        old_content?: string;
        new_content?: string;
    };
    delete?: {
        content?: string;
    };
};

export type PatchInput =
    | { kind: 'patch'; patch: string }
    | { kind: 'pair'; oldText: string; newText: string };

export function getPatchChanges(input: any): Record<string, CodexPatchEntry> | null {
    if (Array.isArray(input?.changes)) {
        return normalizePatchChangeList(input.changes);
    }
    if (input?.changes && typeof input.changes === 'object') {
        return input.changes as Record<string, CodexPatchEntry>;
    }
    if (Array.isArray(input?.fileChanges)) {
        return normalizePatchChangeList(input.fileChanges);
    }
    if (input?.fileChanges && typeof input.fileChanges === 'object') {
        return input.fileChanges as Record<string, CodexPatchEntry>;
    }
    return null;
}

export function normalizePatchChangeList(changes: unknown[]): Record<string, CodexPatchEntry> | null {
    const normalized: Record<string, CodexPatchEntry> = {};

    for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
            continue;
        }

        const changeRecord = change as Record<string, unknown>;
        const path = typeof changeRecord.path === 'string' ? changeRecord.path : null;
        if (!path) {
            continue;
        }

        const kind = changeRecord.kind && typeof changeRecord.kind === 'object' && !Array.isArray(changeRecord.kind)
            ? changeRecord.kind as { type?: string; move_path?: string | null }
            : null;
        const type = typeof changeRecord.type === 'string' ? changeRecord.type : (kind?.type ?? null);
        const entry: CodexPatchEntry = {
            ...(kind ? { kind } : type ? { kind: { type, move_path: null } } : {}),
        };

        if (typeof changeRecord.diff === 'string') {
            entry.diff = changeRecord.diff;
        } else if (typeof changeRecord.unified_diff === 'string') {
            entry.unified_diff = changeRecord.unified_diff;
        }

        if (changeRecord.add && typeof changeRecord.add === 'object' && !Array.isArray(changeRecord.add)) {
            entry.add = changeRecord.add as { content?: string };
        }
        if (changeRecord.modify && typeof changeRecord.modify === 'object' && !Array.isArray(changeRecord.modify)) {
            entry.modify = changeRecord.modify as { old_content?: string; new_content?: string };
        }
        if (changeRecord.delete && typeof changeRecord.delete === 'object' && !Array.isArray(changeRecord.delete)) {
            entry.delete = changeRecord.delete as { content?: string };
        }

        if (type === 'add' && typeof changeRecord.content === 'string') {
            entry.add = { content: changeRecord.content };
        }
        if (type === 'delete' && typeof changeRecord.content === 'string') {
            entry.delete = { content: changeRecord.content };
        }

        normalized[path] = entry;
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
}

/**
 * Codex reuses the `diff` field for two different things: an `update` carries a
 * real unified diff, while `add` and `delete` carry the file body verbatim — no
 * `@@` header, no `+`/`-` prefixes. Handing that body to a patch parser finds no
 * hunks and renders as "no changes", so the cases are told apart by looking at
 * the payload rather than by trusting the field name.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
    return /^@@+ -/m.test(text) || text.startsWith('--- ') || text.startsWith('diff --git ');
}

function wholeFileInput(kind: string | null, content: string): PatchInput {
    return kind === 'delete'
        ? { kind: 'pair', oldText: content, newText: '' }
        : { kind: 'pair', oldText: '', newText: content };
}

export function getPatchInput(change: CodexPatchEntry): PatchInput | null {
    const kindType = getPatchKindType(change);

    if (typeof change.diff === 'string') {
        return looksLikeUnifiedDiff(change.diff)
            ? { kind: 'patch', patch: change.diff }
            : wholeFileInput(kindType, change.diff);
    }
    if (typeof change.unified_diff === 'string') {
        return looksLikeUnifiedDiff(change.unified_diff)
            ? { kind: 'patch', patch: change.unified_diff }
            : wholeFileInput(kindType, change.unified_diff);
    }
    if (change.modify) {
        return { kind: 'pair', oldText: change.modify.old_content || '', newText: change.modify.new_content || '' };
    }
    if (typeof change.oldContent === 'string' || typeof change.newContent === 'string') {
        return { kind: 'pair', oldText: change.oldContent || '', newText: change.newContent || '' };
    }
    if (typeof change.old_content === 'string' || typeof change.new_content === 'string') {
        return { kind: 'pair', oldText: change.old_content || '', newText: change.new_content || '' };
    }
    if (change.add) {
        return { kind: 'pair', oldText: '', newText: change.add.content || '' };
    }
    if (kindType === 'add' && typeof change.content === 'string') {
        return { kind: 'pair', oldText: '', newText: change.content };
    }
    if (change.delete) {
        return { kind: 'pair', oldText: change.delete.content || '', newText: '' };
    }
    if (kindType === 'delete' && typeof change.content === 'string') {
        return { kind: 'pair', oldText: change.content, newText: '' };
    }
    return null;
}

export function getPatchKindType(change: CodexPatchEntry): string | null {
    return change.kind?.type ?? change.type ?? null;
}

export function getPatchKindLabel(change: CodexPatchEntry): string | null {
    switch (getPatchKindType(change)) {
        case 'add':
            return 'new';
        case 'delete':
            return 'delete';
        case 'update':
            return getPatchMovePath(change) ? 'move' : 'edit';
        default:
            return null;
    }
}

export function getPatchMovePath(change: CodexPatchEntry): string | null {
    return change.kind?.move_path ?? change.move_path ?? null;
}
