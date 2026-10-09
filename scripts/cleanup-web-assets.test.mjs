import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse } from 'yaml';
import { buildPlan, runCleanup } from './cleanup-web-assets.cjs';

const sha = n => n.toString(16).padStart(40, '0');
function fixture() {
  const objects = new Map();
  const add = (key, text, date = '2026-10-01T00:00:00Z') => objects.set(key, {
    Key: key, Size: String(Buffer.byteLength(text)), ETag: '"' + createHash('md5').update(text).digest('hex') + '"', LastModified: date, text,
  });
  const html = n => `<meta name="paws-release-revision" content="${sha(n)}"><script src="/_expo/static/js/v${n}.js"></script>`;
  for (let n = 1; n <= 6; n++) {
    const prefix = `web/releases/${sha(n)}/`;
    for (const [key, text] of Object.entries({ 'index.html': html(n), '.paws-release-revision': sha(n) + '\n',
      [`_expo/static/js/v${n}.js`]: `version ${n}`, [`_expo/static/js/v${n}-lazy.js`]: `lazy ${n}`,
      'assets/shared.png': 'shared image', 'desktop-skins/shared.webp': 'skin' })) add(prefix + key, text);
    add(`_expo/static/js/v${n}.js`, `version ${n}`);
    add(`_expo/static/js/v${n}-lazy.js`, `lazy ${n}`);
    if (n < 6) {
      const prefix = `web/rollback/run${n}/`;
      const date = `2026-10-0${n}T00:00:00Z`;
      add(prefix + '.paws-release-revision', sha(n) + '\n', date);
      add(prefix + 'index.html', html(n), date);
    }
  }
  add('assets/shared.png', 'shared image');
  add('desktop-skins/shared.webp', 'skin');
  add('assets/orphan.png', 'old image');
  add('updates/android/shared/assets/phone.png', 'OTA must survive');
  add('uploads/private.png', 'user file');
  add('web/current/index.html', html(6)); add('web/current/.paws-release-revision', sha(6) + '\n');
  const calls = [];
  const client = {
    list(prefix) { return [...objects.values()].filter(row => row.Key.startsWith(prefix)).map(row => ({ ...row })); },
    async text(key) { assert.ok(objects.has(key), `missing ${key}`); return objects.get(key).text; },
    delete(requestFile) {
      const request = JSON.parse(readFileSync(requestFile));
      assert.equal(request.Quiet, 'false'); assert.ok(request.Object.length <= 1000);
      const keys = request.Object.map(row => row.Key);calls.push(keys);
      for (const key of keys) objects.delete(key);
      return { Deleted: keys.map(Key => ({ Key })) };
    },
  };
  const snapshot = () => ({ current: sha(6), objects: [...objects.values()].filter(row => row.Key.startsWith('web/releases/') || row.Key.startsWith('web/rollback/') || ['_expo/', 'assets/', 'desktop-skins/'].some(p => row.Key.startsWith(p))),
    rollbacks: [...objects.values()].filter(row => row.Key.startsWith('web/rollback/') && row.Key.endsWith('/.paws-release-revision')).map(row => ({ ...row, revision: row.text.trim() })),
    entries: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [sha(i + 1), { marker: sha(i + 1), html: html(i + 1) }])),
  });
  const reportDirectory = mkdtempSync(join(tmpdir(), 'paws-web-retention-test-'));
  return { objects, add, calls, client, snapshot, reportDirectory, cleanup: () => rmSync(reportDirectory, { recursive: true, force: true }) };
}

test('keeps current plus four distinct rollback versions and dynamic/shared dependencies', () => {
  const f = fixture();
  try {
    const plan = buildPlan(f.snapshot());
    assert.deepEqual(plan.keep, [6, 5, 4, 3, 2].map(sha));
    assert.ok(plan.protected.some(r => r.Key === '_expo/static/js/v2-lazy.js'));
    assert.ok(plan.protected.some(r => r.Key === 'assets/shared.png'));
    assert.ok(plan.phases.public.some(r => r.Key === '_expo/static/js/v1.js'));
    assert.ok(plan.phases.releases.every(r => r.Key.startsWith(`web/releases/${sha(1)}/`)));
  } finally { f.cleanup(); }
});

