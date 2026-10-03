'use strict';

/**
 * Post-install steps for installed copies of this package.
 *
 * 1. Patches pglite-prisma-adapter's Bytes handling. The monorepo applies this
 *    from patches/fix-pglite-prisma-bytes.cjs via the root postinstall, which
 *    never runs for consumers who install this package from npm — so it has to
 *    be applied here too, against whichever copy of the adapter npm resolved.
 * 2. Generates the Prisma client.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

/**
 * The adapter's parsePgBytes/normalizeByteaArray return Uint8Array, which
 * serializes as a JSON object {"0":104,"1":101,...} across the JS-WASM boundary
 * to the Prisma query engine. The engine expects a plain number[] or a base64
 * string, and rejects the object with P2023 "Inconsistent column data".
 *
 * Every Bytes column breaks, which in practice means every dataEncryptionKey:
 * GET /v1/sessions and GET /v1/machines return 500 as soon as one encrypted
 * session exists, and no session is ever listed in the app.
 *
 * Upstream fix: https://github.com/lucasthevenet/pglite-utils/pull/50
 */
function patchPgliteAdapterBytes() {
  // The adapter exports no './package.json', so resolve its entry point (main,
  // ./dist/index.cjs) and patch both bundles next to it.
  let distDir;
  try {
    distDir = path.dirname(require.resolve('pglite-prisma-adapter', { paths: [root] }));
  } catch {
    return; // not installed yet (e.g. a fresh monorepo checkout)
  }

  let patched = 0;
  for (const file of ['index.mjs', 'index.cjs']) {
    const filePath = path.join(distDir, file);
    if (!fs.existsSync(filePath)) continue;

    const original = fs.readFileSync(filePath, 'utf8');
    const content = original.replace(
      /Uint8Array\.from\(\s*\{\s*length:\s*hexString\.length\s*\/\s*2\s*\}/g,
      'Array.from({ length: hexString.length / 2 }'
    );

    if (content !== original) {
      fs.writeFileSync(filePath, content, 'utf8');
      patched++;
    }
  }

  if (patched > 0) {
    console.log(`happy-server-self-host: patched pglite-prisma-adapter Bytes handling (${patched} file(s))`);
  }
}

patchPgliteAdapterBytes();

// prisma/ is a build artifact here — it is copied from packages/happy-server by
// build-runtime.cjs and only exists in the published tarball. In a fresh
// monorepo checkout it is absent, so skip rather than fail the workspace
// install.
const schema = path.join(root, 'prisma', 'schema.prisma');

if (!fs.existsSync(schema)) {
  console.log('happy-server-self-host: no prisma/schema.prisma yet, skipping generate (run build first).');
  process.exit(0);
}

const result = spawnSync('prisma', ['generate', `--schema=${schema}`], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) throw result.error;
// status is null when the process was killed by a signal — treat that as failure
// rather than silently leaving the install without a Prisma client.
process.exit(result.status ?? 1);
