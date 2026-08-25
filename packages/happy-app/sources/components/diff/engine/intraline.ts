/**
 * Word-level highlighting inside changed lines.
 *
 * This is what separates a readable diff from a wall of red and green: when a
 * line only had one identifier renamed, we want to point at the identifier, not
 * repaint the whole line. GitHub and Cursor both do this; the trick is to only
 * do it for lines that are actually related, otherwise the emphasis is noise.
 */

import { diffWordsWithSpace } from 'diff';
import type { RawLine } from './parsePatch';

export type Range = [start: number, end: number];

/** Emphasis ranges keyed by index into the hunk's line array. */
export type EmphasisMap = Map<number, Range[]>;

/** Lines longer than this skip word diffing — the O(n·m) cost isn't worth it. */
const MAX_LINE_FOR_WORD_DIFF = 1500;
/** Below this similarity the two lines are unrelated; whole-line color reads better. */
const MIN_SIMILARITY = 0.34;
/** A changed block bigger than this is almost never a 1:1 edit; skip pairing. */
const MAX_BLOCK_FOR_PAIRING = 60;

/**
 * Cheap similarity: shared prefix and suffix over max length, which is exactly
 * the signal we care about (one edit in the middle of an otherwise equal line)
 * and costs O(n) instead of the O(n³) a substring search would.
 */
export function similarity(a: string, b: string): number {
    if (a === b) return 1;
    const max = Math.max(a.length, b.length);
    if (max === 0) return 1;
    const min = Math.min(a.length, b.length);
    let prefix = 0;
    while (prefix < min && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
    let suffix = 0;
    while (
        suffix < min - prefix &&
        a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
    ) suffix++;
    return (prefix + suffix) / max;
}

/** Word-level diff of one line pair, as character ranges on each side. */
export function wordRanges(oldLine: string, newLine: string): { del: Range[]; ins: Range[] } {
    if (oldLine.length > MAX_LINE_FOR_WORD_DIFF || newLine.length > MAX_LINE_FOR_WORD_DIFF) {
        return { del: [[0, oldLine.length]], ins: [[0, newLine.length]] };
    }

    const parts = diffWordsWithSpace(oldLine, newLine);
    const del: Range[] = [];
    const ins: Range[] = [];
    let oldPos = 0;
    let newPos = 0;

    for (const part of parts) {
        const len = part.value.length;
        if (part.added) {
            pushRange(ins, newPos, newPos + len);
            newPos += len;
        } else if (part.removed) {
            pushRange(del, oldPos, oldPos + len);
            oldPos += len;
        } else {
            oldPos += len;
            newPos += len;
        }
    }
    return { del, ins };
}

/** Appends a range, coalescing with the previous one when they touch. */
function pushRange(ranges: Range[], start: number, end: number): void {
    if (end <= start) return;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === start) last[1] = end;
    else ranges.push([start, end]);
}

/**
 * Walks a hunk's lines, finds `-` runs immediately followed by `+` runs, pairs
 * them up and records emphasis ranges for both sides.
 *
 * Pairing is positional (i-th removal with i-th addition) because that matches
 * how edits actually land, and a similarity gate throws away pairs that would
 * produce confetti.
 */
export function computeEmphasis(lines: RawLine[]): EmphasisMap {
    const map: EmphasisMap = new Map();

    let i = 0;
    while (i < lines.length) {
        if (lines[i].type !== 'del') { i++; continue; }

        let delEnd = i;
        while (delEnd < lines.length && lines[delEnd].type === 'del') delEnd++;
        let addEnd = delEnd;
        while (addEnd < lines.length && lines[addEnd].type === 'add') addEnd++;

        const delCount = delEnd - i;
        const addCount = addEnd - delEnd;

        if (addCount === 0) { i = addEnd || i + 1; continue; }

        if (delCount <= MAX_BLOCK_FOR_PAIRING && addCount <= MAX_BLOCK_FOR_PAIRING) {
            const pairs = Math.min(delCount, addCount);
            for (let p = 0; p < pairs; p++) {
                const delIdx = i + p;
                const addIdx = delEnd + p;
                const oldLine = lines[delIdx].text;
                const newLine = lines[addIdx].text;
                if (oldLine === newLine) continue;
                if (similarity(oldLine, newLine) < MIN_SIMILARITY) continue;
                const { del, ins } = wordRanges(oldLine, newLine);
                // If practically everything changed, emphasis adds nothing.
                if (coverage(del, oldLine.length) > 0.9 && coverage(ins, newLine.length) > 0.9) continue;
                if (del.length) map.set(delIdx, del);
                if (ins.length) map.set(addIdx, ins);
            }
        }

        i = addEnd;
    }

    return map;
}

function coverage(ranges: Range[], length: number): number {
    if (length === 0) return 1;
    let total = 0;
    for (const [s, e] of ranges) total += e - s;
    return total / length;
}
