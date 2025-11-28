// Intercept setTimeout for the Claude Code SDK
const originalSetTimeout = global.setTimeout;

global.setTimeout = function(callback, delay, ...args) {
    // Just wrap and call the original setTimeout
    return originalSetTimeout(callback, delay, ...args);
};

// Preserve setTimeout properties
Object.defineProperty(global.setTimeout, 'name', { value: 'setTimeout' });
Object.defineProperty(global.setTimeout, 'length', { value: originalSetTimeout.length });

// Use the same global claude detection as claude_local_launcher.cjs
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

function findGlobalClaudeCliPath() {
    try {
        const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
        const globalCliPath = path.join(globalRoot, '@anthropic-ai', 'claude-code', 'cli.js');
        if (fs.existsSync(globalCliPath)) {
            return globalCliPath;
        }
    } catch (e) {}
    return null;
}

function getBundledCliPath() {
    return require.resolve('@anthropic-ai/claude-code/cli.js');
}

function getVersion(cliPath) {
    try {
        const pkgPath = path.join(path.dirname(cliPath), 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            return pkg.version;
        }
    } catch (e) {}
    return null;
}

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

const globalCliPath = findGlobalClaudeCliPath();
const bundledCliPath = getBundledCliPath();
const globalVersion = globalCliPath ? getVersion(globalCliPath) : null;
const bundledVersion = getVersion(bundledCliPath);

let cliPathToUse = bundledCliPath;
if (globalCliPath && globalVersion && bundledVersion && compareVersions(globalVersion, bundledVersion) >= 0) {
    cliPathToUse = globalCliPath;
} else if (globalCliPath && globalVersion && !bundledVersion) {
    cliPathToUse = globalCliPath;
}

const importUrl = pathToFileURL(cliPathToUse).href;
import(importUrl);