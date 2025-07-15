import { Command } from 'commander';

export const uploadCommand = new Command('upload')
  .description('Upload a file')
  .argument('<filepath>', 'Path to the file to upload')
  .action((filepath: string) => {
    console.log(filepath);
  });