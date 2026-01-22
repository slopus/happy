import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function normalizeSchemaText(input: string): string {
    return input.replace(/\r\n/g, '\n').trimEnd() + '\n';
}

export function generateSqliteSchemaFromPostgres(postgresSchema: string): string {
    const schema = postgresSchema.replace(/\r\n/g, '\n');

    const datasource = /(^|\n)\s*datasource\s+db\s*{[\s\S]*?\n}\s*\n/m;
    const match = schema.match(datasource);
    if (!match || match.index == null) {
        throw new Error('Failed to find `datasource db { ... }` block in prisma/schema.prisma');
    }

    const bodyStart = match.index + match[0].length;
    const rawBody = schema.slice(bodyStart);

    const body = normalizeSchemaText(rawBody)
        .replace(/^\s+/, '')
        .replace(/(\w+)\(\s*sort\s*:\s*\w+\s*\)/g, '$1');

    const header = [
        '// AUTO-GENERATED FILE - DO NOT EDIT.',
        '// Source: prisma/schema.prisma',
        '// Regenerate: yarn schema:sqlite',
        '',
        '// This is your Prisma schema file,',
        '// learn more about it in the docs: https://pris.ly/d/prisma-schema',
    ].join('\n');

    const generatorClient = [
        'generator client {',
        '    provider        = "prisma-client-js"',
        '    previewFeatures = ["metrics"]',
        '    output          = "../generated/sqlite-client"',
        '}',
    ].join('\n');

    const datasourceDb = [
        'datasource db {',
        '    provider = "sqlite"',
        '    url      = env("DATABASE_URL")',
        '}',
    ].join('\n');

    return normalizeSchemaText([header, '', generatorClient, '', datasourceDb, '', body].join('\n'));
}

function resolveRepoRoot(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return join(__dirname, '..');
}

async function main(args: string[]): Promise<void> {
    const check = args.includes('--check');
    const quiet = args.includes('--quiet');

    const root = resolveRepoRoot();
    const masterPath = join(root, 'prisma', 'schema.prisma');
    const sqlitePath = join(root, 'prisma', 'schema.sqlite.prisma');

    const master = await readFile(masterPath, 'utf-8');
    const generated = generateSqliteSchemaFromPostgres(master);

    if (check) {
        let existing = '';
        try {
            existing = await readFile(sqlitePath, 'utf-8');
        } catch {
            // ignore
        }
        if (normalizeSchemaText(existing) !== normalizeSchemaText(generated)) {
            console.error('[schema] prisma/schema.sqlite.prisma is out of date.');
            console.error('[schema] Run: yarn schema:sqlite');
            process.exit(1);
        }
        if (!quiet) {
            console.log('[schema] prisma/schema.sqlite.prisma is up to date.');
        }
        return;
    }

    await writeFile(sqlitePath, generated, 'utf-8');
    if (!quiet) {
        console.log('[schema] Wrote prisma/schema.sqlite.prisma');
    }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
    // eslint-disable-next-line no-void
    void main(process.argv.slice(2)).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
