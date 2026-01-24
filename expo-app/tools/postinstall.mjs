import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';

// Yarn workspaces can execute this script via a symlinked path (e.g. repoRoot/node_modules/happy/...).
// Resolve symlinks so repoRootDir/expoAppDir are computed from the real filesystem location.
const toolsDir = path.dirname(fs.realpathSync(url.fileURLToPath(import.meta.url)));
const expoAppDir = path.resolve(toolsDir, '..');
const repoRootDir = path.resolve(expoAppDir, '..');

const patchPackageCliCandidatePaths = [
  path.resolve(expoAppDir, 'node_modules', 'patch-package', 'dist', 'index.js'),
  path.resolve(repoRootDir, 'node_modules', 'patch-package', 'dist', 'index.js'),
];

const patchPackageCliPath = patchPackageCliCandidatePaths.find((candidatePath) => fs.existsSync(candidatePath));

if (!patchPackageCliPath) {
  console.error(
    `Could not find patch-package CLI at:\n${patchPackageCliCandidatePaths.map((p) => `- ${p}`).join('\n')}`
  );
  process.exit(1);
}

function run(command, args, options) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Note: this repo uses Yarn workspaces, so some dependencies are hoisted to the repo root.
// patch-package only patches packages present in the current working directory's node_modules.
// We keep patch files under expo-app/patches, but apply them from the repo root so they can patch hoisted deps.
run(process.execPath, [patchPackageCliPath, '--patch-dir', 'expo-app/patches'], { cwd: repoRootDir });

// Optional: some dependencies may not be hoisted and can live under expo-app/node_modules.
// If we ever need patches for those, we can place them under expo-app/patches-expo-app/.
const expoLocalPatchDir = path.resolve(expoAppDir, 'patches-expo-app');
if (fs.existsSync(expoLocalPatchDir)) {
  const hasAnyPatch = fs.readdirSync(expoLocalPatchDir).some((f) => f.endsWith('.patch'));
  if (hasAnyPatch) {
    run(process.execPath, [patchPackageCliPath, '--patch-dir', 'patches-expo-app'], { cwd: expoAppDir });
  }
}

run('npx', ['setup-skia-web', 'public'], { cwd: expoAppDir });

