// Web-only retention. Deletion is opt-in and the workflow holds the same lock
// as production deployment; no OTA or mutable entry object is a candidate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { listObjects } = require('./oss-upload-sync.cjs');

const BUCKET = 'happy-app-ota-jacky';
const ORIGIN = `https://${BUCKET}.oss-cn-hangzhou.aliyuncs.com`;
const PREFIXES = ['web/releases/', 'web/rollback/', '_expo/', 'assets/', 'desktop-skins/'];
const PUBLIC_PREFIXES = PREFIXES.slice(2);
const KEEP = 5;
const SHA = /^[a-f0-9]{40}$/;
const sameObject = (a, b) => a && b && Number(a.Size) === Number(b.Size)
  && String(a.ETag).replaceAll('"', '').toLowerCase() === String(b.ETag).replaceAll('"', '').toLowerCase();
const rows = value => Array.isArray(value) ? value : value ? [value] : [];
const bytes = objects => objects.reduce((sum, object) => sum + Number(object.Size), 0);
const revision = text => {
  const sha = text.trim();
  if (!SHA.test(sha)) throw new Error('Invalid Web release revision');
  return sha;
};
const htmlRevision = text => revision(text.match(/<meta\s+name=["']paws-release-revision["']\s+content=["']([^"']+)["']/)?.[1] || '');

function buildPlan(snapshot) {
  const { current, objects, rollbacks, entries } = snapshot;
  revision(current);
  const byKey = new Map();
  const releases = new Map();
  for (const object of objects) {
    if (!PREFIXES.some(prefix => object.Key.startsWith(prefix))) throw new Error(`Out-of-scope object: ${object.Key}`);
    if (byKey.has(object.Key) || !Number.isSafeInteger(Number(object.Size)) || Number(object.Size) < 0
      || !object.ETag || !Number.isFinite(Date.parse(object.LastModified))) throw new Error(`Invalid metadata: ${object.Key}`);
    byKey.set(object.Key, object);
    if (object.Key.startsWith('web/releases/')) {
      const sha = object.Key.split('/')[2];
      revision(sha);
      if (!releases.has(sha)) releases.set(sha, []);
      releases.get(sha).push(object);
    }
  }
  const sorted = [...rollbacks].sort((a, b) => Date.parse(b.LastModified) - Date.parse(a.LastModified) || a.Key.localeCompare(b.Key));
  const keep = [current];
  for (const rollback of sorted) {
    revision(rollback.revision);
    if (!/^web\/rollback\/[A-Za-z0-9._-]+\/\.paws-release-revision$/.test(rollback.Key)
      || !sameObject(rollback, byKey.get(rollback.Key))) throw new Error('Invalid rollback marker');
    if (keep.length < KEEP && !keep.includes(rollback.revision)) keep.push(rollback.revision);
  }
  const rollbackPrefixes = new Set();
  for (const sha of keep) {
    const match = sorted.find(row => row.revision === sha);
    if (match) rollbackPrefixes.add(match.Key.slice(0, -'.paws-release-revision'.length));
  }
  const protectedKeys = new Set();
  for (const sha of keep) {
    const prefix = `web/releases/${sha}/`;
    const release = releases.get(sha);
    if (!release || !byKey.has(prefix + 'index.html') || !byKey.has(prefix + '.paws-release-revision')
      || entries[sha]?.marker !== sha || htmlRevision(entries[sha]?.html || '') !== sha) throw new Error(`Protected release is incomplete: ${sha}`);
    for (const object of release) {
      protectedKeys.add(object.Key);
      const relative = object.Key.slice(prefix.length);
      if (PUBLIC_PREFIXES.some(p => relative.startsWith(p)) && !relative.endsWith('/')) {
        if (!sameObject(object, byKey.get(relative))) throw new Error(`Protected dependency differs or is absent: ${relative}`);
        protectedKeys.add(relative);
      }
    }
  }
  for (const prefix of rollbackPrefixes) {
    if (!byKey.has(prefix + 'index.html')) throw new Error(`Rollback entry is incomplete: ${prefix}`);
    for (const object of objects) if (object.Key.startsWith(prefix)) protectedKeys.add(object.Key);
  }
  const phases = { rollback: [], releases: [], public: [] };
  for (const object of objects) {
    if (protectedKeys.has(object.Key)) continue;
    if (object.Key.startsWith('web/releases/')) phases.releases.push(object);
    else if (object.Key.startsWith('web/rollback/')) phases.rollback.push(object);
    else if (!object.Key.endsWith('/')) phases.public.push(object);
  }
  return { current, keep, rollbackPrefixes: [...rollbackPrefixes], phases,
    protected: objects.filter(object => protectedKeys.has(object.Key)),
    before: { objects: objects.length, bytes: bytes(objects), versions: releases.size } };
}

function createClient() {
  const aliyun = (operation, args) => JSON.parse(execFileSync(process.env.ALIYUN_BIN || 'aliyun',
    ['ossutil', 'api', operation, '--bucket', BUCKET, ...args,
      '--endpoint', 'https://oss-cn-hangzhou.aliyuncs.com', '--addressing-style', 'virtual', '--output-format', 'json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  return {
    list: prefix => [...listObjects(BUCKET, prefix).values()],
    async text(key) {
      const response = await fetch(`${ORIGIN}/${key}`, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`OSS read failed (${response.status}): ${key}`);
      return response.text();
    },
    delete: requestFile => aliyun('delete-multiple-objects', ['--delete', `file://${requestFile}`]),
  };
}

async function runCleanup(client, { apply = false, reportDirectory, checkDeployment = async () => {} }) {
  fs.mkdirSync(reportDirectory, { recursive: true });
  const write = (name, data) => fs.writeFileSync(path.join(reportDirectory, name), JSON.stringify(data, null, 2) + '\n');
  const current = revision(await client.text('web/current/.paws-release-revision'));
  const liveHtml = await client.text('web/current/index.html');
  if (htmlRevision(liveHtml) !== current) throw new Error('Current OSS marker and HTML differ');
  const guard = async () => {
    await checkDeployment();
    if (revision(await client.text('web/current/.paws-release-revision')) !== current
      || htmlRevision(await client.text('web/current/index.html')) !== current) throw new Error('Current Web changed; stopping cleanup');
  };
  await guard();
  const objects = PREFIXES.flatMap(prefix => client.list(prefix));
  const rollbacks = [];
  for (const object of objects.filter(row => row.Key.startsWith('web/rollback/') && row.Key.endsWith('/.paws-release-revision'))) {
    const text = await client.text(object.Key);
    if (crypto.createHash('md5').update(text).digest('hex').toLowerCase() !== String(object.ETag).replaceAll('"', '').toLowerCase()) throw new Error('Rollback marker changed during listing');
    rollbacks.push({ ...object, revision: revision(text) });
  }
  const candidates = [current, ...rollbacks.sort((a, b) => Date.parse(b.LastModified) - Date.parse(a.LastModified) || a.Key.localeCompare(b.Key)).map(row => row.revision)];
  const keep = [...new Set(candidates)].slice(0, KEEP);
  const entries = {};
  for (const sha of keep) entries[sha] = {
    marker: revision(await client.text(`web/releases/${sha}/.paws-release-revision`)),
    html: await client.text(`web/releases/${sha}/index.html`),
  };
  const plan = buildPlan({ current, objects, rollbacks, entries });
  // The rollback HTML must agree with the marker; preserving a mismatched
  // marker/index pair would offer a broken rollback after pruning dependencies.
  for (const prefix of plan.rollbackPrefixes) {
    const marker = rollbacks.find(row => row.Key === prefix + '.paws-release-revision');
    if (htmlRevision(await client.text(prefix + 'index.html')) !== marker.revision) throw new Error('Rollback HTML and marker differ');
  }
  write('plan.json', plan);
  let deletedObjects = 0;
  let deletedBytes = 0;
  if (apply) {
    for (const [phase, phaseObjects] of Object.entries(plan.phases)) {
      for (let offset = 0; offset < phaseObjects.length; offset += 1000) {
        await guard();
        const batch = phaseObjects.slice(offset, offset + 1000);
        const name = `${phase}-${offset / 1000}`;
        write(`${name}-request.json`, { Quiet: 'false', Object: batch.map(object => ({ Key: object.Key })) });
        const result = client.delete(path.join(reportDirectory, `${name}-request.json`));
        write(`${name}-response.json`, result);
        const returned = new Set(rows(result.Deleted).map(object => object.Key));
        if (rows(result.Error).length || returned.size !== batch.length || batch.some(object => !returned.has(object.Key))) throw new Error(`Delete batch failed: ${name}`);
        deletedObjects += batch.length;
        deletedBytes += bytes(batch);
        console.log(`Web retention ${phase}: ${deletedObjects} deleted (${deletedBytes} B)`);
      }
    }
    await guard();
    const after = PREFIXES.flatMap(prefix => client.list(prefix));
    const remaining = new Map(after.map(object => [object.Key, object]));
    for (const object of plan.protected) if (!sameObject(object, remaining.get(object.Key))) throw new Error(`Protected object changed: ${object.Key}`);
    for (const object of Object.values(plan.phases).flat()) if (remaining.has(object.Key)) throw new Error(`Deleted object remains: ${object.Key}`);
    const versions = [...new Set(after.filter(object => object.Key.startsWith('web/releases/')).map(object => object.Key.split('/')[2]))];
    if (versions.length !== keep.length || versions.some(sha => !keep.includes(sha))) throw new Error('Unexpected release appeared during cleanup');
    write('verification.json', { current, keep, protectedChecksumsVerified: true, after: { objects: after.length, bytes: bytes(after), versions: versions.length } });
  }
  await guard();
  const summary = { mode: apply ? 'apply' : 'dry-run', current, keep,
    candidates: Object.fromEntries(Object.entries(plan.phases).map(([key, value]) => [key, { objects: value.length, bytes: bytes(value) }])),
    deletedObjects, deletedBytes };
  write('summary.json', summary);
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg))) throw new Error('Usage: node scripts/cleanup-web-assets.cjs [--dry-run | --apply]');
  if (args.includes('--apply') && args.includes('--dry-run')) throw new Error('Choose one mode');
  const apply = args.includes('--apply');
  // Local checks default to dry-run. Destructive execution is confined to the
  // main-branch workflow holding the production lock and existing credentials.
  if (apply && (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REF !== 'refs/heads/main'
    || process.env.GITHUB_WORKFLOW !== 'Daily Web OSS retention'
    || process.env.PAWS_WEB_RETENTION_LOCK !== 'paws-web-production')) throw new Error('Apply requires the main retention workflow and production lock');
  const checkDeployment = apply ? async () => {
    // Shared concurrency is the mutex; do not treat queued future deployments
    // as active, as they must wait until cleanup releases the lock.
    const runs = JSON.parse(execFileSync('gh', ['run', 'list', '--repo', 'wangjs-jacky/happy', '--workflow', 'web-production-deploy.yml',
      '--limit', '100', '--json', 'status'], { encoding: 'utf8' }));
    if (runs.some(run => run.status === 'in_progress')) throw new Error('Web deployment is active; skipping cleanup');
  } : async () => {};
  const reportDirectory = path.resolve(process.env.PAWS_WEB_RETENTION_REPORT_DIR || 'web-retention-report');
  const summary = await runCleanup(createClient(), { apply, reportDirectory, checkDeployment });
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Web retention (${summary.mode})\n\nKept ${summary.keep.length} versions, including current \`${summary.current}\`.\n\nDeleted ${summary.deletedObjects} objects (${summary.deletedBytes} B). Full plan and receipts are in the run artifact.\n`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildPlan, runCleanup };
