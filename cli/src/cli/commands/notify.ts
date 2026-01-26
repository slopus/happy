import chalk from 'chalk';

import { ApiClient } from '@/api/api';
import { readCredentials } from '@/persistence';

import type { CommandContext } from '@/cli/commandRegistry';

export async function handleNotifyCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleNotifyCommand(context.args.slice(1));
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}

async function handleNotifyCommand(args: string[]): Promise<void> {
  let message = '';
  let title = '';
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-p' && i + 1 < args.length) {
      message = args[++i];
    } else if (arg === '-t' && i + 1 < args.length) {
      title = args[++i];
    } else if (arg === '-h' || arg === '--help') {
      showHelp = true;
    } else {
      console.error(chalk.red(`Unknown argument for notify command: ${arg}`));
      process.exit(1);
    }
  }

  if (showHelp) {
    console.log(`
${chalk.bold('happy notify')} - Send notification

${chalk.bold('Usage:')}
  happy notify -p <message> [-t <title>]    Send notification with custom message and optional title
  happy notify -h, --help                   Show this help

${chalk.bold('Options:')}
  -p <message>    Notification message (required)
  -t <title>      Notification title (optional, defaults to "Happy")

${chalk.bold('Examples:')}
  happy notify -p "Deployment complete!"
  happy notify -p "System update complete" -t "Server Status"
  happy notify -t "Alert" -p "Database connection restored"
`);
    return;
  }

  if (!message) {
    console.error(
      chalk.red('Error: Message is required. Use -p "your message" to specify the notification text.'),
    );
    console.log(chalk.gray('Run "happy notify --help" for usage information.'));
    process.exit(1);
  }

  let credentials = await readCredentials();
  if (!credentials) {
    console.error(chalk.red('Error: Not authenticated. Please run "happy auth login" first.'));
    process.exit(1);
  }

  console.log(chalk.blue('📱 Sending push notification...'));

  try {
    const api = await ApiClient.create(credentials);

    const notificationTitle = title || 'Happy';

    api.push().sendToAllDevices(notificationTitle, message, {
      source: 'cli',
      timestamp: Date.now(),
    });

    console.log(chalk.green('✓ Push notification sent successfully!'));
    console.log(chalk.gray(`  Title: ${notificationTitle}`));
    console.log(chalk.gray(`  Message: ${message}`));
    console.log(chalk.gray('  Check your mobile device for the notification.'));

    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.error(chalk.red('✗ Failed to send push notification'));
    throw error;
  }
}

