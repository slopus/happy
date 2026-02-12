#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig } from './config';
import { authLogin, authLogout, authStatus } from './auth';

const program = new Command();

program
    .name('happy-agent')
    .description('CLI client for controlling Happy Coder agents remotely')
    .version('0.1.0');

program
    .command('auth')
    .description('Manage authentication')
    .addCommand(
        new Command('login').description('Authenticate via QR code').action(async () => {
            const config = loadConfig();
            await authLogin(config);
        })
    )
    .addCommand(
        new Command('logout').description('Clear stored credentials').action(async () => {
            const config = loadConfig();
            await authLogout(config);
        })
    )
    .addCommand(
        new Command('status').description('Show authentication status').action(async () => {
            const config = loadConfig();
            await authStatus(config);
        })
    );

program
    .command('list')
    .description('List all sessions')
    .option('--active', 'Show only active sessions')
    .option('--json', 'Output as JSON')
    .action(async () => {
        console.log('List not yet implemented');
    });

program
    .command('status')
    .description('Get live session state')
    .argument('<session-id>', 'Session ID')
    .option('--json', 'Output as JSON')
    .action(async () => {
        console.log('Status not yet implemented');
    });

program
    .command('create')
    .description('Create a new session')
    .requiredOption('--tag <tag>', 'Session tag')
    .option('--path <path>', 'Working directory path')
    .option('--json', 'Output as JSON')
    .action(async () => {
        console.log('Create not yet implemented');
    });

program
    .command('send')
    .description('Send a message to a session')
    .argument('<session-id>', 'Session ID')
    .argument('<message>', 'Message text')
    .option('--wait', 'Wait for agent to become idle')
    .option('--json', 'Output as JSON')
    .action(async () => {
        console.log('Send not yet implemented');
    });

program
    .command('history')
    .description('Read message history')
    .argument('<session-id>', 'Session ID')
    .option('--limit <n>', 'Limit number of messages', parseInt)
    .option('--json', 'Output as JSON')
    .action(async () => {
        console.log('History not yet implemented');
    });

program
    .command('stop')
    .description('Stop a session')
    .argument('<session-id>', 'Session ID')
    .action(async () => {
        console.log('Stop not yet implemented');
    });

program
    .command('wait')
    .description('Wait for agent to become idle')
    .argument('<session-id>', 'Session ID')
    .option('--timeout <seconds>', 'Timeout in seconds', parseInt, 300)
    .action(async () => {
        console.log('Wait not yet implemented');
    });

program.parse(process.argv);
