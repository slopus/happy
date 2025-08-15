/**
 * Doctor command implementation
 * 
 * Provides comprehensive diagnostics and troubleshooting information
 * for happy CLI including configuration, daemon status, logs, and links
 */

import chalk from 'chalk'
import { configuration } from '@/configuration'
import { readSettings, readCredentials } from '@/persistence/persistence'
import { isDaemonRunning, getDaemonMetadata } from '@/daemon/run'
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
        happyDir: configuration?.happyDir,
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
    console.log(`Happy Home: ${chalk.blue(configuration.happyDir)}`);
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
        const metadata = await getDaemonMetadata();
        
        if (isRunning && metadata) {
            console.log(chalk.green('✓ Daemon is running'));
            console.log(`  PID: ${metadata.pid}`);
            console.log(`  Started: ${new Date(metadata.startTime).toLocaleString()}`);
            console.log(`  Version: ${metadata.version}`);
            if (metadata.childPids && metadata.childPids.length > 0) {
                console.log(`  Child Processes: ${metadata.childPids.length}`);
            }
        } else if (metadata && !isRunning) {
            console.log(chalk.yellow('⚠️  Daemon metadata exists but process not running (stale)'));
        } else {
            console.log(chalk.red('❌ Daemon is not running'));
        }
        
        // Show daemon metadata file
        if (metadata) {
            console.log(chalk.bold('\n📄 Daemon Metadata:'));
            console.log(chalk.blue(`Location: ${configuration.daemonMetadataFile}`));
            console.log(chalk.gray(JSON.stringify(metadata, null, 2)));
        }

        // Runaway daemons
        const runaway: any[] = []; // await findPotentialRunawayDaemons();
        if (runaway.length > 0) {
            console.log(chalk.bold('\n🚨 Potential runaway daemons detected'));
            console.log(chalk.gray('This can happen if a previous daemon cleanup failed.'));
            console.log(`PIDs: ${chalk.yellow(runaway.join(', '))}`);
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