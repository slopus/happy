#!/usr/bin/env node

/**
 * Unpacks platform-specific binaries from compressed archives
 * This script extracts the necessary tools for the current platform
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const tar = require('tar');
const os = require('os');

/**
 * Get the platform-specific directory name
 */
function getPlatformDir() {
    const platform = os.platform();
    const arch = os.arch();
    
    if (platform === 'darwin') {
        if (arch === 'arm64') return 'arm64-darwin';
        if (arch === 'x64') return 'x64-darwin';
    } else if (platform === 'linux') {
        if (arch === 'arm64') return 'arm64-linux';
        if (arch === 'x64') return 'x64-linux';
    } else if (platform === 'win32') {
        if (arch === 'x64') return 'x64-win32';
    }
    
    throw new Error(`Unsupported platform: ${arch}-${platform}`);
}

/**
 * Get the root tools directory
 */
function getToolsDir() {
    // Handle both direct execution and require() calls
    const scriptDir = __dirname;
    return path.resolve(scriptDir, '..', 'tools');
}

/**
 * Check if tools are already unpacked for current platform
 */
function areToolsUnpacked(toolsDir) {
    const unpackedPath = path.join(toolsDir, 'unpacked');
    
    if (!fs.existsSync(unpackedPath)) {
        return false;
    }
    
    // Check for expected binaries
    const isWin = os.platform() === 'win32';
    const difftBinary = isWin ? 'difft.exe' : 'difft';
    const rgBinary = isWin ? 'rg.exe' : 'rg';
    
    const expectedFiles = [
        path.join(unpackedPath, difftBinary),
        path.join(unpackedPath, rgBinary),
        path.join(unpackedPath, 'ripgrep.node')
    ];
    
    return expectedFiles.every(file => fs.existsSync(file));
}

/**
 * Unpack a tar.gz archive to a destination directory
 */
async function unpackArchive(archivePath, destDir) {
    return new Promise((resolve, reject) => {
        // Ensure destination directory exists
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        
        // Create read stream and extract
        fs.createReadStream(archivePath)
            .pipe(zlib.createGunzip())
            .pipe(tar.extract({
                cwd: destDir,
                preserveMode: true,
                preserveOwner: false
            }))
            .on('finish', () => {
                // Set executable permissions for Unix systems
                if (os.platform() !== 'win32') {
                    const files = fs.readdirSync(destDir);
                    files.forEach(file => {
                        const filePath = path.join(destDir, file);
                        const stats = fs.statSync(filePath);
                        if (stats.isFile() && !file.endsWith('.node')) {
                            // Make binary files executable
                            fs.chmodSync(filePath, 0o755);
                        }
                    });
                }
                resolve();
            })
            .on('error', reject);
    });
}

/**
 * Main unpacking function
 */
async function unpackTools() {
    try {
        const platformDir = getPlatformDir();
        const toolsDir = getToolsDir();
        const archivesDir = path.join(toolsDir, 'archives');
        const unpackedPath = path.join(toolsDir, 'unpacked');
        
        // Check if already unpacked
        if (areToolsUnpacked(toolsDir)) {
            console.log(`Tools already unpacked for ${platformDir}`);
            return { success: true, alreadyUnpacked: true };
        }
        
        console.log(`Unpacking tools for ${platformDir}...`);
        
        // Create unpacked directory
        if (!fs.existsSync(unpackedPath)) {
            fs.mkdirSync(unpackedPath, { recursive: true });
        }
        
        // Unpack difftastic
        const difftasticArchive = path.join(archivesDir, `difftastic-${platformDir}.tar.gz`);
        if (!fs.existsSync(difftasticArchive)) {
            throw new Error(`Archive not found: ${difftasticArchive}`);
        }
        await unpackArchive(difftasticArchive, unpackedPath);
        
        // Unpack ripgrep
        const ripgrepArchive = path.join(archivesDir, `ripgrep-${platformDir}.tar.gz`);
        if (!fs.existsSync(ripgrepArchive)) {
            throw new Error(`Archive not found: ${ripgrepArchive}`);
        }
        await unpackArchive(ripgrepArchive, unpackedPath);
        
        console.log(`Tools unpacked successfully to ${unpackedPath}`);
        return { success: true, alreadyUnpacked: false };
        
    } catch (error) {
        console.error('Failed to unpack tools:', error.message);
        throw error;
    }
}

// Export for use as module
module.exports = { unpackTools, getPlatformDir, getToolsDir };

// Run if executed directly
if (require.main === module) {
    unpackTools()
        .then(result => {
            process.exit(0);
        })
        .catch(error => {
            console.error('Error:', error);
            process.exit(1);
        });
}