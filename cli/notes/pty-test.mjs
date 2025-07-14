#!/usr/bin/env node

import * as pty from 'node-pty';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let currentProcess = null;
let mode = 'echo';
let sessionId = null;
let screenBuffer = '';

const command = 'claude';
const workingDirectory = resolve(__dirname, '..');

process.stdin.setRawMode(true);
process.stdin.resume();

process.stdin.on('data', (data) => {
  if (data.toString() === '\u0003') {
    cleanup();
    process.exit();
  }
  
  if (currentProcess && mode === 'claude') {
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
  console.log(`\n[LOG] Spawning Claude process (sessionId: ${sessionId})`);
  
  const args = [];
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  
  const childProcess = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: process.stdout.columns,
    rows: process.stdout.rows,
    cwd: workingDirectory,
    env: process.env
  });

  screenBuffer = '';
  
  childProcess.onData((data) => {
    screenBuffer += data;
    if (screenBuffer.length > 100000) {
      screenBuffer = screenBuffer.slice(-50000);
    }
    
    if (mode === 'claude') {
      process.stdout.write(data);
    }
    
    // Look for session ID in output
    const sessionMatch = data.match(/Session ID: ([a-zA-Z0-9-]+)/);
    if (sessionMatch) {
      sessionId = sessionMatch[1];
      console.log(`\n[LOG] Detected session ID: ${sessionId}`);
    }
  });
  
  const resizeHandler = () => {
    childProcess.resize(process.stdout.columns, process.stdout.rows);
  };
  process.on('SIGWINCH', resizeHandler);
  
  childProcess.onExit((exitCode) => {
    console.log(`\n[LOG] Claude exited with code ${exitCode.exitCode}`);
    process.removeListener('SIGWINCH', resizeHandler);
    currentProcess = null;
  });
  
  return {
    childProcess,
    resizeHandler
  };
}

function switchToClaude() {
  console.log('\n[LOG] Switching to Claude mode');
  mode = 'claude';
  
  // Kill existing process if any
  if (currentProcess) {
    console.log('[LOG] Killing existing Claude process');
    currentProcess.childProcess.kill();
    process.removeListener('SIGWINCH', currentProcess.resizeHandler);
    currentProcess = null;
  }
  
  // Clear screen
  process.stdout.write('\x1b[2J\x1b[H');
  
  // Spawn new Claude process
  currentProcess = spawnClaude();
  
  // If we have buffered content, replay it
  if (screenBuffer) {
    const lastScreen = findLastCompleteScreen(screenBuffer);
    if (lastScreen) {
      process.stdout.write(lastScreen);
    }
  }
  
  // Force resize to trigger redraw
  setTimeout(() => {
    if (currentProcess) {
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      currentProcess.childProcess.resize(cols - 1, rows - 1);
      setTimeout(() => {
        currentProcess.childProcess.resize(cols, rows);
      }, 10);
    }
  }, 100);
  
  console.log('\n=== CLAUDE SESSION (10 seconds) ===');
}

function switchToEcho() {
  console.log('\n[LOG] Switching to Echo mode');
  mode = 'echo';
  
  // Kill Claude process
  if (currentProcess) {
    console.log('[LOG] Killing Claude process for echo mode');
    currentProcess.childProcess.kill();
    process.removeListener('SIGWINCH', currentProcess.resizeHandler);
    currentProcess = null;
  }
  
  // Clear and show echo mode
  process.stdout.write('\x1b[2J\x1b[H');
  console.log('=== ECHO MODE (10 seconds) ===');
  console.log('Type anything, it will echo here.');
  console.log('Claude is not running in this mode.\n');
  console.log('> ');
}

function findLastCompleteScreen(buffer) {
  const clearScreen = '\x1b[2J';
  let lastClearIndex = buffer.lastIndexOf(clearScreen);
  
  if (lastClearIndex === -1) {
    return buffer;
  }
  
  return buffer.slice(lastClearIndex);
}

function cleanup() {
  console.log('\n[LOG] Cleaning up...');
  if (currentProcess) {
    currentProcess.childProcess.kill();
    process.removeListener('SIGWINCH', currentProcess.resizeHandler);
  }
  process.stdin.setRawMode(false);
  clearInterval(switchInterval);
}

// Initial setup
console.log('Starting PTY test with Claude (Ctrl+C to exit)');
console.log(`Working directory: ${workingDirectory}`);
console.log('Will switch between Claude and echo mode every 10 seconds\n');

// Start with echo mode
setTimeout(() => {
  switchToEcho();
}, 1000);

// Auto-switch every 10 seconds
const switchInterval = setInterval(() => {
  if (mode === 'echo') {
    switchToClaude();
  } else {
    switchToEcho();
  }
}, 10000);