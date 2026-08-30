'use strict';

/**
 * Builds the publishable self-host runtime.
 *
 * This package does not own the server source — it is the publishing shell
 * around packages/happy-server, which stays private and is what production
 * deploys. We reach into the sibling at build time only (same pattern as
 * happy-cli/scripts/bundle-webapp.cjs reaching into happy-app).
 *
 * Produces:
 *   dist/standalone.mjs  — bun bundle of ../happy-server/sources/standalone.ts
 *   prisma/              — schema + migrations, copied from the sibling
 *
 * Both must physically exist inside this package: standalone.ts resolves
 * prisma/migrations from process.cwd(), and index.cjs spawns with
 * cwd = package root.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const serverPackage = path.resolve(root, '..', 'happy-server');
const entry = path.join(serverPackage, 'sources', 'standalone.ts');
const pkg = require(path.join(root, 'package.json'));
const dist = path.join(root, 'dist');

if (!fs.existsSync(entry)) {
  console.error(`Missing ${entry}. Run from the monorepo.`);
  process.exit(1);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const args = [
  'build',
  entry,
  '--target',
  'node',
  '--format',
  'esm',
  '--outfile',
  path.join(dist, 'standalone.mjs'),
];

// The bundle externalizes every dependency, so this package's dependency list
// must match the one the source is written against. Drift would otherwise ship
// a runtime whose imports are missing at require time.
const serverPkg = require(path.join(serverPackage, 'package.json'));
const ours = pkg.dependencies ?? {};
const theirs = serverPkg.dependencies ?? {};
const drift = [
  ...Object.keys(theirs).filter(d => ours[d] !== theirs[d]).map(d => `  missing/differs: ${d}@${theirs[d]} (here: ${ours[d] ?? 'absent'})`),
  ...Object.keys(ours).filter(d => !(d in theirs)).map(d => `  extra: ${d}@${ours[d]}`),
];
if (drift.length > 0) {
  console.error(`Dependency drift between ${pkg.name} and ${serverPkg.name}:`);
  console.error(drift.join('\n'));
  console.error('Keep both dependency lists in sync.');
  process.exit(1);
}

const bundledDependencies = new Set([
  // The published 0.1.0 package does not include the newest voice schemas yet.
  // Keep the server release unblocked by bundling the workspace copy.
  '@slopus/happy-wire',
]);

for (const dependency of Object.keys(pkg.dependencies ?? {})) {
  if (bundledDependencies.has(dependency)) continue;
  args.push('--external', dependency);
}

// Bundle from the server package so bun resolves its imports and tsconfig
// paths exactly as it did when the two lived in one package.
const result = spawnSync('bun', args, {
  cwd: serverPackage,
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status);
}

// prisma/ ships inside this package: the runtime looks for prisma/migrations
// under process.cwd(), and postinstall generates the client from
// prisma/schema.prisma.
const prismaSource = path.join(serverPackage, 'prisma');
const prismaTarget = path.join(root, 'prisma');
fs.rmSync(prismaTarget, { recursive: true, force: true });
fs.cpSync(prismaSource, prismaTarget, { recursive: true });
console.log(`Copied prisma/ from ${path.relative(root, prismaSource)}`);
