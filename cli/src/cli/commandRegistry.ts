import type { TerminalRuntimeFlags } from '@/terminal/terminalRuntimeFlags';

import { AGENTS, type AgentCatalogEntry } from '@/backends/catalog';

import { handleAttachCliCommand } from './commands/attach';
import { handleAuthCliCommand } from './commands/auth';
import { handleConnectCliCommand } from './commands/connect';
import { handleDaemonCliCommand } from './commands/daemon';
import { handleDoctorCliCommand } from './commands/doctor';
import { handleLogoutCliCommand } from './commands/logout';
import { handleNotifyCliCommand } from './commands/notify';

export type CommandContext = Readonly<{
  args: string[];
  rawArgv: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
}>;

export type CommandHandler = (context: CommandContext) => Promise<void>;

function buildAgentCommandRegistry(): Readonly<Record<string, CommandHandler>> {
  const registry: Record<string, CommandHandler> = {};

  for (const entry of Object.values(AGENTS) as AgentCatalogEntry[]) {
    if (!entry.getCliCommandHandler) continue;
    registry[entry.cliSubcommand] = async (context) => {
      const handler = await entry.getCliCommandHandler!();
      await handler(context);
    };
  }

  return registry;
}

export const commandRegistry: Readonly<Record<string, CommandHandler>> = {
  attach: handleAttachCliCommand,
  auth: handleAuthCliCommand,
  connect: handleConnectCliCommand,
  daemon: handleDaemonCliCommand,
  doctor: handleDoctorCliCommand,
  logout: handleLogoutCliCommand,
  notify: handleNotifyCliCommand,
  ...buildAgentCommandRegistry(),
};
