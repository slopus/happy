#!/usr/bin/env node
import { Command } from 'commander';
import { recentCommand } from './commands/recent.js';
import { uploadCommand } from './commands/upload.js';

const program = new Command();

program
  .name('devtools')
  .description('CLI tool with Enquirer prompts')
  .version('1.0.0');

program.addCommand(recentCommand);
program.addCommand(uploadCommand);

program.parse(process.argv);