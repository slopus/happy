import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { transformSync } from '@babel/core';
import { createDiffSyntax } from './factory.generated';
import { tokenize } from './tokenize';
import { MAX_SYNTAX_LINE } from './protocol';

const input = {
    language: 'typescript',
    lines: [
        { type: 'ctx' as const, text: '/* multi' },
        { type: 'ctx' as const, text: '   line */' },
        { type: 'del' as const, text: 'const oldValue = "before";' },
        { type: 'add' as const, text: 'const newValue = "after";' },
    ],
};

describe('isolated Prism worker', () => {
    it('keeps the generated factory in sync with the source and locked Prism version', () => {
        const script = new URL('../../../../scripts/build-diff-syntax.cjs', import.meta.url).pathname;
        expect(execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' })).toContain('(verified)');
    });
    it('has the same tokens as the source implementation without any host imports', () => {
        const isolated = runInNewContext(`(${createDiffSyntax.toString()})()`, { performance });
        const result = isolated(input);
        expect(result.status).toBe('highlighted');
        expect(result.runs).toEqual(tokenize(input).runs);
        expect(result.runs[0][0].k).toBe('comment');
        expect(result.runs[1][0].k).toBe('comment');
        expect(result.runs[3].some((run: { k: string }) => run.k === 'keyword')).toBe(true);
    });

    it('survives the actual Worklets transform with no captured module functions', () => {
        const filename = new URL('./factory.generated.ts', import.meta.url).pathname;
        const code = transformSync(readFileSync(filename, 'utf8'), {
            filename, configFile: false, babelrc: false,
            presets: ['@babel/preset-typescript'],
            plugins: [
                ['react-native-worklets/plugin', { disableSourceMaps: true }],
                '@babel/plugin-transform-modules-commonjs',
            ],
        })!.code!;
        // Babel's host-side factory checks global._WORKLET; RN supplies global.
        const context = { exports: {} as { createDiffSyntax?: any } };
        runInNewContext(`globalThis.global = globalThis;\n${code}`, context);
        const factory = context.exports.createDiffSyntax;
        expect(Object.keys(factory.__closure)).toEqual([]);
        const worklet = runInNewContext(`(${factory.__initData.code})`, { performance });
        const result = worklet.call({ __closure: {} })(input);
        expect(result.runs).toEqual(tokenize(input).runs);
        // Web serializes the callable factory, not Worklets' private initData.
        expect(runInNewContext(`(${factory.toString()})()`, { performance })(input).runs).toEqual(result.runs);
    });

    it('bounds long lines and unknown languages without changing source text', () => {
        const worker = createDiffSyntax();
        expect(worker({ language: 'unknown', lines: input.lines }).status).toBe('unsupported');
        expect(worker({ language: 'typescript', lines: [{ type: 'add', text: 'x'.repeat(MAX_SYNTAX_LINE + 1) }] }).status).toBe('limited');
        const result = worker(input);
        expect(result.runs.map((runs: { n: number }[]) => runs.reduce((sum, run) => sum + run.n, 0)))
            .toEqual(input.lines.map((line) => line.text.length));
    });

    it.each([
        ['javascript', 'const value = "hi";'],
        ['tsx', 'const view = <Button disabled={true}>Hello</Button>;'],
        ['python', 'def greet(): return "hello"'],
        ['json', '{"enabled": true, "count": 42}'],
        ['swift', 'let name: String = "hello"'],
        ['rust', 'fn main() { let count = 42; }'],
        ['go', 'func main() { value := "hello" }'],
        ['ruby', 'def greet; "hello"; end'],
        ['bash', 'echo "$USER" | head -n 3'],
        ['powershell', 'Write-Output "$env:USER"'],
        ['shell-session', '$ echo "hello"\nhello\n'],
    ])('loads %s grammar in a cold isolated runtime', (language, text) => {
        const isolated = runInNewContext(`(${createDiffSyntax.toString()})()`, { performance });
        const result = isolated({ language, lines: [{ type: 'add', text }] });
        expect(result.status).toBe('highlighted');
        expect(result.runs[0].some((run: { k: string }) => run.k !== 'plain')).toBe(true);
    });
});