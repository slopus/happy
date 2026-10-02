/** Reconcile additive native history migrations without discarding retained threads. */
export type HistoryRow = Record<string, any>;
export type HistoryDatabase = {
  exec(sql: string): void;
  prepare(sql: string): { all(...args: any[]): HistoryRow[]; get(...args: any[]): HistoryRow | undefined; run(...args: any[]): unknown };
  close(): void;
};
export type HistorySchemaEntry = { type: string; name: string; tbl_name: string; sql: string };
export const quoteHistoryIdentifier = (name: string): string => '"' + name.replaceAll('"', '""') + '"';

export class CodexHistorySchemaError extends Error {
  constructor(detail: string) {
    super(`Codex history cache needs a compatible migration: ${detail}. Update Paws before retrying; the original history is preserved.`);
    this.name = 'CodexHistorySchemaError';
  }
}

// Compare SQL tokens, not whitespace inside string literals. SQLite quotes the
// identifiers added via ALTER even when Codex's original CREATE did not.
function sqlTokens(sql: string): string {
  const tokens = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|[^\s]/g) ?? [];
  return JSON.stringify(tokens.map(token => {
    if (/^"[A-Za-z_][A-Za-z_0-9]*"$/.test(token)) return token.slice(1, -1).toLowerCase();
    return /^[A-Za-z_][A-Za-z_0-9]*$/.test(token) ? token.toLowerCase() : token;
  }));
}

/** Only ordinary nullable/defaulted columns can be added automatically. */
function addColumn(table: string, column: HistoryRow): string {
  const type = String(column.type);
  const value = column.dflt_value as string | null;
  const constantDefault = value === null || /^(?:NULL|[-+]?\d+(?:\.\d+)?|'(?:''|[^'])*'|X'[0-9a-f]*')$/i.test(value);
  if (column.pk || column.hidden || !/^(?:INTEGER|INT|TEXT|BLOB|REAL|NUMERIC)$/i.test(type)
    || !constantDefault || (column.notnull && (value === null || /^NULL$/i.test(value)))) {
    throw new CodexHistorySchemaError(`unsupported added column in ${table}`);
  }
  return `ALTER TABLE ${quoteHistoryIdentifier(table)} ADD COLUMN ${quoteHistoryIdentifier(column.name)} ${type}${column.notnull ? ' NOT NULL' : ''}${value === null ? '' : ` DEFAULT ${value}`}`;
}

/** Plan first, then apply within the caller's transaction before copying rollouts. */
export function planHistorySchemaMerge(
  source: HistoryDatabase,
  target: HistoryDatabase,
  schema: HistorySchemaEntry[],
  createScratch: () => HistoryDatabase,
): { statements: string[]; sourceIsOlder: boolean } {
  const statements: string[] = [];
  let sourceIsOlder = false;
  if (schema.some(entry => entry.name === '_sqlx_migrations')) {
    const incoming = source.prepare('SELECT * FROM _sqlx_migrations ORDER BY version').all();
    const existing = target.prepare("SELECT name FROM sqlite_master WHERE name='_sqlx_migrations'").get()
      ? target.prepare('SELECT * FROM _sqlx_migrations ORDER BY version').all() : [];
    if (existing.length > incoming.length) sourceIsOlder = true;
    // Both homes must descend from the same migration history; an old running
    // home may be a prefix of the newer cache, but must never downgrade it.
    for (let i = 0; i < Math.min(incoming.length, existing.length); i++) {
      if (incoming[i].version !== existing[i].version
        || Buffer.from(incoming[i].checksum).compare(Buffer.from(existing[i].checksum)) !== 0) {
        throw new CodexHistorySchemaError('divergent migration history');
      }
    }
    if ([...incoming, ...existing].some(row => 'success' in row && !row.success)) {
      throw new CodexHistorySchemaError('unfinished native migration');
    }
  }
  const targetSchema = target.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
  const sourceObjects = new Set(schema.map(entry => entry.name));
  if (!sourceIsOlder && targetSchema.some(entry => !sourceObjects.has(entry.name))) {
    throw new CodexHistorySchemaError('removed schema objects');
  }
  for (const entry of schema) {
    const current = target.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(entry.name);
    if (!current) {
      if (sourceIsOlder) throw new CodexHistorySchemaError(`removed ${entry.type} ${entry.name} in the newer cache`);
      statements.push(entry.sql); continue;
    }
    if (sqlTokens(current.sql) === sqlTokens(entry.sql)) continue;
    if (entry.type !== 'table' || entry.name === '_sqlx_migrations') {
      throw new CodexHistorySchemaError(`changed ${entry.type} ${entry.name}`);
    }
    const sourceColumns = source.prepare(`PRAGMA table_xinfo(${quoteHistoryIdentifier(entry.name)})`).all();
    const targetColumns = target.prepare(`PRAGMA table_xinfo(${quoteHistoryIdentifier(entry.name)})`).all();
    const sourceNames = new Set(sourceColumns.map(column => column.name));
    const targetNames = new Set(targetColumns.map(column => column.name));
    const added = sourceColumns.filter(column => !targetNames.has(column.name));
    const retained = targetColumns.filter(column => !sourceNames.has(column.name));
    if (added.length && retained.length) throw new CodexHistorySchemaError(`divergent columns in ${entry.name}`);
    if ((retained.length && !sourceIsOlder) || (added.length && sourceIsOlder)) {
      throw new CodexHistorySchemaError(`column changes disagree with migration versions in ${entry.name}`);
    }
    const extras = added.length ? added : retained;
    if (!extras.length) throw new CodexHistorySchemaError(`changed definition of ${entry.name}`);
    const upgrades = extras.map(column => addColumn(entry.name, column));
    const scratch = createScratch();
    try {
      scratch.exec(added.length ? current.sql : entry.sql);
      for (const statement of upgrades) scratch.exec(statement);
      const upgraded = scratch.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(entry.name)!;
      // This also rejects changed keys, CHECK/FK constraints, generated columns,
      // collations, defaults and table options that PRAGMA table_info would miss.
      if (sqlTokens(upgraded.sql) !== sqlTokens(added.length ? entry.sql : current.sql)) {
        throw new CodexHistorySchemaError(`non-additive change in ${entry.name}`);
      }
    } finally { scratch.close(); }
    if (added.length) statements.push(...upgrades);
  }
  return { statements, sourceIsOlder };
}
