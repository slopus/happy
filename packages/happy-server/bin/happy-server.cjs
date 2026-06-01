#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { resolveServerArtifact } = require('../index.cjs');

const artifact = resolveServerArtifact();
if (!artifact) {
  console.error('Could not locate the Happy server package runtime.');
  process.exit(1);
}

const env = { ...process.env };
if (artifact.webappDir && !env.HAPPY_STATIC_DIR) {
  env.HAPPY_STATIC_DIR = artifact.webappDir;
}

const child = spawn(artifact.command, [...artifact.prefixArgs, ...process.argv.slice(2)], {
  cwd: artifact.cwd,
  env,
  stdio: 'inherit',
});

child.on('error', error => {
  console.error(error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