test('current stays protected even after rolling back to an older version; duplicates do not count', () => {
  const f = fixture();
  try {
    const s = f.snapshot();s.current = sha(1);s.rollbacks.push({ ...s.rollbacks.at(-1) });
    assert.deepEqual(buildPlan(s).keep, [1, 5, 4, 3, 2].map(sha));
  } finally { f.cleanup(); }
});

test('dry-run writes a plan and performs no deletion', async () => {
  const f = fixture();
  try {
    const result = await runCleanup(f.client, f);
    assert.equal(result.mode, 'dry-run');assert.equal(f.calls.length, 0);
    assert.ok(JSON.parse(readFileSync(join(f.reportDirectory, 'plan.json'))).phases.public.length);
  } finally { f.cleanup(); }
});

test('apply deletes only retired Web files, leaves OTA/user files, verifies retained checksums', async () => {
  const f = fixture();
  try {
    const result = await runCleanup(f.client, { ...f, apply: true });
    assert.ok(result.deletedObjects > 0);
    assert.ok(f.objects.has('updates/android/shared/assets/phone.png'));
    assert.ok(f.objects.has('uploads/private.png'));
    assert.ok(f.objects.has('web/current/.paws-release-revision'));
    assert.ok(f.objects.has('web/current/index.html'));
    assert.ok(f.objects.has('_expo/static/js/v2-lazy.js'));
    const verification = JSON.parse(readFileSync(join(f.reportDirectory, 'verification.json')));
    assert.equal(verification.after.versions, 5);assert.equal(verification.protectedChecksumsVerified, true);
    const repeat = await runCleanup(f.client, { ...f, apply: true });assert.equal(repeat.deletedObjects, 0);
  } finally { f.cleanup(); }
});

for (const failure of ['missing release', 'missing shared dependency', 'changed shared dependency', 'invalid metadata', 'out of scope']) {
  test(`${failure} aborts planning before any delete`, async () => {
    const f = fixture();
    try {
      if (failure === 'missing release') f.objects.delete(`web/releases/${sha(2)}/index.html`);
      if (failure === 'missing shared dependency') f.objects.delete('assets/shared.png');
      if (failure === 'changed shared dependency') f.objects.get('assets/shared.png').ETag = '"different"';
      if (failure === 'invalid metadata') f.objects.get('assets/shared.png').LastModified = 'invalid';
      if (failure === 'out of scope') {
        const original = f.client.list;f.client.list = prefix => [...original(prefix), f.objects.get('uploads/private.png')];
      }
      await assert.rejects(runCleanup(f.client, { ...f, apply: true }));assert.equal(f.calls.length, 0);
    } finally { f.cleanup(); }
  });
}

