import { describe, expect, it } from 'vitest';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

function walkFiles(rootDir: string): string[] {
    const results: string[] = [];
    const stack: string[] = [rootDir];

    while (stack.length > 0) {
        const currentDir = stack.pop();
        if (!currentDir) continue;

        for (const entry of readdirSync(currentDir)) {
            const fullPath = join(currentDir, entry);
            const stat = statSync(fullPath);

            if (stat.isDirectory()) {
                stack.push(fullPath);
                continue;
            }

            if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
                results.push(fullPath);
            }
        }
    }

    return results;
}

function isStackScreenJsx(tagName: ts.JsxTagNameExpression): boolean {
    if (!ts.isPropertyAccessExpression(tagName)) return false;
    if (!ts.isIdentifier(tagName.expression)) return false;
    return tagName.expression.text === 'Stack' && tagName.name.text === 'Screen';
}

describe('Stack.Screen options invariants', () => {
    it('does not pass an inline object literal to <Stack.Screen options={...}> in app/(app) screens', () => {
        const testDir = fileURLToPath(new URL('.', import.meta.url));
        const sourcesDir = join(testDir, '..'); // sources/
        const appDir = join(sourcesDir, 'app', '(app)');

        const excludedFiles = new Set<string>([
            join(appDir, '_layout.tsx'),
        ]);

        const offenders: Array<{ file: string; line: number }> = [];

        for (const file of walkFiles(appDir)) {
            if (excludedFiles.has(file)) continue;
            const content = readFileSync(file, 'utf8');
            if (!content.includes('Stack.Screen') || !content.includes('options')) continue;

            const sourceFile = ts.createSourceFile(
                file,
                content,
                ts.ScriptTarget.Latest,
                true,
                file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
            );

            const visit = (node: ts.Node) => {
                if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
                    if (isStackScreenJsx(node.tagName)) {
                        for (const prop of node.attributes.properties) {
                            if (!ts.isJsxAttribute(prop)) continue;
                            if (prop.name.getText(sourceFile) !== 'options') continue;

                            const init = prop.initializer;
                            if (!init || !ts.isJsxExpression(init) || !init.expression) continue;
                            if (ts.isObjectLiteralExpression(init.expression)) {
                                const { line } = ts.getLineAndCharacterOfPosition(sourceFile, prop.getStart(sourceFile));
                                offenders.push({ file, line: line + 1 });
                            }
                        }
                    }
                }

                ts.forEachChild(node, visit);
            };

            visit(sourceFile);
        }

        expect(offenders.map(({ file, line }) => `${relative(appDir, file)}:${line}`)).toEqual([]);
    });
});
