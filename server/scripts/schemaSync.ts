import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';

export function normalizeSchemaText(input: string): string {
    return input.replace(/\r\n/g, '\n').trimEnd() + '\n';
}

function normalizeGeneratedTs(input: string): string {
    return input.replace(/\r\n/g, '\n').trimEnd() + '\n';
}

type EnumDef = { name: string; values: string[] };

function parseEnums(schemaText: string): EnumDef[] {
    const text = schemaText.replace(/\r\n/g, '\n');
    const out: EnumDef[] = [];
    const enumRe = /^\s*enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\s*\}\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = enumRe.exec(text))) {
        const name = m[1]!;
        const body = m[2] ?? '';
        const values = body
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('//'))
            // Each enum member is an identifier, optionally with attributes like @map(...)
            .map((l) => l.split(/\s+/)[0])
            .filter(Boolean);
        out.push({ name, values });
    }
    return out;
}

export function generateEnumsTsFromPostgres(postgresSchema: string): string {
    const enums = parseEnums(postgresSchema);
    if (enums.length === 0) {
        throw new Error('Failed to find any enum blocks in prisma/schema.prisma');
    }

    const header = [
        '// AUTO-GENERATED FILE - DO NOT EDIT.',
        '// Source: prisma/schema.prisma',
        '// Regenerate: yarn schema:sync',
        '',
    ].join('\n');

    const chunks: string[] = [header];
    for (const e of enums) {
        chunks.push(`export const ${e.name} = {`);
        for (const v of e.values) {
            const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v) ? v : JSON.stringify(v);
            chunks.push(`    ${key}: "${v}",`);
        }
        chunks.push('} as const;');
        chunks.push('');
        chunks.push(`export type ${e.name} = (typeof ${e.name})[keyof typeof ${e.name}];`);
        chunks.push('');
    }

    return normalizeGeneratedTs(chunks.join('\n'));
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
        '// Regenerate: yarn schema:sync',
        '',
        '// This is your Prisma schema file,',
        '// learn more about it in the docs: https://pris.ly/d/prisma-schema',
    ].join('\n');

    const generatorClient = [
        'generator client {',
        '    provider        = "prisma-client-js"',
        '    previewFeatures = ["metrics"]',
        '    output          = "../../generated/sqlite-client"',
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

async function writeIfChanged(path: string, next: string, normalize: (s: string) => string): Promise<boolean> {
    let existing = '';
    try {
        existing = await readFile(path, 'utf-8');
    } catch {
        // ignore
    }
    if (normalize(existing) === normalize(next)) {
        return false;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, next, 'utf-8');
    return true;
}

async function main(args: string[]): Promise<void> {
    const check = args.includes('--check');
    const quiet = args.includes('--quiet');

    const root = resolveRepoRoot();
    const masterPath = join(root, 'prisma', 'schema.prisma');
    const sqlitePath = join(root, 'prisma', 'sqlite', 'schema.prisma');
    const enumsTsPath = join(root, 'sources', 'storage', 'enums.generated.ts');

    const master = await readFile(masterPath, 'utf-8');
    const generated = generateSqliteSchemaFromPostgres(master);
    const enumsTs = generateEnumsTsFromPostgres(master);

    if (check) {
        let existing = '';
        try {
            existing = await readFile(sqlitePath, 'utf-8');
        } catch {
            // ignore
        }
        if (normalizeSchemaText(existing) !== normalizeSchemaText(generated)) {
            console.error('[schema] prisma/sqlite/schema.prisma is out of date.');
            console.error('[schema] Run: yarn schema:sync');
            process.exit(1);
        }

        let existingEnums = '';
        try {
            existingEnums = await readFile(enumsTsPath, 'utf-8');
        } catch {
            // ignore
        }
        if (normalizeGeneratedTs(existingEnums) !== normalizeGeneratedTs(enumsTs)) {
            console.error('[schema] sources/storage/enums.generated.ts is out of date.');
            console.error('[schema] Run: yarn schema:sync');
            process.exit(1);
        }

        if (!quiet) {
            console.log('[schema] prisma/sqlite/schema.prisma is up to date.');
            console.log('[schema] sources/storage/enums.generated.ts is up to date.');
        }
        return;
    }

    if (!quiet) {
        const wroteSchema = await writeIfChanged(sqlitePath, generated, normalizeSchemaText);
        const wroteEnums = await writeIfChanged(enumsTsPath, enumsTs, normalizeGeneratedTs);
        if (wroteSchema) console.log('[schema] Wrote prisma/sqlite/schema.prisma');
        if (wroteEnums) console.log('[schema] Wrote sources/storage/enums.generated.ts');
        if (!wroteSchema && !wroteEnums) console.log('[schema] No changes.');
    } else {
        await writeIfChanged(sqlitePath, generated, normalizeSchemaText);
        await writeIfChanged(enumsTsPath, enumsTs, normalizeGeneratedTs);
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
