#!/usr/bin/env node

/**
 * Ripgrep runner - executed as a subprocess to run the native module
 * This file is intentionally written in CommonJS to avoid ESM complexities
 */

const path = require('path');
const os = require('os');

// Determine platform-specific path
function getPlatformDir() {
    const platform = os.platform();
    const arch = os.arch();
    const platformKey = `${arch}-${platform}`;
    
    const platformMap = {
        'arm64-darwin': 'arm64-darwin',
        'x64-darwin': 'x64-darwin',
        'arm64-linux': 'arm64-linux',
        'x64-linux': 'x64-linux',
        'x64-win32': 'x64-win32'
    };
    
    return platformMap[platformKey];
}

// Load the native module
const platformDir = getPlatformDir();
if (!platformDir) {
    console.error(`Unsupported platform: ${os.arch()}-${os.platform()}`);
    process.exit(1);
}

const modulePath = path.join(__dirname, '..', 'ripgrep', platformDir, 'ripgrep.node');
const ripgrepNative = require(modulePath);

// Get arguments from command line (skip node and script name)
const args = process.argv.slice(2);

// Parse the JSON-encoded arguments
let parsedArgs;
try {
    parsedArgs = JSON.parse(args[0]);
} catch (error) {
    console.error('Failed to parse arguments:', error.message);
    process.exit(1);
}

// Run ripgrep
try {
    const exitCode = ripgrepNative.ripgrepMain(parsedArgs);
    process.exit(exitCode);
} catch (error) {
    console.error('Ripgrep error:', error.message);
    process.exit(1);
}