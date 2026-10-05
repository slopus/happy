import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { Prisma6PGlite } from '@/storage/pgliteAdapter';

export async function createTestDatabase(beforeSharedServices = false) {
    const pg = new PGlite();
    const directory = resolve('prisma/migrations');
    const migrations = readdirSync(directory).filter(name => /^\d/.test(name)).sort();
    for (const name of migrations) {
        if (beforeSharedServices && name >= '20261005000000') continue;
        await pg.exec(readFileSync(resolve(directory, name, 'migration.sql'), 'utf8'));
    }
    const database = new PrismaClient({ adapter: new Prisma6PGlite(pg) } as never);
    return { pg, database };
}
