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
const patchDir = path.resolve(expoAppDir, 'patches');
const patchDirFromRepoRoot = path.relative(repoRootDir, patchDir);
const patchDirFromExpoApp = path.relative(expoAppDir, patchDir);
const repoRootNodeModulesDir = path.resolve(repoRootDir, 'node_modules');
const expoAppNodeModulesDir = path.resolve(expoAppDir, 'node_modules');

const patchPackageCliCandidatePaths = [
    path.resolve(expoAppDir, 'node_modules', 'patch-package', 'dist', 'index.js'),
    path.resolve(repoRootDir, 'node_modules', 'patch-package', 'dist', 'index.js'),
];

const patchPackageCliPath = patchPackageCliCandidatePaths.find((candidatePath) =>
    fs.existsSync(candidatePath),
);

if (!patchPackageCliPath) {
    console.error(
        `Could not find patch-package CLI at:\n${patchPackageCliCandidatePaths
            .map((p) => `- ${p}`)
            .join('\n')}`,
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
// patch-package only patches packages present in the current working directory's
// node_modules, so we run it from the repo root but keep patch files in expo-app/patches.
if (fs.existsSync(repoRootNodeModulesDir)) {
    run(process.execPath, [patchPackageCliPath, '--patch-dir', patchDirFromRepoRoot], {
        cwd: repoRootDir,
    });
}

// Some dependencies are not hoisted (e.g. expo-router) and are installed under expo-app/node_modules.
// Run patch-package again scoped to expo-app to apply those patches.
if (fs.existsSync(expoAppNodeModulesDir)) {
    run(process.execPath, [patchPackageCliPath, '--patch-dir', patchDirFromExpoApp], {
        cwd: expoAppDir,
    });
}

const expoRouterWebModalCandidatePaths = [
    path.resolve(repoRootDir, 'node_modules', 'expo-router', 'build', 'layouts', '_web-modal.js'),
    path.resolve(expoAppDir, 'node_modules', 'expo-router', 'build', 'layouts', '_web-modal.js'),
];

const existingExpoRouterWebModalPaths = expoRouterWebModalCandidatePaths.filter((candidatePath) =>
    fs.existsSync(candidatePath),
);

if (existingExpoRouterWebModalPaths.length === 0) {
    console.error(
        `Could not find expo-router _web-modal.js at:\n${expoRouterWebModalCandidatePaths
            .map((p) => `- ${p}`)
            .join('\n')}`,
    );
    process.exit(1);
}

const unpatchedPaths = [];
for (const filePath of existingExpoRouterWebModalPaths) {
    const contents = fs.readFileSync(filePath, 'utf8');
    if (!contents.includes('ExperimentalModalStack')) {
        unpatchedPaths.push(filePath);
    }
}

if (unpatchedPaths.length > 0) {
    console.error(
        `expo-router web modals patch does not appear to be applied to:\n${unpatchedPaths
            .map((p) => `- ${p}`)
            .join('\n')}`,
    );
    process.exit(1);
}

run('npx', ['setup-skia-web', 'public'], { cwd: expoAppDir });
