/**
 * Doctor command implementation
 * 
 * Provides comprehensive diagnostics and troubleshooting information
 * for happy CLI including configuration, daemon status, logs, and links
 */

import chalk from 'chalk'
import { configuration } from '@/configuration'
import { readSettings, readCredentials } from '@/persistence/persistence'
import { isDaemonRunning, getDaemonState, findRunawayHappyProcesses, findAllHappyProcesses } from '@/daemon/utils'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import packageJson from '../../package.json'

/**
 * Get relevant environment information for debugging
 */
export function getEnvironmentInfo(): Record<string, any> {
    return {
        PWD: process.env.PWD,
        HAPPY_HOME_DIR: process.env.HAPPY_HOME_DIR,
        HAPPY_SERVER_URL: process.env.HAPPY_SERVER_URL,
        HAPPY_PROJECT_ROOT: process.env.HAPPY_PROJECT_ROOT,
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING,
        NODE_ENV: process.env.NODE_ENV,
        DEBUG: process.env.DEBUG,
        workingDirectory: process.cwd(),
        processArgv: process.argv,
        happyDir: configuration?.happyHomeDir,
        serverUrl: configuration?.serverUrl,
        logsDir: configuration?.logsDir
    };
}

function getLogFiles(logDir: string): { file: string, path: string, modified: Date }[] {
    if (!existsSync(logDir)) {
        return [];
    }

    try {
        return readdirSync(logDir)
            .filter(file => file.endsWith('.log'))
            .map(file => {
                const path = join(logDir, file);
                const stats = statSync(path);
                return { file, path, modified: stats.mtime };
            })
            .sort((a, b) => b.modified.getTime() - a.modified.getTime())
            .slice(0, 10); // Show most recent 10 files
    } catch {
        return [];
    }
}

