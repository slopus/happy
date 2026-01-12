#!/usr/bin/env node
/**
 * Cross-platform environment wrapper for happy CLI
 * Sets HAPPY_HOME_DIR and provides visual feedback
 *
 * Usage: node scripts/env-wrapper.js <variant> <command> [...args]
 *
 * Variants:
 *   - stable: Production-ready version using ~/.happy/
 *   - dev: Development version using ~/.happy-dev/
 *
 * Examples:
 *   node scripts/env-wrapper.js stable daemon start
 *   node scripts/env-wrapper.js dev auth login
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const VARIANTS = {
  stable: {
    homeDir: path.join(os.homedir(), '.happy'),
    color: '\x1b[32m', // Green
    label: '✅ STABLE',
    serverUrl: process.env.HAPPY_SERVER_URL || 'https://api.cluster-fluster.com'
  },
  dev: {
    homeDir: path.join(os.homedir(), '.happy-dev'),
    color: '\x1b[33m', // Yellow
    label: '🔧 DEV',
    serverUrl: process.env.HAPPY_SERVER_URL || 'https://api.cluster-fluster.com'
  }
};

const variant = process.argv[2];
const command = process.argv[3];
const args = process.argv.slice(4);

if (!variant || !VARIANTS[variant]) {
  console.error('Usage: node scripts/env-wrapper.js <stable|dev> <command> [...args]');
  console.error('');
  console.error('Variants:');
  console.error('  stable - Production-ready version (data: ~/.happy/)');
  console.error('  dev    - Development version (data: ~/.happy-dev/)');
  console.error('');
  console.error('Examples:');
  console.error('  node scripts/env-wrapper.js stable daemon start');
  console.error('  node scripts/env-wrapper.js dev auth login');
  process.exit(1);
}

if (!command) {
  console.error('Usage: node scripts/env-wrapper.js <stable|dev> <command> [...args]');
  console.error('');
  console.error('Examples:');
  console.error('  node scripts/env-wrapper.js stable daemon start');
  console.error('  node scripts/env-wrapper.js dev auth login');
  process.exit(1);
}

const config = VARIANTS[variant];

// Create home directory if it doesn't exist
if (!fs.existsSync(config.homeDir)) {
  fs.mkdirSync(config.homeDir, { recursive: true });
}

// Visual feedback
console.log(`${config.color}${config.label}\x1b[0m Happy CLI (data: ${config.homeDir})`);

// Set environment and execute command
const env = {
  ...process.env,
  HAPPY_HOME_DIR: config.homeDir,
  HAPPY_SERVER_URL: config.serverUrl,
  HAPPY_VARIANT: variant, // For internal validation
};

const binPath = path.join(__dirname, '..', 'bin', 'happy.mjs');
const proc = spawn('node', [binPath, command, ...args], {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

proc.on('exit', (code) => process.exit(code || 0));
