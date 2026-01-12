#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { homedir } from 'os';

// Check if we're already running with the flags
const hasNoWarnings = process.execArgv.includes('--no-warnings');
const hasNoDeprecation = process.execArgv.includes('--no-deprecation');

// Set development environment variables
process.env.HAPPY_HOME_DIR = join(homedir(), '.happy-dev');
process.env.HAPPY_VARIANT = 'dev';

if (!hasNoWarnings || !hasNoDeprecation) {
  // Re-execute with the flags
  const __filename = fileURLToPath(import.meta.url);
  const scriptPath = join(dirname(__filename), '../dist/index.mjs');

  try {
    execFileSync(
      process.execPath,
      ['--no-warnings', '--no-deprecation', scriptPath, ...process.argv.slice(2)],
      {
        stdio: 'inherit',
        env: process.env
      }
    );
  } catch (error) {
    // Exit with the same code as the subprocess
    process.exit(error.status || 1);
  }
} else {
  // Already have the flags, import normally
  await import('../dist/index.mjs');
}
