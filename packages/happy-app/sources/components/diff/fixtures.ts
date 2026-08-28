/**
 * Synthetic diff fixtures for the benchmark page.
 *
 * Generated rather than checked in as blobs so a size can be dialled up to
 * whatever the device starts choking on, and deterministic (seeded PRNG) so two
 * runs of the same size are actually comparable.
 */

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const IDENTIFIERS = ['session', 'message', 'payload', 'buffer', 'handler', 'result', 'cursor', 'metadata', 'socket', 'token'];
const TYPES = ['string', 'number', 'boolean', 'Session', 'Message[]', 'Record<string, unknown>', 'Promise<void>'];

/** Generates a plausible TypeScript file of `lines` lines. */
export function generateSource(lines: number, seed = 7): string {
    const rand = mulberry32(seed);
    const pick = <T,>(items: T[]): T => items[Math.floor(rand() * items.length)];
    const out: string[] = [
        `import { EventEmitter } from 'events';`,
        `import type { Session, Message } from '@/sync/types';`,
        ``,
    ];

    let index = 0;
    while (out.length < lines) {
        const name = `${pick(IDENTIFIERS)}${index}`;
        const kind = rand();
        if (kind < 0.12) {
            out.push(`/**`);
            out.push(` * ${name} keeps the ${pick(IDENTIFIERS)} in sync with the ${pick(IDENTIFIERS)}.`);
            out.push(` */`);
        } else if (kind < 0.5) {
            out.push(`export function ${name}(${pick(IDENTIFIERS)}: ${pick(TYPES)}): ${pick(TYPES)} {`);
            out.push(`    const ${pick(IDENTIFIERS)} = ${Math.floor(rand() * 1000)};`);
            out.push(`    if (${pick(IDENTIFIERS)} === undefined) {`);
            out.push(`        throw new Error('${name} requires a ${pick(IDENTIFIERS)}');`);
            out.push(`    }`);
            out.push(`    return ${pick(IDENTIFIERS)}.map((item) => item.${pick(IDENTIFIERS)}) as ${pick(TYPES)};`);
            out.push(`}`);
            out.push(``);
        } else if (kind < 0.7) {
            out.push(`export const ${name} = {`);
            out.push(`    ${pick(IDENTIFIERS)}: '${pick(IDENTIFIERS)}-${Math.floor(rand() * 100)}',`);
            out.push(`    ${pick(IDENTIFIERS)}: ${rand() > 0.5},`);
            out.push(`};`);
            out.push(``);
        } else {
            out.push(`const ${name}: ${pick(TYPES)} = await load${pick(IDENTIFIERS)}(${Math.floor(rand() * 50)}); // ${pick(IDENTIFIERS)}`);
        }
        index++;
    }

    return out.slice(0, lines).join('\n');
}

export interface FixtureSpec {
    /** Lines in the generated file. */
    lines: number;
    /** Fraction of lines that get modified. */
    changeRatio?: number;
    seed?: number;
}

/** Returns the before/after pair for one generated file. */
export function generatePair(spec: FixtureSpec): { oldText: string; newText: string } {
    const { lines, changeRatio = 0.12, seed = 7 } = spec;
    const oldText = generateSource(lines, seed);
    const rand = mulberry32(seed + 1);
    const next = oldText.split('\n').map((line) => {
        const roll = rand();
        if (roll > changeRatio) return line;
        if (roll < changeRatio * 0.2) return null; // deletion
        if (roll < changeRatio * 0.4) return `${line}\n    // TODO(bench): follow up on this branch`; // insertion
        // A realistic small edit: rename one identifier occurrence.
        return line.replace(/\b(const|let)\b/, 'const').replace(/(\d+)/, (m) => String(Number(m) + 1));
    });
    return { oldText, newText: next.filter((l): l is string => l !== null).join('\n') };
}

export interface GeneratedFile {
    path: string;
    patch: string;
}

/** One patch per file, which is also the shape the real app fetches from git. */
export function generateFiles(fileCount: number, linesPerFile: number, changeRatio = 0.12): GeneratedFile[] {
    const files: GeneratedFile[] = [];
    for (let i = 0; i < fileCount; i++) {
        const path = `sources/generated/module${i}.ts`;
        const { oldText, newText } = generatePair({ lines: linesPerFile, changeRatio, seed: 7 + i * 13 });
        files.push({ path, patch: unifiedPatch(path, oldText, newText) });
    }
    return files;
}

/** Builds a multi-file patch by concatenating generated per-file patches. */
export function generatePatch(fileCount: number, linesPerFile: number, changeRatio = 0.12): string {
    return generateFiles(fileCount, linesPerFile, changeRatio).map((f) => f.patch).join('\n');
}

/**
 * Minimal unified-diff writer. Only used by fixtures, so it takes the simple
 * route: diff by line via the `diff` package and fold with three lines of
 * context, exactly like `git diff -U3`.
 */
export function unifiedPatch(path: string, oldText: string, newText: string, context = 3): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createTwoFilesPatch } = require('diff') as typeof import('diff');
    const body = createTwoFilesPatch(`a/${path}`, `b/${path}`, oldText, newText, '', '', { context });
    // createTwoFilesPatch prepends an "Index:" header we don't want.
    const lines = body.split('\n').filter((l) => !l.startsWith('Index:') && l !== '===================================================================');
    return [`diff --git a/${path} b/${path}`, ...lines].join('\n');
}
