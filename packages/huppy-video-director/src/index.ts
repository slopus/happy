import { Command } from 'commander'
import { pathToFileURL } from 'node:url'

export function buildProgram(): Command {
  const program = new Command()

  program
    .name('huppy-video-director')
    .description('Direct a video run from a brief and optional asset folder.')
    .version('0.0.0')

  program
    .command('run')
    .description('Run a video task from a brief and optional asset folder.')
    .requiredOption('--brief <brief>', 'short description of the video to make')
    .requiredOption('--profile <profile>', 'profile to use for the run')
    .option('--assets <folder>', 'folder containing optional assets')
    .option('--style <style>', 'style guide or direction to follow')
    .action(async (options) => {
      console.log(JSON.stringify(options, null, 2))
    })

  return program
}

const entrypoint = process.argv[1]

if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void buildProgram().parseAsync(process.argv)
}
