import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateEnumsTsFromPostgres, generateSqliteSchemaFromPostgres, normalizeSchemaText } from './schemaSync';

describe('generateSqliteSchemaFromPostgres', () => {
    it('converts the schema header blocks for sqlite', async () => {
        const master = await readFile(join(process.cwd(), 'prisma/schema.prisma'), 'utf-8');
        const generated = generateSqliteSchemaFromPostgres(master);
        expect(generated).toContain('provider = "sqlite"');
        expect(generated).toContain('output          = "../../generated/sqlite-client"');
        expect(generated).not.toContain('generator json');
        expect(generated).not.toMatch(/sort\s*:\s*(Asc|Desc)/);
    });

    it('keeps prisma/sqlite/schema.prisma in sync with prisma/schema.prisma', async () => {
        const master = await readFile(join(process.cwd(), 'prisma/schema.prisma'), 'utf-8');
        const existing = await readFile(join(process.cwd(), 'prisma/sqlite/schema.prisma'), 'utf-8');
        const generated = generateSqliteSchemaFromPostgres(master);
        expect(normalizeSchemaText(existing)).toBe(normalizeSchemaText(generated));
    });
});

describe('generateEnumsTsFromPostgres', () => {
    it('keeps sources/storage/enums.generated.ts in sync with prisma/schema.prisma', async () => {
        const master = await readFile(join(process.cwd(), 'prisma/schema.prisma'), 'utf-8');
        const existing = await readFile(join(process.cwd(), 'sources/storage/enums.generated.ts'), 'utf-8');
        const generated = generateEnumsTsFromPostgres(master);
        expect(existing.replace(/\r\n/g, '\n').trimEnd()).toBe(generated.replace(/\r\n/g, '\n').trimEnd());
    });
});
