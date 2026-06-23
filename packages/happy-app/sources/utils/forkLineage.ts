// Pure helpers for nesting forked sessions in the session list.
//
// Kept free of React / React-Native imports so the ordering logic stays
// unit-testable (storage.ts and the renderer components both pull in RN and
// cannot be loaded under vitest).

export const FORK_INDENT_SIZE = 20;
export const FORK_MAX_VISUAL_DEPTH = 4;

/** Minimal shape the fork ordering needs from a session row. */
export interface ForkLineageRow {
    id: string;
    parentSessionId: string | null;
    forkDepth: number;
}

/** Left padding for a row at `forkDepth`, added on top of the row's base padding. */
export function forkIndentPadding(forkDepth: number, basePadding: number): number {
    const visualDepth = Math.min(Math.max(forkDepth, 0), FORK_MAX_VISUAL_DEPTH);
    return basePadding + visualDepth * FORK_INDENT_SIZE;
}

/**
 * Reorder a flat array of session rows so that forked children appear
 * immediately after their parent (depth-first) and stamp each row's `forkDepth`
 * (0 = root within this array). A row whose parent is NOT present in the same
 * array is treated as a root at depth 0 — nesting therefore happens only within
 * a single rendered section (a date group, or an active project group), never
 * across section boundaries. New row objects are returned when a row's depth
 * changes so deep-equality still detects the update. O(n).
 */
export function orderSessionRowsByForkLineage<T extends ForkLineageRow>(rows: T[]): T[] {
    const atRoot = (r: T): T => (r.forkDepth === 0 ? r : { ...r, forkDepth: 0 } as T);
    if (rows.length < 2) {
        return rows.map(atRoot);
    }

    const present = new Set(rows.map(r => r.id));
    const childrenByParent = new Map<string, T[]>();
    const roots: T[] = [];

    for (const row of rows) {
        const parentId = row.parentSessionId;
        if (parentId && parentId !== row.id && present.has(parentId)) {
            const siblings = childrenByParent.get(parentId);
            if (siblings) {
                siblings.push(row);
            } else {
                childrenByParent.set(parentId, [row]);
            }
        } else {
            roots.push(row);
        }
    }

    // No fork relationships within this array — keep original order at depth 0.
    if (childrenByParent.size === 0) {
        return rows.map(atRoot);
    }

    const ordered: T[] = [];
    const visited = new Set<string>();

    const emit = (row: T, depth: number) => {
        if (visited.has(row.id)) {
            return; // guard against pathological parent cycles
        }
        visited.add(row.id);
        ordered.push(row.forkDepth === depth ? row : { ...row, forkDepth: depth } as T);
        const children = childrenByParent.get(row.id);
        if (children) {
            for (const child of children) {
                emit(child, depth + 1);
            }
        }
    };

    for (const root of roots) {
        emit(root, 0);
    }

    // Safety net: emit any rows skipped by a cycle, at depth 0, preserving order.
    if (ordered.length !== rows.length) {
        for (const row of rows) {
            if (!visited.has(row.id)) {
                ordered.push(atRoot(row));
            }
        }
    }

    return ordered;
}
