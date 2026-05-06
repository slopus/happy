export type ParsedAcpCliArgs = {
  startedBy: 'daemon' | 'terminal' | undefined;
  verbose: boolean;
  acpArgs: string[];
};

export function parseAcpCliArgs(args: string[]): ParsedAcpCliArgs {
  let startedBy: 'daemon' | 'terminal' | undefined = undefined;
  let verbose = false;
  const acpArgs: string[] = [];
  let customCommandMode = false;

  for (let i = 0; i < args.length; i++) {
    if (!customCommandMode && args[i] === '--started-by') {
      startedBy = args[++i] as 'daemon' | 'terminal';
      continue;
    }
    if (!customCommandMode && args[i] === '--verbose') {
      verbose = true;
      continue;
    }
    if (!customCommandMode && args[i] === '--happy-starting-mode') {
      i++;
      continue;
    }
    if (args[i] === '--') {
      customCommandMode = true;
    }
    acpArgs.push(args[i]);
  }

  return { startedBy, verbose, acpArgs };
}

export function parseOpenCodeCliArgs(args: string[]): ParsedAcpCliArgs {
  const parsed = parseAcpCliArgs(args);
  return {
    ...parsed,
    acpArgs: ['opencode', ...parsed.acpArgs],
  };
}
