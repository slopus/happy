#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i < 0 ? d : process.argv[i + 1]; };
const run = arg('--run');
if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(run || '')) throw Error('--run is required');
const minutes = Number(arg('--minutes', '30'));
const warmup = Number(arg('--warmup-minutes', '5'));
// Pages opened concurrently every minute (default = the agent window cap), so windows are really created and destroyed.
const perMinute = Number(arg('--pages-per-minute', '4'));
// Release acceptance (D5/GD5) needs at least 30 measured minutes; shorter runs are diagnostics and never pass.
const ACCEPTANCE_MINUTES = 30;
const diagnostic = process.argv.includes('--diagnostic');
if (!(minutes > 0 && warmup >= 0 && Number.isInteger(perMinute) && perMinute >= 1)) throw Error('invalid duration or --pages-per-minute');
const env = JSON.parse(readFileSync(join(root, '.abp', run, 'env.json')));
const keys = JSON.parse(readFileSync(join(root, '.abp', run, 'keys.json')));
const own = id => execFileSync('docker', ['inspect', '-f', '{{index .Config.Labels "ai.saycode.abp-run"}}', id], { encoding: 'utf8' }).trim() === run;
for (const id of [env.containers.runtime, env.containers.browserA, env.containers.browserB]) if (!own(id)) throw Error('run ownership mismatch');
const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const now = Date.now();
const grant = { kind: 'agent-grant', grantId: `soak-${randomUUID()}`, principalId: 'principal-a', workspaceId: 'workspace-poc', machineId: 'machine-poc', agentSessionId: `soak-${randomUUID()}`, profileId: 'profile-a', allowedOrigins: ['http://a.poc-one.test:8080'], operations: ['createSpace','createTask','openPage','closePage','observe','submitBatch','finishTask','getTask','cancel'], taskSpaceIds: [], issuedAtMs: now, expiresAtMs: now + 30 * 60_000 };
const token = () => { const issuedAtMs = Date.now() - 5000; const fresh = { ...grant, issuedAtMs, expiresAtMs: issuedAtMs + 30 * 60_000 }; const body = Buffer.from(canonical(fresh)).toString('base64url'); return `abp1.${body}.${createHmac('sha256', keys.agentKey).update(`abp1.${body}`).digest('base64url')}`; };
const op = async (name, data) => { const r = await fetch(`http://127.0.0.1:${env.ports.runtime}/v1/ops/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, body: JSON.stringify(data) }); const x = await r.json(); if (!x.ok) throw Error(`${name}: ${x.error?.code} ${x.error?.message ?? ""}`); return x.result; };
const admin = async () => { const r = await fetch(`http://127.0.0.1:${env.ports.admin}/admin/debug`, { headers: { authorization: `Bearer ${keys.adminToken}` } }); const x = await r.json(); if (!x.ok) throw Error('admin debug failed'); return x.result; };
const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8' }).trim();
const stats = id => JSON.parse(docker('stats', '--no-stream', '--format', 'json', id));
const targets = id => JSON.parse(docker('exec', id, 'python3', '-c', "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:9222/json/list').read().decode())")).filter(t => t.type === 'page').length;
const journalBytes = () => Number(docker('exec', env.containers.runtime, 'sh', '-c', "du -sb /var/lib/abp | cut -f1"));
const median = xs => { const a = xs.toSorted((x,y) => x-y); return a.length ? (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)])/2 : NaN; };
// cgroup memory (docker stats) includes page cache; the process view sums Rss of every Chromium process (D5 reports both).
const chromiumRss = id => Number(docker('exec', id, 'sh', '-c', "t=0; for d in /proc/[0-9]*; do case \"$(tr '\\0' ' ' < $d/cmdline 2>/dev/null)\" in *chromium*) r=$(awk '/^Rss:/{print $2}' $d/smaps_rollup 2>/dev/null); t=$((t+${r:-0}));; esac; done; echo $t")) * 1024;
const rss = s => { const m = String(s.MemUsage).split('/')[0].trim().match(/^([\d.]+)([KMG]i?B)$/); return m ? Number(m[1]) * ({ KiB: 1024, MiB: 2**20, GiB: 2**30, KB: 1000, MB: 1e6, GB: 1e9 }[m[2]] ?? 1) : NaN; };
const file = join(root, '.abp', run, 'soak.jsonl');
const space = await op('createSpace', { profileId: 'profile-a', requestId: randomUUID() });
const samples = []; let completed = 0, crashes = 0, taskLoss = 0; const start = Date.now();
for (let minute = 0; minute < warmup + minutes; minute++) {
  let peakTargets = 0;
  const cycle = async () => {
    const task = await op('createTask', { taskSpaceId: space.taskSpaceId, requestId: randomUUID() });
    const opened = await op('openPage', { taskId: task.taskId, url: 'http://a.poc-one.test:8080/marker?label=soak', requestId: randomUUID() });
    const observed = await op('observe', { taskId: task.taskId, tabId: opened.tabId });
    if (!observed.url.includes('/marker')) throw Error('observation target mismatch');
    return { task, opened };
  };
  const open = await Promise.all(Array.from({ length: perMinute }, cycle));
  peakTargets = targets(env.containers.browserA);
  let retained;
  for (const { task, opened } of open) {
    const finished = await op('finishTask', { taskId: task.taskId, expectedVersion: opened.task.stateVersion, requestId: randomUUID() });
    if (finished.status !== 'succeeded') throw Error('task not succeeded');
    await op('closePage', { taskSpaceId: space.taskSpaceId, tabId: opened.tabId, requestId: randomUUID() });
    retained = await op('getTask', { taskId: task.taskId }); if (retained.status !== 'succeeded') taskLoss++;
  }
  const task = open.at(-1).task;
  completed += perMinute;
  const debug = await admin();
  const containers = Object.fromEntries(Object.entries(env.containers).filter(([k]) => ['runtime','browserA','browserB'].includes(k)).map(([k,v]) => [k, stats(v)]));
  for (const id of [env.containers.runtime, env.containers.browserA, env.containers.browserB]) if (docker('inspect', '-f', '{{.State.OOMKilled}} {{.State.Running}}', id) !== 'false true') crashes++;
  const sample = { minute, atMs: Date.now(), phase: minute < warmup ? 'warmup' : 'measure', completed, containers, driver: debug.drivers, browserPageTargets: { a: targets(env.containers.browserA), b: targets(env.containers.browserB) }, peakPageTargetsA: peakTargets, processRssBytes: { browserA: chromiumRss(env.containers.browserA), browserB: chromiumRss(env.containers.browserB) }, journalBytes: journalBytes(), heartbeat: { taskId: task.taskId, stateVersion: retained.stateVersion, updatedAtMs: retained.updatedAtMs }, limits: Object.fromEntries(Object.entries(env.containers).filter(([k]) => ['runtime','browserA','browserB'].includes(k)).map(([k,v]) => [k, docker('inspect','-f','{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}',v)])) };
  appendFileSync(file, JSON.stringify(sample)+'\n'); samples.push(sample);
  const next = start + (minute+1)*60_000; if (next > Date.now()) await new Promise(r => setTimeout(r, next-Date.now()));
}
const measured = samples.filter(s => s.phase === 'measure');
const result = Object.fromEntries(['runtime','browserA','browserB'].map(k => { const first = median(measured.slice(0,5).map(s => rss(s.containers[k]))); const last = median(measured.slice(-5).map(s => rss(s.containers[k]))); return [k, { firstMedianBytes:first, lastMedianBytes:last, allowanceBytes:Math.max(first*.2,100*2**20), pass: measured.length >= 5 && last-first <= Math.max(first*.2,100*2**20) }]; }));
const processRss = Object.fromEntries(['browserA','browserB'].map(k => { const first = median(measured.slice(0,5).map(s => s.processRssBytes[k])); const last = median(measured.slice(-5).map(s => s.processRssBytes[k])); return [k, { firstMedianBytes:first, lastMedianBytes:last, allowanceBytes:Math.max(first*.2,100*2**20), pass: measured.length >= 5 && last-first <= Math.max(first*.2,100*2**20) }]; }));
const maxPageTargets = Math.max(...samples.map(s => Math.max(s.browserPageTargets.a, s.browserPageTargets.b, s.peakPageTargetsA)));
// Acceptance needs the whole requested window: one valid sample per measured minute, both memory views readable.
const finite = x => Number.isFinite(x) && x > 0;
const validSamples = measured.every(s => ['runtime','browserA','browserB'].every(k => finite(rss(s.containers[k]))) && finite(s.processRssBytes.browserA) && finite(s.processRssBytes.browserB));
const measuredSpanMs = measured.length ? measured.at(-1).atMs - measured[0].atMs : 0;
const coverage = { samples: measured.length, requiredSamples: minutes, spanMs: measuredSpanMs, requiredSpanMs: Math.max(0, (minutes - 1) * 60_000 * 0.95), validSamples,
  pass: measured.length === minutes && measuredSpanMs >= Math.max(0, (minutes - 1) * 60_000 * 0.95) && validSamples };
const registryStable = measured.every(s => Object.values(s.driver).every(d => d.counts.tabs === 0 && d.counts.sessions === 0)) && measured.every(s => s.browserPageTargets.a === measured[0].browserPageTargets.a && s.browserPageTargets.b === measured[0].browserPageTargets.b);
const acceptanceEligible = minutes >= ACCEPTANCE_MINUTES;
const summary = { run, minutes, warmup, perMinute, diagnostic, acceptanceEligible, completed, crashes, taskLoss, registryStable, coverage, result, processRss, maxPageTargets, pass: coverage.pass && (acceptanceEligible || diagnostic) && crashes===0 && taskLoss===0 && registryStable && Object.values(result).every(v=>v.pass) && Object.values(processRss).every(v=>v.pass) };
writeFileSync(join(root,'.abp',run,'soak-summary.json'), JSON.stringify(summary,null,2)); console.log(JSON.stringify(summary)); if (!summary.pass) process.exitCode=1;
