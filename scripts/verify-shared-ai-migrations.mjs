import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Compare against the reviewed base, not merely the manifest's own entries.
const root=fileURLToPath(new URL('..',import.meta.url));
const base='f1fec57f212cf9ce8b4bd2788a3a955a3f93ea46';
const added=execFileSync('git',['diff','--name-only','--diff-filter=A',base,'--','packages/happy-server/prisma/migrations'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(path=>path.endsWith('/migration.sql')).sort();
const manifest=JSON.parse(readFileSync(new URL('../docs/releases/shared-ai-services-candidate.json',import.meta.url),'utf8'));
assert.deepEqual(manifest.migrations.map(row=>row.path),added,'Candidate must include every added migration, in order');
for(const row of manifest.migrations){
 const hash=createHash('sha256').update(readFileSync(new URL('../'+row.path,import.meta.url))).digest('hex');
 assert.equal(row.sha256,hash,`Migration hash mismatch: ${row.path}`);
}
console.log(`Verified ${added.length} ordered migrations against ${base}`);
