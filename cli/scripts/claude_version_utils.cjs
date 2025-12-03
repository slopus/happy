/**
 * Shared utilities for finding and resolving Claude Code CLI path
 * Used by both local and remote launchers
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Find path to globally installed Claude Code CLI
 * @returns {string|null} Path to cli.js or null if not found
 */
function findGlobalClaudeCliPath() {
    try {
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

/**
 * Get version from Claude Code package.json
 * @param {string} cliPath - Path to cli.js
 * @returns {string|null} Version string or null
 */
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

/**
 * Compare semver versions
 * @param {string} a - First version
 * @param {string} b - Second version
 * @returns {number} 1 if a > b, -1 if a < b, 0 if equal
 */
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

/**
 * Get the CLI path to use (global installation)
 * @returns {string} Path to cli.js
 * @throws {Error} If no global installation found
 */
function getClaudeCliPath() {
    const globalCliPath = findGlobalClaudeCliPath();
    if (!globalCliPath) {
        console.error('\n\x1b[31m╔════════════════════════════════════════════════════════════╗\x1b[0m');
        console.error('\x1b[31m║\x1b[0m  \x1b[1m\x1b[33mClaude Code is not installed globally\x1b[0m                      \x1b[31m║\x1b[0m');
        console.error('\x1b[31m╠════════════════════════════════════════════════════════════╣\x1b[0m');
        console.error('\x1b[31m║\x1b[0m                                                            \x1b[31m║\x1b[0m');
        console.error('\x1b[31m║\x1b[0m  Please install Claude Code:                               \x1b[31m║\x1b[0m');
        console.error('\x1b[31m║\x1b[0m                                                            \x1b[31m║\x1b[0m');
        console.error('\x1b[31m║\x1b[0m  \x1b[36mnpm install -g @anthropic-ai/claude-code\x1b[0m                 \x1b[31m║\x1b[0m');
        console.error('\x1b[31m║\x1b[0m                                                            \x1b[31m║\x1b[0m');
        console.error('\x1b[31m╚════════════════════════════════════════════════════════════╝\x1b[0m\n');
        process.exit(1);
    }
    return globalCliPath;
}

module.exports = {
    findGlobalClaudeCliPath,
    getVersion,
    compareVersions,
    getClaudeCliPath
};