test('mismatched rollback HTML aborts before deletion', async () => {
  const f = fixture();
  try {
    f.objects.get('web/rollback/run5/index.html').text = f.objects.get('web/rollback/run4/index.html').text;
    await assert.rejects(runCleanup(f.client, { ...f, apply: true }), /Rollback HTML/);assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test('listing errors and active deployments abort before deleting anything', async () => {
  const f = fixture();
  try {
    await assert.rejects(runCleanup(f.client, { ...f, apply: true, checkDeployment: async () => { throw Error('active deployment'); } }), /active/);
    f.client.list = () => { throw Error('list failed'); };
    await assert.rejects(runCleanup(f.client, { ...f, apply: true }), /list failed/);assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test('current revision change stops subsequent batches', async () => {
  const f = fixture();
  try {
    const remove = f.client.delete;
    f.client.delete = file => {
      const result = remove(file);f.objects.get('web/current/.paws-release-revision').text = sha(5);return result;
    };
    await assert.rejects(runCleanup(f.client, { ...f, apply: true }), /Current Web changed/);
    assert.equal(f.calls.length, 1);assert.ok(f.objects.has(`web/releases/${sha(1)}/index.html`));
  } finally { f.cleanup(); }
});

for (const failure of ['per-object error', 'incomplete receipt', 'retained corruption', 'object not deleted']) {
  test(`${failure} is detected and does not report success`, async () => {
    const f = fixture();
    try {
      const remove = f.client.delete;
      if (failure === 'per-object error') f.client.delete = () => ({ Error: [{ Key: 'x', Code: 'AccessDenied' }] });
      if (failure === 'incomplete receipt') f.client.delete = () => ({ Deleted: [] });
      if (failure === 'retained corruption') f.client.delete = file => {
        const result = remove(file);f.objects.get('assets/shared.png').ETag = '"corrupt"';return result;
      };
      if (failure === 'object not deleted') f.client.delete = file => ({ Deleted: JSON.parse(readFileSync(file)).Object });
      await assert.rejects(runCleanup(f.client, { ...f, apply: true }));
      assert.throws(() => readFileSync(join(f.reportDirectory, 'summary.json')));
    } finally { f.cleanup(); }
  });
}

test('large deletion batches are capped at 1000 and exact raw keys survive encoding', async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 1002; n++) f.add(`assets/old [${n}] #字.png`, 'old');
    await runCleanup(f.client, { ...f, apply: true });
    assert.ok(f.calls.some(keys => keys.length === 1000));assert.ok(f.calls.flat().includes('assets/old [1001] #字.png'));
  } finally { f.cleanup(); }
});

test('destructive CLI mode refuses local/feature branch execution before OSS access', () => {
  const r = spawnSync(process.execPath, [new URL('./cleanup-web-assets.cjs', import.meta.url).pathname, '--apply'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/feature',
      GITHUB_WORKFLOW: 'Daily Web OSS retention', PAWS_WEB_RETENTION_LOCK: 'paws-web-production' },
  });
  assert.equal(r.status, 1);assert.match(r.stderr, /main retention workflow/);
});

test('daily workflow uses 03:17 CST, an independent shared mutex, main-only apply and reports', () => {
  const retention = parse(readFileSync(new URL('../.github/workflows/web-retention.yml', import.meta.url), 'utf8'));
  const deploy = parse(readFileSync(new URL('../.github/workflows/web-production-deploy.yml', import.meta.url), 'utf8'));
  assert.equal(retention.on.schedule[0].cron, '17 19 * * *');assert.equal(retention.on.push, undefined);
  assert.equal(retention.concurrency.group, deploy.concurrency.group);
  assert.equal(retention.concurrency['cancel-in-progress'], false);
  assert.equal(retention.concurrency.queue, 'max');assert.equal(deploy.concurrency.queue, 'max');
  assert.equal(retention.jobs.cleanup.if, "github.ref == 'refs/heads/main'");
  assert.equal(retention.on.workflow_dispatch.inputs.dry_run.default, true);
  const steps = retention.jobs.cleanup.steps;
  const step = steps.find(s => s.env?.RETENTION_MODE);
  assert.match(step.env.RETENTION_MODE, /event_name == 'schedule' && '--apply'/);
  assert.match(step.run, /cleanup-web-assets.cjs/);
  assert.equal(steps.at(-1).if, 'always()');assert.equal(steps.at(-1).with['retention-days'], 30);
  for (const step of steps.filter(s => s.run && !s.env?.RETENTION_MODE)) assert.equal(spawnSync('bash', ['-n'], { input: step.run }).status, 0);
  const ci = parse(readFileSync(new URL('../.github/workflows/web-deployment-test.yml', import.meta.url), 'utf8'));
  for (const event of ['pull_request', 'push']) assert.ok(ci.on[event].paths.includes('scripts/cleanup-web-assets*'));
  assert.ok(ci.jobs.test.steps.some(s => s.run?.includes('scripts/cleanup-web-assets.test.mjs')));
});
