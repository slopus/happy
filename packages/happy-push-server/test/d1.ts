/**
 * A D1Database backed by Node's built-in SQLite, covering the subset of the
 * D1 API the worker uses (prepare/bind/first/all/run/batch). D1 is SQLite,
 * and the real migration files are applied, so SQL behaves as it will in
 * production; workerd itself cannot run in the agent sandbox (no local port
 * binding on macOS).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

export interface TestDb {
    db: D1Database;
    sqlite: DatabaseSync;
}

export function createTestDb(): TestDb {
    const sqlite = new DatabaseSync(':memory:');
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
        sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
    return { db: createD1(sqlite), sqlite };
}

type Param = string | number | null;

class Statement {
    constructor(
        private readonly sqlite: DatabaseSync,
        readonly sql: string,
        readonly params: Param[] = []
    ) {}

    bind(...values: unknown[]): Statement {
        return new Statement(this.sqlite, this.sql, values.map(toParam));
    }

    async first<T>(column?: string): Promise<T | null> {
        const row = this.sqlite.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
        if (!row) {
            return null;
        }
        return (column ? row[column] : { ...row }) as T;
    }

    async all<T>(): Promise<D1Result<T>> {
        return this.execute<T>();
    }

    async run<T>(): Promise<D1Result<T>> {
        return this.execute<T>();
    }

    async raw(): Promise<unknown[][]> {
        throw new Error('raw() is not implemented in the test D1 adapter');
    }

    execute<T>(): D1Result<T> {
        const statement = this.sqlite.prepare(this.sql);
        if (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(this.sql)) {
            const rows = statement.all(...this.params).map((row) => ({ ...row })) as T[];
            return result(rows, rows.length);
        }
        const info = statement.run(...this.params);
        return result<T>([], Number(info.changes));
    }
}

function result<T>(rows: T[], changes: number): D1Result<T> {
    return {
        success: true,
        results: rows,
        meta: { changes, duration: 0, last_row_id: 0, changed_db: changes > 0, size_after: 0, rows_read: 0, rows_written: changes, served_by: 'test' },
    } as unknown as D1Result<T>;
}

function toParam(value: unknown): Param {
    if (value === undefined) {
        throw new Error('D1_TYPE_ERROR: undefined is not a supported bind value');
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    if (value === null || typeof value === 'string' || typeof value === 'number') {
        return value;
    }
    throw new Error(`D1_TYPE_ERROR: unsupported bind value ${typeof value}`);
}

function createD1(sqlite: DatabaseSync): D1Database {
    const db = {
        prepare: (sql: string) => new Statement(sqlite, sql),
        // D1 runs a batch as one transaction: all statements commit or none do.
        batch: async (statements: Statement[]) => {
            sqlite.exec('BEGIN');
            try {
                const results = statements.map((s) => s.execute());
                sqlite.exec('COMMIT');
                return results;
            } catch (error) {
                sqlite.exec('ROLLBACK');
                throw error;
            }
        },
        exec: async (sql: string) => {
            sqlite.exec(sql);
            return { count: 0, duration: 0 };
        },
    };
    return db as unknown as D1Database;
}
