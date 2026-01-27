#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

// Ensure Node flags to reduce noisy warnings on stdout (which could interfere with MCP)
const hasNoWarnings = process.execArgv.includes('--no-warnings');
const hasNoDeprecation = process.execArgv.includes('--no-deprecation');

if (!hasNoWarnings || !hasNoDeprecation) {
  const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const entrypoint = join(projectRoot, 'dist', 'backends', 'codex', 'happyMcpStdioBridge.mjs');

  try {
    execFileSync(process.execPath, [
      '--no-warnings',
      '--no-deprecation',
      entrypoint,
      ...process.argv.slice(2)
    ], {
      stdio: 'inherit',
      env: process.env
    });
  } catch (error) {
    process.exit(error.status || 1);
  }
} else {
  // Already have desired flags; import module directly
  import('../dist/backends/codex/happyMcpStdioBridge.mjs');
}
