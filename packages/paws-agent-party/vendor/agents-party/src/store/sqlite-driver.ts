/**
 * A minimal SQLite driver shim: `bun:sqlite` under Bun, `node:sqlite` under Node 22.5+, a clear error elsewhere. Schema
 * comes from the caller (registry and party store define their own); lazy-imported so the package stays importable on
 * runtimes without SQLite.
 */

export type SqlParam = string | number | null

export interface SqliteDb {
  run(sql: string, params?: SqlParam[]): { changes: number; lastInsertRowid: number }
  all(sql: string, params?: SqlParam[]): Record<string, unknown>[]
  close(): void
}

interface SqliteStatement {
  run(...params: SqlParam[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  all(...params: SqlParam[]): Record<string, unknown>[]
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): SqliteStatement
    close(): void
  }
}

interface BunSqliteModule {
  Database: new (
    path: string,
    options?: { create?: boolean },
  ) => {
    exec(sql: string): void
    query(sql: string): SqliteStatement
    close(): void
  }
}

export const openSqlite = async (path: string, schema: string): Promise<SqliteDb> => {
  // Computed specifiers keep tsc (types: ["node"] in the build project) from resolving the runtime-specific modules;
  // Bun/Node resolve them at runtime.
  if ((globalThis as { Bun?: unknown }).Bun !== undefined) {
    const specifier = 'bun:sqlite'
    const { Database } = (await import(specifier)) as BunSqliteModule
    const db = new Database(path, { create: true })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(schema)
    return {
      run: (sql, params = []) => {
        const result = db.query(sql).run(...params)
        return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
      },
      all: (sql, params = []) => db.query(sql).all(...params),
      close: () => db.close(),
    }
  }

  let mod: NodeSqliteModule
  try {
    const specifier = 'node:sqlite'
    mod = (await import(specifier)) as NodeSqliteModule
  } catch {
    throw new Error('agents-party needs SQLite: run via Bun (`bunx agents-party`) or Node 22.5+.')
  }
  const db = new mod.DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(schema)
  return {
    run: (sql, params = []) => {
      const result = db.prepare(sql).run(...params)
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    },
    all: (sql, params = []) => db.prepare(sql).all(...params),
    close: () => db.close(),
  }
}
