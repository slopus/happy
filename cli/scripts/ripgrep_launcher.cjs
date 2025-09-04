#!/usr/bin/env node

/**
 * Ripgrep runner - executed as a subprocess to run the native module
 * This file is intentionally written in CommonJS to avoid ESM complexities
 */

const path = require('path');

// Load the native module from unpacked directory
const modulePath = path.join(__dirname, '..', 'tools', 'unpacked', 'ripgrep.node');
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