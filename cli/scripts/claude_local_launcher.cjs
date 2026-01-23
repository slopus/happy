const fs = require('fs');

// Disable autoupdater (never works really)
process.env.DISABLE_AUTOUPDATER = '1';

// CRITICAL: Handle termination signals properly to ensure Claude CLI is cleaned up
// This prevents zombie processes that continue to read stdin after mode switches

// Immediate exit on signal - no waiting, no cleanup
function immediateExit(signal) {
    // Kill the Claude CLI child process if it exists
    if (process.claudeCliChild && process.claudeCliChild.pid) {
        try {
            // Kill the entire process group if possible
            process.kill(-process.claudeCliChild.pid, 'SIGTERM');
        } catch (e) {
            // Fallback to killing just the child PID
            try {
                process.kill(process.claudeCliChild.pid, 'SIGTERM');
            } catch (e2) {
                // Already dead
            }
        }
    }

    process.exit(1);
}

// Register signal handlers IMMEDIATELY
process.on('SIGTERM', immediateExit);
process.on('SIGINT', immediateExit);

// Also listen for disconnect (when parent closes IPC)
process.on('disconnect', () => {
    if (process.claudeCliChild && process.claudeCliChild.pid) {
        try {
            process.kill(-process.claudeCliChild.pid, 'SIGTERM');
        } catch (e) {
            // Ignore
        }
    }
    process.exit(1);
});

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

// CRITICAL: Re-register signal handlers after Claude CLI loads
// This ensures our handlers take precedence
function forceCleanup() {
    process.exit(1);
}

// Register multiple times to ensure they stick
process.on('SIGTERM', forceCleanup);
process.on('SIGINT', forceCleanup);
process.on('SIGTERM', forceCleanup);
process.on('SIGINT', forceCleanup);

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
const { getClaudeCliPath, runClaudeCli } = require('./claude_version_utils.cjs');

runClaudeCli(getClaudeCliPath());