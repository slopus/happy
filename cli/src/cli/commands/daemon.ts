import chalk from 'chalk';

import { checkIfDaemonRunningAndCleanupStaleState, listDaemonSessions, stopDaemon, stopDaemonSession } from '@/daemon/controlClient';
import { install } from '@/daemon/install';
import { startDaemon } from '@/daemon/run';
import { uninstall } from '@/daemon/uninstall';
import { getLatestDaemonLog } from '@/ui/logger';
import { runDoctorCommand } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleDaemonCliCommand(context: CommandContext): Promise<void> {
  const args = context.args;
  const daemonSubcommand = args[1];

  if (daemonSubcommand === 'list') {
    try {
      const sessions = await listDaemonSessions();

      if (sessions.length === 0) {
        console.log(
          'No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)',
        );
      } else {
        console.log('Active sessions:');
        console.log(JSON.stringify(sessions, null, 2));
      }
    } catch {
      console.log('No daemon running');
    }
    return;
  }

  if (daemonSubcommand === 'stop-session') {
    const sessionId = args[2];
    if (!sessionId) {
      console.error('Session ID required');
      process.exit(1);
    }

    try {
      const success = await stopDaemonSession(sessionId);
      console.log(success ? 'Session stopped' : 'Failed to stop session');
    } catch {
      console.log('No daemon running');
    }
    return;
  }

  if (daemonSubcommand === 'start') {
    const child = spawnHappyCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();

    let started = false;
    for (let i = 0; i < 50; i++) {
      if (await checkIfDaemonRunningAndCleanupStaleState()) {
        started = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (started) {
      console.log('Daemon started successfully');
    } else {
      console.error('Failed to start daemon');
      process.exit(1);
    }
    process.exit(0);
  }

  if (daemonSubcommand === 'start-sync') {
    await startDaemon();
    process.exit(0);
  }

  if (daemonSubcommand === 'stop') {
    await stopDaemon();
    process.exit(0);
  }

  if (daemonSubcommand === 'status') {
    await runDoctorCommand('daemon');
    process.exit(0);
  }

  if (daemonSubcommand === 'logs') {
    const latest = await getLatestDaemonLog();
    if (!latest) {
      console.log('No daemon logs found');
    } else {
      console.log(latest.path);
    }
    process.exit(0);
  }

  if (daemonSubcommand === 'install') {
    try {
      await install();
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
    return;
  }

  if (daemonSubcommand === 'uninstall') {
    try {
      await uninstall();
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
    return;
  }

  console.log(`
${chalk.bold('happy daemon')} - Daemon management

${chalk.bold('Usage:')}
  happy daemon start              Start the daemon (detached)
  happy daemon stop               Stop the daemon (sessions stay alive)
  happy daemon status             Show daemon status
  happy daemon list               List active sessions

  If you want to kill all happy related processes run 
  ${chalk.cyan('happy doctor clean')}

${chalk.bold('Note:')} The daemon runs in the background and manages Claude sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('happy doctor clean')}
`);
}

