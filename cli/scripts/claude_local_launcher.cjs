const fs = require('fs');

// Disable autoupdater (never works really)
process.env.DISABLE_AUTOUPDATER = '1';

// Helper to write JSON messages to fd 3
function writeMessage(message) {
    try {
        fs.writeSync(3, JSON.stringify(message) + '\n');
    } catch (err) {
        // fd 3 not available, ignore
    }
}

// Intercept fetch to track thinking state
const originalFetch = global.fetch;
let fetchCounter = 0;

global.fetch = function(...args) {
    const id = ++fetchCounter;
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const method = args[1]?.method || 'GET';
    
    // Parse URL for privacy
    let hostname = '';
    let path = '';
    try {
        const urlObj = new URL(url, 'http://localhost');
        hostname = urlObj.hostname;
        path = urlObj.pathname;
    } catch (e) {
        // If URL parsing fails, use defaults
        hostname = 'unknown';
        path = url;
    }
    
    // Send fetch start event
    writeMessage({
        type: 'fetch-start',
        id,
        hostname,
        path,
        method,
        timestamp: Date.now()
    });

    // Execute the original fetch immediately
    const fetchPromise = originalFetch(...args);
    
    // Attach handlers to send fetch end event
    const sendEnd = () => {
        writeMessage({
            type: 'fetch-end',
            id,
            timestamp: Date.now()
        });
    };
    
    // Send end event on both success and failure
    fetchPromise.then(sendEnd, sendEnd);
    
    // Return the original promise unchanged
    return fetchPromise;
};

// Preserve fetch properties
Object.defineProperty(global.fetch, 'name', { value: 'fetch' });
Object.defineProperty(global.fetch, 'length', { value: originalFetch.length });

// Import global Claude Code CLI
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