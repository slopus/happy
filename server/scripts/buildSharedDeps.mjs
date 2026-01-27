import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..');

const tscBin = resolve(repoRoot, 'server', 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

function runTsc(tsconfigPath) {
  execFileSync(tscBin, ['-p', tsconfigPath], { stdio: 'inherit' });
}

function ensureSymlink({ linkPath, targetPath }) {
  try {
    rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
  mkdirSync(resolve(linkPath, '..'), { recursive: true });
  symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

// Ensure @happy/agents is resolvable from the protocol workspace.
ensureSymlink({
  linkPath: resolve(repoRoot, 'packages', 'protocol', 'node_modules', '@happy', 'agents'),
  targetPath: resolve(repoRoot, 'packages', 'agents'),
});

// Build shared packages (dist/ is the runtime contract).
runTsc(resolve(repoRoot, 'packages', 'agents', 'tsconfig.json'));
runTsc(resolve(repoRoot, 'packages', 'protocol', 'tsconfig.json'));

// Sanity check: ensure protocol dist entry exists.
const protocolDist = resolve(repoRoot, 'packages', 'protocol', 'dist', 'index.js');
if (!existsSync(protocolDist)) {
  throw new Error(`Expected @happy/protocol build output missing: ${protocolDist}`);
}

