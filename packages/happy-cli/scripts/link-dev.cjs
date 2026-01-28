#!/usr/bin/env node
/**
 * link-dev.cjs - Create symlink for happy-dev only
 *
 * This script creates a symlink for the happy-dev command pointing to the local
 * development version, while leaving the stable npm version of `happy` untouched.
 *
 * Usage: yarn link:dev
 *
 * What it does:
 * 1. Finds the global npm bin directory
 * 2. Creates/updates a symlink: happy-dev -> ./bin/happy-dev.mjs
 *
 * To undo: yarn unlink:dev
 */

const { execFileSync } = require('child_process');
const { join, dirname } = require('path');
const fs = require('fs');

const projectRoot = dirname(__dirname);
const binSource = join(projectRoot, 'bin', 'happy-dev.mjs');

// Get the action from command line args
const action = process.argv[2] || 'link';

function getGlobalBinDir() {
    // Try npm global bin first using execFileSync (safer than execSync)
    try {
        const npmBin = execFileSync('npm', ['bin', '-g'], { encoding: 'utf8' }).trim();
        if (fs.existsSync(npmBin)) {
            return npmBin;
        }
    } catch (e) {
        // Fall through to alternatives
    }

    // Common locations by platform
    if (process.platform === 'darwin') {
        // macOS with Homebrew Node (Apple Silicon)
        const homebrewBin = '/opt/homebrew/bin';
        if (fs.existsSync(homebrewBin)) {
            return homebrewBin;
        }
        // Intel Mac Homebrew
        const homebrewUsrBin = '/usr/local/bin';
        if (fs.existsSync(homebrewUsrBin)) {
            return homebrewUsrBin;
        }
    }

    // Fallback to /usr/local/bin
    return '/usr/local/bin';
}

function link() {
    const globalBin = getGlobalBinDir();
    const binTarget = join(globalBin, 'happy-dev');

    console.log('Creating symlink for happy-dev...');
    console.log(`  Source: ${binSource}`);
    console.log(`  Target: ${binTarget}`);

    // Check if source exists
    if (!fs.existsSync(binSource)) {
        console.error(`\n❌ Error: ${binSource} does not exist.`);
        console.error("   Run 'yarn build' first to compile the project.");
        process.exit(1);
    }

    // Remove existing symlink or file
    try {
        const stat = fs.lstatSync(binTarget);
        if (stat.isSymbolicLink() || stat.isFile()) {
            fs.unlinkSync(binTarget);
            console.log(`  Removed existing: ${binTarget}`);
        }
    } catch (e) {
        // File doesn't exist, that's fine
    }

    // Create the symlink
    try {
        fs.symlinkSync(binSource, binTarget);
        console.log('\n✅ Successfully linked happy-dev to local development version');
        console.log('\nNow you can use:');
        console.log('  happy      → stable npm version (unchanged)');
        console.log('  happy-dev  → local development version');
        console.log('\nTo undo: yarn unlink:dev');
    } catch (e) {
        if (e.code === 'EACCES') {
            console.error('\n❌ Permission denied. Try running with sudo:');
            console.error('   sudo yarn link:dev');
        } else {
            console.error(`\n❌ Error creating symlink: ${e.message}`);
        }
        process.exit(1);
    }
}

function unlink() {
    const globalBin = getGlobalBinDir();
    const binTarget = join(globalBin, 'happy-dev');

    console.log('Removing happy-dev symlink...');

    try {
        const stat = fs.lstatSync(binTarget);
        if (stat.isSymbolicLink()) {
            const linkTarget = fs.readlinkSync(binTarget);
            if (linkTarget === binSource || linkTarget.includes('happy-cli')) {
                fs.unlinkSync(binTarget);
                console.log('\n✅ Removed happy-dev development symlink');
                console.log('\nTo restore npm version: npm install -g happy-coder');
            } else {
                console.log(`\n⚠️  happy-dev symlink points elsewhere: ${linkTarget}`);
                console.log('   Not removing. Remove manually if needed.');
            }
        } else {
            console.log(`\n⚠️  ${binTarget} exists but is not a symlink.`);
            console.log('   Not removing. This may be the npm-installed version.');
        }
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.log("\n✅ happy-dev symlink doesn't exist (already removed or never created)");
        } else if (e.code === 'EACCES') {
            console.error('\n❌ Permission denied. Try running with sudo:');
            console.error('   sudo yarn unlink:dev');
            process.exit(1);
        } else {
            console.error(`\n❌ Error: ${e.message}`);
            process.exit(1);
        }
    }
}

// Main
if (action === 'unlink') {
    unlink();
} else {
    link();
}