export async function runDoctorCommand(): Promise<void> {
    console.log(chalk.bold.cyan('\n🩺 Happy CLI Doctor\n'));

    // Version and basic info
    console.log(chalk.bold('📋 Basic Information'));
    console.log(`Happy CLI Version: ${chalk.green(packageJson.version)}`);
    console.log(`Platform: ${chalk.green(process.platform)} ${process.arch}`);
    console.log(`Node.js Version: ${chalk.green(process.version)}`);
    console.log('');

    // Configuration
    console.log(chalk.bold('⚙️  Configuration'));
    console.log(`Happy Home: ${chalk.blue(configuration.happyHomeDir)}`);
    console.log(`Server URL: ${chalk.blue(configuration.serverUrl)}`);
    console.log(`Logs Dir: ${chalk.blue(configuration.logsDir)}`);

    // Environment
    console.log(chalk.bold('\n🌍 Environment Variables'));
    const env = getEnvironmentInfo();
    console.log(`HAPPY_HOME_DIR: ${env.HAPPY_HOME_DIR ? chalk.green(env.HAPPY_HOME_DIR) : chalk.gray('not set')}`);
    console.log(`HAPPY_SERVER_URL: ${env.HAPPY_SERVER_URL ? chalk.green(env.HAPPY_SERVER_URL) : chalk.gray('not set')}`);
    console.log(`DANGEROUSLY_LOG_TO_SERVER: ${env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING ? chalk.yellow('ENABLED') : chalk.gray('not set')}`);
    console.log(`DEBUG: ${env.DEBUG ? chalk.green(env.DEBUG) : chalk.gray('not set')}`);
    console.log(`NODE_ENV: ${env.NODE_ENV ? chalk.green(env.NODE_ENV) : chalk.gray('not set')}`);

    // Settings
    try {
        const settings = await readSettings();
        console.log(chalk.bold('\n📄 Settings (settings.json):'));
        console.log(chalk.gray(JSON.stringify(settings, null, 2)));
    } catch (error) {
        console.log(chalk.bold('\n📄 Settings:'));
        console.log(chalk.red('❌ Failed to read settings'));
    }

    // Authentication status
    console.log(chalk.bold('\n🔐 Authentication'));
    try {
        const credentials = await readCredentials();
        if (credentials) {
            console.log(chalk.green('✓ Authenticated (credentials found)'));
        } else {
            console.log(chalk.yellow('⚠️  Not authenticated (no credentials)'));
        }
    } catch (error) {
        console.log(chalk.red('❌ Error reading credentials'));
    }

    // Daemon status
    console.log(chalk.bold('\n🤖 Daemon Status'));
    try {
        const isRunning = await isDaemonRunning();
        const state = await getDaemonState();

        if (isRunning && state) {
            console.log(chalk.green('✓ Daemon is running'));
            console.log(`  PID: ${state.pid}`);
            console.log(`  Started: ${new Date(state.startTime).toLocaleString()}`);
            console.log(`  CLI Version: ${state.startedWithCliVersion}`);
            if (state.httpPort) {
                console.log(`  HTTP Port: ${state.httpPort}`);
            }
        } else if (state && !isRunning) {
            console.log(chalk.yellow('⚠️  Daemon state exists but process not running (stale)'));
        } else {
            console.log(chalk.red('❌ Daemon is not running'));
        }

        // Show daemon state file
        if (state) {
            console.log(chalk.bold('\n📄 Daemon State:'));
            console.log(chalk.blue(`Location: ${configuration.daemonStateFile}`));
            console.log(chalk.gray(JSON.stringify(state, null, 2)));
        }

        // All Happy processes
        const allProcesses = findAllHappyProcesses();
        if (allProcesses.length > 0) {
            console.log(chalk.bold('\n🔍 All Happy CLI Processes'));

            // Group by type
            const grouped = allProcesses.reduce((groups, process) => {
                if (!groups[process.type]) groups[process.type] = [];
                groups[process.type].push(process);
                return groups;
            }, {} as Record<string, typeof allProcesses>);

            // Display each group
            Object.entries(grouped).forEach(([type, processes]) => {
                const typeLabels: Record<string, string> = {
                    'current': '📍 Current Process',
                    'daemon': '🤖 Daemon',
                    'daemon-spawned-session': '🔗 Daemon-Spawned Sessions',
                    'user-session': '👤 User Sessions',
                    'dev-daemon': '🛠️  Dev Daemon',
                    'dev-session': '🛠️  Dev Sessions',
                    'dev-doctor': '🛠️  Dev Doctor',
                    'dev-related': '🛠️  Dev Related',
                    'doctor': '🩺 Doctor',
                    'unknown': '❓ Unknown'
                };

                console.log(chalk.blue(`\n${typeLabels[type] || type}:`));
                processes.forEach(({ pid, command }) => {
                    const color = type === 'current' ? chalk.green :
                        type.startsWith('dev') ? chalk.cyan :
                            type.includes('daemon') ? chalk.blue : chalk.gray;
                    console.log(`  ${color(`PID ${pid}`)}: ${chalk.gray(command)}`);
                });
            });
        }

        // Runaway processes
        const runawayProcesses = findRunawayHappyProcesses();
        if (runawayProcesses.length > 0) {
            console.log(chalk.bold('\n🚨 Runaway Happy processes detected'));
            console.log(chalk.gray('These processes were left running after daemon crashes.'));
            runawayProcesses.forEach(({ pid, command }) => {
                console.log(`  ${chalk.yellow(`PID ${pid}`)}: ${chalk.gray(command)}`);
            });
            console.log(chalk.blue('\nTo clean up: happy daemon kill-runaway'));
        }

        if (allProcesses.length > 1) { // More than just current process
            console.log(chalk.bold('\n💡 Process Management'));
            console.log(chalk.gray('To kill runaway processes: happy daemon kill-runaway'));
        }
    } catch (error) {
        console.log(chalk.red('❌ Error checking daemon status'));
    }

    // Log files
    console.log(chalk.bold('\n📝 Log Files'));

    // Main logs
    const mainLogs = getLogFiles(configuration.logsDir);
    if (mainLogs.length > 0) {
        console.log(chalk.blue('\nMain Logs:'));
        mainLogs.forEach(({ file, path, modified }) => {
            console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
            console.log(chalk.gray(`    ${path}`));
        });
    } else {
        console.log(chalk.yellow('No main log files found'));
    }

    // Daemon logs (filter main logs for daemon-specific ones)
    const daemonLogs = mainLogs.filter(({ file }) => file.includes('daemon'));
    if (daemonLogs.length > 0) {
        console.log(chalk.blue('\nDaemon Logs:'));
        daemonLogs.forEach(({ file, path, modified }) => {
            console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
            console.log(chalk.gray(`    ${path}`));
        });
    } else {
        console.log(chalk.yellow('No daemon log files found'));
    }

    // Support and bug reports
    console.log(chalk.bold('\n🐛 Support & Bug Reports'));
    console.log(`Report issues: ${chalk.blue('https://github.com/slopus/happy-cli/issues')}`);
    console.log(`Documentation: ${chalk.blue('https://happy.engineering/')}`);

    console.log(chalk.green('\n✅ Doctor diagnosis complete!\n'));
}