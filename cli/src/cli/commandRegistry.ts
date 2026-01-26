import type { TerminalRuntimeFlags } from '@/terminal/terminalRuntimeFlags';

import { handleAttachCliCommand } from './commands/attach';
import { handleAuthCliCommand } from './commands/auth';
import { handleCodexCliCommand } from './commands/codex';
import { handleConnectCliCommand } from './commands/connect';
import { handleDaemonCliCommand } from './commands/daemon';
import { handleDoctorCliCommand } from './commands/doctor';
import { handleGeminiCliCommand } from './commands/gemini';
import { handleLogoutCliCommand } from './commands/logout';
import { handleNotifyCliCommand } from './commands/notify';
import { handleOpenCodeCliCommand } from './commands/opencode';

export type CommandContext = Readonly<{
  args: string[];
  rawArgv: string[];
  terminalRuntime: TerminalRuntimeFlags | null;
}>;

export type CommandHandler = (context: CommandContext) => Promise<void>;

export const commandRegistry: Readonly<Record<string, CommandHandler>> = {
  attach: handleAttachCliCommand,
  auth: handleAuthCliCommand,
  codex: handleCodexCliCommand,
  connect: handleConnectCliCommand,
  daemon: handleDaemonCliCommand,
  doctor: handleDoctorCliCommand,
  gemini: handleGeminiCliCommand,
  logout: handleLogoutCliCommand,
  notify: handleNotifyCliCommand,
  opencode: handleOpenCodeCliCommand,
};

