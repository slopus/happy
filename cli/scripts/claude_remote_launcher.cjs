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
const { getClaudeCliPath } = require('./claude_version_utils.cjs');
const { pathToFileURL } = require('url');

const globalCliPath = getClaudeCliPath();
const importUrl = pathToFileURL(globalCliPath).href;
import(importUrl);