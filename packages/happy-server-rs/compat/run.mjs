// Differential runner: the same scenario against the TS server (A) and the Rust
// server (B), each on its own fresh database, then a normalized comparison.
//   node run.mjs <scenario> <tsBase> <tsDb> <rsBase> <rsDb>
import { execFileSync } from 'node:child_process';
import { Recorder, compare } from './lib.mjs';

const [scenarioName, aBase, aDb, bBase, bDb] = process.argv.slice(2);
const { scenario } = await import(`./${scenarioName}.mjs`);
const PG = { host: process.env.PGHOST || '127.0.0.1', port: process.env.PGPORT || '55487' };
const sqlFor = (db) => async (q) => execFileSync('psql', ['-h', PG.host, '-p', PG.port, '-U', 'postgres', '-d', db, '-At', '-v', 'ON_ERROR_STOP=1', '-c', q], { encoding: 'utf8' });

const a = new Recorder(aBase);
await scenario(a, { sql: sqlFor(aDb), side: 'ts' });
const b = new Recorder(bBase);
await scenario(b, { sql: sqlFor(bDb), side: 'rs' });

if (process.env.DUMP) {
    const fs = await import('node:fs');
    const strip = (e) => ({ name: e.name, status: e.status, headers: e.headers, body: e.note ? e.json : e.text });
    fs.writeFileSync(`${process.env.DUMP}/${scenarioName}-ts.json`, JSON.stringify(a.entries.map(strip), null, 1));
    fs.writeFileSync(`${process.env.DUMP}/${scenarioName}-rs.json`, JSON.stringify(b.entries.map(strip), null, 1));
}
const diffs = compare(a.entries, b.entries);
console.log(`${scenarioName}: ${a.entries.length} exchanges, ${diffs.length} differences`);
for (const d of diffs) console.log(d);
process.exit(diffs.length ? 1 : 0);
