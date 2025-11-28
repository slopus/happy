const crypto = require('crypto');
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

// Intercept crypto.randomUUID
const originalRandomUUID = crypto.randomUUID;
Object.defineProperty(global, 'crypto', {
    configurable: true,
    enumerable: true,
    get() {
        return {
            randomUUID: () => {
                const uuid = originalRandomUUID();
                writeMessage({ type: 'uuid', value: uuid });
                return uuid;
            }
        };
    }
});
Object.defineProperty(crypto, 'randomUUID', {
    configurable: true,
    enumerable: true,
    get() {
        return () => {
            const uuid = originalRandomUUID();
            writeMessage({ type: 'uuid', value: uuid });
            return uuid;
        }
    }
});

// Intercept fetch to track activity
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

// Determine which cli.js to import
// We need to import (not spawn) to keep interceptors working
const { execSync } = require('child_process');
const path = require('path');

function findGlobalClaudeCliPath() {
    try {
        // Try to find global npm root
        const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
        const globalCliPath = path.join(globalRoot, '@anthropic-ai', 'claude-code', 'cli.js');
        if (fs.existsSync(globalCliPath)) {
            return globalCliPath;
        }
    } catch (e) {
        // npm root -g failed
    }
    return null;
}

function getBundledCliPath() {
    // Bundled version in local node_modules
    return require.resolve('@anthropic-ai/claude-code/cli.js');
}

function getGlobalVersion(cliPath) {
    try {
        const pkgPath = path.join(path.dirname(cliPath), 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            return pkg.version;
        }
    } catch (e) {}
    return null;
}

// Find paths and versions
const globalCliPath = findGlobalClaudeCliPath();
const bundledCliPath = getBundledCliPath();
const globalVersion = globalCliPath ? getGlobalVersion(globalCliPath) : null;
const bundledVersion = getGlobalVersion(bundledCliPath);

console.error(`[LAUNCHER] Global: ${globalVersion || 'not found'}, Bundled: ${bundledVersion || 'unknown'}`);

// Compare versions and use the newer one
function compareVersions(a, b) {
    if (!a || !b) return 0;
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (partsA[i] > partsB[i]) return 1;
        if (partsA[i] < partsB[i]) return -1;
    }
    return 0;
}

let cliPathToUse = bundledCliPath;
if (globalCliPath && globalVersion && bundledVersion) {
    if (compareVersions(globalVersion, bundledVersion) >= 0) {
        cliPathToUse = globalCliPath;
        console.error(`[LAUNCHER] Using global claude (${globalVersion}): ${globalCliPath}`);
    } else {
        console.error(`[LAUNCHER] Using bundled claude (${bundledVersion}): ${bundledCliPath}`);
    }
} else if (globalCliPath && globalVersion) {
    cliPathToUse = globalCliPath;
    console.error(`[LAUNCHER] Using global claude (${globalVersion}): ${globalCliPath}`);
} else {
    console.error(`[LAUNCHER] Using bundled claude: ${bundledCliPath}`);
}

// Import the chosen cli.js (keeps interceptors working)
// On Windows, convert path to file:// URL for ESM import
const { pathToFileURL } = require('url');
const importUrl = pathToFileURL(cliPathToUse).href;
import(importUrl);