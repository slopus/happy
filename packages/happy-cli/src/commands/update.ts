import chalk from 'chalk';
import { execSync, execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import packageJson from '../../package.json';
import { stopDaemon, checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

const PACKAGE_NAME = 'happy-next-cli';

type PackageManager = 'npm' | 'pnpm' | 'yarn';

function detectPackageManager(): PackageManager {
    try {
        const whichOutput = execSync('which happy', { encoding: 'utf-8' }).trim();
        const realPath = realpathSync(whichOutput);

        if (realPath.includes('/pnpm/') || realPath.includes('/pnpm-global/')) {
            return 'pnpm';
        }
        if (realPath.includes('/.yarn/') || realPath.includes('/yarn/')) {
            return 'yarn';
        }
    } catch {
        // Fall through to default
    }
    return 'npm';
}

function getUpgradeCommand(pm: PackageManager): string[] {
    switch (pm) {
        case 'pnpm':
            return ['pnpm', 'add', '-g', `${PACKAGE_NAME}@latest`];
        case 'yarn':
            return ['yarn', 'global', 'add', `${PACKAGE_NAME}@latest`];
        case 'npm':
            return ['npm', 'install', '-g', `${PACKAGE_NAME}@latest`];
    }
}

function getLatestVersion(): string | null {
    try {
        return execFileSync('npm', ['view', PACKAGE_NAME, 'version'], { encoding: 'utf-8' }).trim();
    } catch {
        return null;
    }
}

export async function handleUpdateCommand(): Promise<void> {
    const currentVersion = packageJson.version;

    // Query latest version
    console.log(chalk.gray('Checking for updates...'));
    const latestVersion = getLatestVersion();

    if (!latestVersion) {
        console.error(chalk.red('Failed to check latest version. Please check your network connection.'));
        process.exit(1);
    }

    console.log(`Current version: ${chalk.cyan(currentVersion)}`);
    console.log(`Latest version:  ${chalk.cyan(latestVersion)}`);
    console.log('');

    if (currentVersion === latestVersion) {
        console.log(chalk.green('✓ Already up to date'));
        process.exit(0);
    }

    // Detect package manager and upgrade
    const pm = detectPackageManager();
    const command = getUpgradeCommand(pm);
    console.log(`Upgrading via ${chalk.bold(pm)}...`);

    try {
        execFileSync(command[0], command.slice(1), { stdio: 'inherit' });
    } catch {
        console.error(chalk.red(`\n✗ Upgrade failed. You can try manually:`));
        console.error(chalk.gray(`  ${command.join(' ')}`));
        process.exit(1);
    }

    console.log(chalk.green(`\n✓ Upgraded to ${latestVersion}`));

    // Restart daemon if running
    try {
        const daemonRunning = await checkIfDaemonRunningAndCleanupStaleState();
        if (daemonRunning) {
            console.log('Restarting daemon...');
            await stopDaemon();

            const child = spawnHappyCLI(['daemon', 'start-sync'], {
                detached: true,
                stdio: 'ignore',
                env: process.env,
            });
            child.unref();

            // Wait for daemon to come up
            let started = false;
            for (let i = 0; i < 50; i++) {
                if (await checkIfDaemonRunningAndCleanupStaleState()) {
                    started = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            if (started) {
                console.log(chalk.green('✓ Daemon restarted'));
            } else {
                console.log(chalk.yellow('⚠ Daemon restart timed out. Run "happy daemon start" manually.'));
            }
        }
    } catch {
        // Daemon wasn't running or restart failed - not critical
    }

    process.exit(0);
}
