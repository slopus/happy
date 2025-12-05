// Intercept setTimeout for the Claude Code SDK
const originalSetTimeout = global.setTimeout;

global.setTimeout = function(callback, delay, ...args) {
    // Just wrap and call the original setTimeout
    return originalSetTimeout(callback, delay, ...args);
};

// Preserve setTimeout properties
Object.defineProperty(global.setTimeout, 'name', { value: 'setTimeout' });
Object.defineProperty(global.setTimeout, 'length', { value: originalSetTimeout.length });

// Import global Claude Code CLI (shared utils with local launcher)
// We need to import (not spawn) to keep interceptors working
// However, Homebrew installs a binary file, so we need to handle that case
const { getClaudeCliPath } = require('./claude_version_utils.cjs');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');

const globalCliPath = getClaudeCliPath();

// Check if it's a JavaScript file (.js or .cjs) or a binary file
const isJsFile = globalCliPath.endsWith('.js') || globalCliPath.endsWith('.cjs');

if (isJsFile) {
    // JavaScript file - use import to keep interceptors working
    const importUrl = pathToFileURL(globalCliPath).href;
    import(importUrl);
} else {
    // Binary file (e.g., Homebrew installation) - spawn directly
    // Note: Interceptors won't work with binary files, but that's acceptable
    // as binary files are self-contained and don't need interception
    const args = process.argv.slice(2);
    const child = spawn(globalCliPath, args, {
        stdio: 'inherit',
        env: process.env
    });
    child.on('exit', (code) => {
        process.exit(code || 0);
    });
}