#!/usr/bin/env node

import * as pty from 'node-pty';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { writeFileSync, appendFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let currentProcess = null;
let mode = 'echo';
let sessionId = null;
let screenBuffer = '';

const command = 'claude';
const workingDirectory = resolve(__dirname, '..');

const logFile = resolve(__dirname, 'pty-test.log');

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
    log('[STDIN] Writing to Claude PTY');
    currentProcess.childProcess.write(data);
  } else if (mode === 'echo') {
    if (data.toString() === '\r' || data.toString() === '\n') {
      process.stdout.write('\n> ');
    } else {
      process.stdout.write(data);
    }
  }
});

function spawnClaude() {
  log(`[PTY] Spawning Claude process (sessionId: ${sessionId})`);
  log(`[PTY] Terminal size: cols=${process.stdout.columns}, rows=${process.stdout.rows}`);
  
  const args = [];
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  log(`[PTY] Args: ${JSON.stringify(args)}`);
  
  const childProcess = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: process.stdout.columns,
    rows: process.stdout.rows,
    cwd: workingDirectory,
    env: process.env
  });
  log(`[PTY] PTY spawned, pid: ${childProcess.pid}`);

  // Don't clear screen buffer here - we need it for replay!
  
  childProcess.onData((data) => {
    log(`[PTY] onData received, length: ${data.length}`);
    screenBuffer += data;
    if (screenBuffer.length > 100000) {
      log('[PTY] Trimming screen buffer');
      screenBuffer = screenBuffer.slice(-50000);
    }
    
    if (mode === 'claude') {
      process.stdout.write(data);
    }
    
    // Look for session ID in output
    const sessionMatch = data.match(/Session ID: ([a-zA-Z0-9-]+)/);
    if (sessionMatch) {
      sessionId = sessionMatch[1];
      log(`[PTY] Detected session ID: ${sessionId}`);
    }
  });
  
  const resizeHandler = () => {
    log(`[PTY] SIGWINCH - resizing to cols=${process.stdout.columns}, rows=${process.stdout.rows}`);
    childProcess.resize(process.stdout.columns, process.stdout.rows);
  };
  process.on('SIGWINCH', resizeHandler);
  log('[PTY] SIGWINCH handler registered');
  
  childProcess.onExit((exitCode) => {
    log(`[PTY] Claude exited with code ${exitCode.exitCode}`);
    log('[PTY] Removing SIGWINCH handler');
    process.removeListener('SIGWINCH', resizeHandler);
    currentProcess = null;
  });
  
  return {
    childProcess,
    resizeHandler
  };
}

function switchToClaude() {
  log('[SWITCH] Starting switch to Claude mode');
  log(`[SWITCH] Current mode: ${mode}`);
  log(`[SWITCH] Current sessionId: ${sessionId}`);
  log(`[SWITCH] Screen buffer length: ${screenBuffer.length}`);
  mode = 'claude';
  
  // Kill existing process if any
  if (currentProcess) {
    log('[SWITCH] Killing existing Claude process');
    currentProcess.childProcess.kill();
    process.removeListener('SIGWINCH', currentProcess.resizeHandler);
    currentProcess = null;
  }
  
  // Clear screen  
  log('[SWITCH] Clearing screen with \\x1b[2J\\x1b[H');
  process.stdout.write('\x1b[2J\x1b[H');
  
  // Spawn new Claude process
  currentProcess = spawnClaude();
  
  // If we have buffered content, replay it
  if (screenBuffer) {
    log('[SWITCH] Replaying buffered content');
    const lastScreen = findLastCompleteScreen(screenBuffer);
    if (lastScreen) {
      log(`[SWITCH] Found last screen, length: ${lastScreen.length}`);
      process.stdout.write(lastScreen);
    } else {
      log('[SWITCH] No last screen found');
    }
  } else {
    log('[SWITCH] No screen buffer to replay');
  }
  
  // NOW clear the buffer for the new session
  screenBuffer = '';
  
  // Force resize to trigger redraw
  setTimeout(() => {
    if (currentProcess) {
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      log(`[RESIZE] Force resize timeout fired, cols=${cols}, rows=${rows}`);
      log('[RESIZE] Resizing to cols-1, rows-1');
      currentProcess.childProcess.resize(cols - 1, rows - 1);
      setTimeout(() => {
        log('[RESIZE] Resizing back to normal');
        currentProcess.childProcess.resize(cols, rows);
      }, 10);
    } else {
      log('[RESIZE] No current process to resize');
    }
  }, 100);
  
  log('[SWITCH] Claude mode activated');
  console.log('\n=== CLAUDE SESSION (10 seconds) ===');
}

function switchToEcho() {
  log('[SWITCH] Starting switch to Echo mode');
  mode = 'echo';
  
  // Kill Claude process
  if (currentProcess) {
    log('[SWITCH] Killing Claude process for echo mode');
    currentProcess.childProcess.kill();
    process.removeListener('SIGWINCH', currentProcess.resizeHandler);
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

function findLastCompleteScreen(buffer) {
  const clearScreen = '\x1b[2J';
  let lastClearIndex = buffer.lastIndexOf(clearScreen);
  log(`[BUFFER] Finding last screen, buffer length: ${buffer.length}, lastClearIndex: ${lastClearIndex}`);
  
  if (lastClearIndex === -1) {
    return buffer;
  }
  
  return buffer.slice(lastClearIndex);
}

function cleanup() {
  log('[CLEANUP] Starting cleanup');
  if (currentProcess) {
    currentProcess.childProcess.kill();
    process.removeListener('SIGWINCH', currentProcess.resizeHandler);
  }
  process.stdin.setRawMode(false);
  clearInterval(switchInterval);
  log('[CLEANUP] Cleanup complete');
}

// Initial setup
log('[MAIN] Starting PTY test with Claude');
console.log('Starting PTY test with Claude (Ctrl+C to exit)');
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