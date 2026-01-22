import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateSqliteSchemaFromPostgres, normalizeSchemaText } from './generateSqliteSchema';

describe('generateSqliteSchemaFromPostgres', () => {
    it('converts the schema header blocks for sqlite', async () => {
        const master = await readFile(join(process.cwd(), 'prisma/schema.prisma'), 'utf-8');
        const generated = generateSqliteSchemaFromPostgres(master);
        expect(generated).toContain('provider = "sqlite"');
        expect(generated).toContain('output          = "../generated/sqlite-client"');
        expect(generated).not.toContain('generator json');
        expect(generated).not.toMatch(/sort\\s*:\\s*(Asc|Desc)/);
    });

    it('keeps prisma/schema.sqlite.prisma in sync with prisma/schema.prisma', async () => {
        const master = await readFile(join(process.cwd(), 'prisma/schema.prisma'), 'utf-8');
        const existing = await readFile(join(process.cwd(), 'prisma/schema.sqlite.prisma'), 'utf-8');
        const generated = generateSqliteSchemaFromPostgres(master);
        expect(normalizeSchemaText(existing)).toBe(normalizeSchemaText(generated));
    });
});

