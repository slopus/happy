#!/usr/bin/env node
import { Command } from 'commander';

import { initLoggerWithGlobalConfiguration } from 'slopus/lib';
import { initializeConfiguration } from 'slopus/lib';

import { recentCommand } from './commands/recent';
import { uploadCommand } from './commands/upload';
import { generateKeyCommand } from './commands/generate-key';
import { findCommand } from './commands/find';


initializeConfiguration('local');
initLoggerWithGlobalConfiguration();

const program = new Command();

program
  .name('devtools')
  .description('CLI tool with Enquirer prompts')
  .version('1.0.0');

program.addCommand(recentCommand);
program.addCommand(uploadCommand);
program.addCommand(generateKeyCommand);
program.addCommand(findCommand);

program.parse(process.argv);