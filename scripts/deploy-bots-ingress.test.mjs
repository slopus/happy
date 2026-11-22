import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./deploy-bots-ingress.sh', import.meta.url));
const unavailable = JSON.stringify({ error: 'Rakazo runtime is unavailable' });
function execute(change, { status = '200', body = '', exitCode = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'paws-bots-health-gate-'));
  try {
    const executable = (name, body) => writeFileSync(join(dir, name), '#!/bin/sh\n' + body, { mode: 0o755 });
    executable('ssh', 'cat >/dev/null\nprintf "{}\\n"\n');
    executable('scp', 'exit 0\n');
    executable('node', 'if [ "$1" = "scripts/configure-production-bots-caddy.mjs" ]; then\n [ "$TEST_BOTS_CHANGE" != "invalid" ] || exit 2\n printf "%s\\n" "$TEST_BOTS_CHANGE"\nelse\n exec "$TEST_REAL_NODE" "$@"\nfi\n');
    executable('curl', `exec "$TEST_REAL_NODE" --input-type=commonjs - "$@" <<'CURL'
const fs = require('node:fs');
const output = process.argv.indexOf('--output');
fs.writeFileSync(process.argv[output + 1], process.env.TEST_BOTS_BODY);
process.stdout.write(process.env.TEST_BOTS_STATUS);
process.exit(Number(process.env.TEST_BOTS_CURL_EXIT));
CURL
`);
    return spawnSync('/bin/bash', [script], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: dir + ':' + process.env.PATH,
        GITHUB_REF: 'refs/heads/main', PAWS_DEPLOY_HOST: 'root@47.115.228.20', PAWS_DEPLOY_PORT: '22',
        GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_OUTPUT: join(dir, 'output'),
        TEST_REAL_NODE: process.execPath, TEST_BOTS_CHANGE: change, TEST_BOTS_CURL_EXIT: String(exitCode),
        TEST_BOTS_STATUS: status, TEST_BOTS_BODY: body,
      },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('only the known existing runtime 502 warns without claiming Bots health', () => {
  const result = execute('unchanged', { status: '502', body: unavailable });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /::warning::Existing Bots runtime is unavailable/);
  assert.doesNotMatch(result.stdout, /ingress verified/);
});
test('a changed ingress must still pass its public health check', () => {
  const result = execute('changed', { status: '502', body: unavailable });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /::error::The Bots ingress failed/);
  assert.doesNotMatch(result.stdout, /Continuing the Web release/);
});
for (const change of ['changed', 'unchanged']) test(`a healthy ${change} ingress remains verified`, () => {
  const result = execute(change);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ingress verified/);
});
for (const exitCode of [7, 28, 60]) test(`transport/TLS failure ${exitCode} stays fatal`, () => {
  const result = execute('unchanged', { status: '000', body: unavailable, exitCode });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /failed before receiving a valid HTTP response/);
  assert.doesNotMatch(result.stdout, /::warning::/);
});
for (const [status, body] of [['401', unavailable], ['403', unavailable], ['404', unavailable], ['500', unavailable], ['502', '{}'], ['502', 'not json'], ['502', JSON.stringify({ error: 'Rakazo runtime is unavailable', extra: true })]]) {
  test(`unrecognized HTTP ${status} response stays fatal: ${body}`, () => {
    const result = execute('unchanged', { status, body });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /::warning::/);
  });
}
test('configuration validation errors are never softened', () => {
  const result = execute('invalid', { status: '502', body: unavailable });
  assert.equal(result.status, 2, result.stderr);
  assert.doesNotMatch(result.stdout, /::warning::/);
});
