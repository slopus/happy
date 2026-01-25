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
        if (!currentDir) {
            continue;
        }

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

describe('Unistyles StyleSheet import invariants', () => {
    it('does not import StyleSheet from react-native inside sources/', () => {
        const testDir = fileURLToPath(new URL('.', import.meta.url));
        const sourcesDir = join(testDir, '..'); // sources/

        const excludedPrefixes = [
            join(sourcesDir, 'dev') + '/',
            join(sourcesDir, 'sync', '__testdata__') + '/',
        ];

        const offenders: Array<{ file: string; line: number }> = [];

        for (const file of walkFiles(sourcesDir)) {
            const normalized = file.replaceAll('\\', '/');
            if (excludedPrefixes.some((prefix) => normalized.startsWith(prefix.replaceAll('\\', '/')))) {
                continue;
            }

            const content = readFileSync(file, 'utf8');
            if (!content.includes('StyleSheet') || !content.includes('react-native')) {
                continue;
            }

            const sourceFile = ts.createSourceFile(
                file,
                content,
                ts.ScriptTarget.Latest,
                true,
                file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
            );

            for (const statement of sourceFile.statements) {
                if (!ts.isImportDeclaration(statement)) {
                    continue;
                }

                if (!ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'react-native') {
                    continue;
                }

                const namedBindings = statement.importClause?.namedBindings;
                if (!namedBindings || !ts.isNamedImports(namedBindings)) {
                    continue;
                }

                const hasStyleSheet = namedBindings.elements.some((specifier) => {
                    const importedName = specifier.propertyName?.text ?? specifier.name.text;
                    return importedName === 'StyleSheet';
                });

                if (!hasStyleSheet) {
                    continue;
                }

                const { line } = ts.getLineAndCharacterOfPosition(sourceFile, statement.getStart(sourceFile));
                offenders.push({ file, line: line + 1 });
            }
        }

        expect(
            offenders.map(({ file, line }) => `${relative(sourcesDir, file)}:${line}`)
        ).toEqual([]);
    });
});
