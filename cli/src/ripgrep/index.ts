/**
 * Low-level ripgrep wrapper - just arguments in, string out
 */

import { spawn } from 'child_process';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Get project root - in dev use env var, in production check for scripts directory
function getProjectRoot() {
    if (process.env.HAPPY_PROJECT_ROOT) {
        return resolve(process.env.HAPPY_PROJECT_ROOT);
    }
    
    // Check if we're in a bundled build (dist/ with no scripts/)
    const distRoot = resolve(join(__dirname, '..', '..'));
    if (existsSync(join(distRoot, 'scripts'))) {
        // Production with scripts directory available
        return distRoot;
    }
    
    // Bundled build - scripts should be embedded or not needed
    return null;
}

// Get ripgrep launcher path from project root
const projectRoot = getProjectRoot();
if (!projectRoot) {
    throw new Error('Ripgrep launcher requires HAPPY_PROJECT_ROOT to be set or scripts directory to be available');
}
const RUNNER_PATH = resolve(join(projectRoot, 'scripts', 'ripgrep_launcher.cjs'));

export interface RipgrepResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface RipgrepOptions {
    cwd?: string
}

/**
 * Run ripgrep with the given arguments
 * @param args - Array of command line arguments to pass to ripgrep
 * @param options - Options for ripgrep execution
 * @returns Promise with exit code, stdout and stderr
 */
export function run(args: string[], options?: RipgrepOptions): Promise<RipgrepResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('node', [RUNNER_PATH, JSON.stringify(args)], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: options?.cwd
        });
        
        let stdout = '';
        let stderr = '';
        
        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        child.on('close', (code) => {
            resolve({
                exitCode: code || 0,
                stdout,
                stderr
            });
        });
        
        child.on('error', (err) => {
            reject(err);
        });
    });
}