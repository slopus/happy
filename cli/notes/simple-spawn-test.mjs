#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { writeFileSync, appendFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let currentProcess = null;
let mode = 'echo';
let sessionId = null;

const command = 'claude';
const workingDirectory = resolve(__dirname, '..');

const logFile = resolve(__dirname, 'simple-spawn-test.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  if (!existsSync(logFile)) {
    writeFileSync(logFile, '');
  }
  appendFileSync(logFile, logMessage);
  // NO DO NOT LOG
  // console.log(message);
}

log('[MAIN] Setting stdin to raw mode');
process.stdin.setRawMode(true);
process.stdin.resume();
log('[MAIN] stdin ready');

process.stdin.on('data', (data) => {
  log(`[STDIN] Data received, length: ${data.length}, mode: ${mode}`);
  if (data.toString() === '\u0003') {
    log('[STDIN] Ctrl+C detected');
    cleanup();
    process.exit();
  }
  
  if (currentProcess && mode === 'claude') {
    log('[STDIN] Writing to Claude process');
    currentProcess.childProcess.stdin.write(data);
  } else if (mode === 'echo') {
    if (data.toString() === '\r' || data.toString() === '\n') {
      process.stdout.write('\n> ');
    } else {
      process.stdout.write(data);
    }
  }
});

function spawnClaude() {
  log(`[SPAWN] Spawning Claude process (sessionId: ${sessionId})`);
  
  const args = [];
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  log(`[SPAWN] Args: ${JSON.stringify(args)}`);
  
  const childProcess = spawn(command, args, {
    cwd: workingDirectory,
    env: process.env,
    stdio: ['inherit', 'inherit', 'inherit']
  });
  
  log(`[SPAWN] Process spawned, pid: ${childProcess.pid}`);

  // Pipe stdout to our stdout
  childProcess.stdout.on('data', (data) => {
    log(`[SPAWN] stdout data received, length: ${data.length}`);
    
    if (mode === 'claude') {
      process.stdout.write(data);
    }
    
    // Look for session ID in output
    const sessionMatch = data.toString().match(/Session ID: ([a-zA-Z0-9-]+)/);
    if (sessionMatch) {
      sessionId = sessionMatch[1];
      log(`[SPAWN] Detected session ID: ${sessionId}`);
    }
  });
  
  // Pipe stderr to our stderr
  childProcess.stderr.on('data', (data) => {
    log(`[SPAWN] stderr data received, length: ${data.length}`);
    if (mode === 'claude') {
      process.stderr.write(data);
    }
  });
  
  childProcess.on('exit', (code, signal) => {
    log(`[SPAWN] Claude exited with code ${code}, signal: ${signal}`);
    currentProcess = null;
  });
  
  childProcess.on('error', (error) => {
    log(`[SPAWN] Claude process error: ${error.message}`);
    currentProcess = null;
  });
  
  return {
    childProcess
  };
}

function switchToClaude() {
  log('[SWITCH] Starting switch to Claude mode');
  log(`[SWITCH] Current mode: ${mode}`);
  log(`[SWITCH] Current sessionId: ${sessionId}`);
  mode = 'claude';
  
  // Kill existing process if any
  if (currentProcess) {
    log('[SWITCH] Killing existing Claude process');
    currentProcess.childProcess.kill();
    currentProcess = null;
  }
  
  // Clear screen  
  log('[SWITCH] Clearing screen with \\x1b[2J\\x1b[H');
  process.stdout.write('\x1b[2J\x1b[H');
  
  // Spawn new Claude process
  currentProcess = spawnClaude();
  
  log('[SWITCH] Claude mode activated');
  // console.log('\n=== CLAUDE SESSION (10 seconds) ===');
}

function switchToEcho() {
  log('[SWITCH] Starting switch to Echo mode');
  mode = 'echo';
  
  // Kill Claude process
  if (currentProcess) {
    log('[SWITCH] Killing Claude process for echo mode');
    currentProcess.childProcess.kill();
    currentProcess = null;
  } else {
    log('[SWITCH] No Claude process to kill');
  }
  
  // Clear and show echo mode
  log('[SWITCH] Clearing screen for echo mode');
  process.stdout.write('\x1b[2J\x1b[H');
  console.log('=== ECHO MODE (10 seconds) ===');
  console.log('Type anything, it will echo here.');
  console.log('Claude is not running in this mode.\n');
  console.log('> ');
  log('[SWITCH] Echo mode activated');
}

function cleanup() {
  log('[CLEANUP] Starting cleanup');
  if (currentProcess) {
    currentProcess.childProcess.kill();
  }
  process.stdin.setRawMode(false);
  clearInterval(switchInterval);
  log('[CLEANUP] Cleanup complete');
}

// Handle process termination
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Initial setup
log('[MAIN] Starting simple spawn test with Claude');
console.log('Starting simple spawn test with Claude (Ctrl+C to exit)');
console.log(`Working directory: ${workingDirectory}`);
console.log('Will switch between Claude and echo mode every 10 seconds\n');

// Start with echo mode
setTimeout(() => {
  log('[MAIN] Initial timeout fired, switching to echo');
  switchToEcho();
}, 1000);

// Auto-switch every 10 seconds
const switchInterval = setInterval(() => {
  log(`[INTERVAL] Auto-switch triggered, current mode: ${mode}`);
  if (mode === 'echo') {
    switchToClaude();
  } else {
    switchToEcho();
  }
}, 10000); 