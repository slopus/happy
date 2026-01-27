/**
 * CodexTerminalDisplay
 *
 * Read-only terminal UI for Codex sessions started by Happy.
 * This UI intentionally does not accept prompts from stdin; it displays logs and exit controls only.
 */

import React from 'react';

import { AgentLogShell } from '@/ui/ink/AgentLogShell';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildReadOnlyFooterLines } from '@/ui/ink/readOnlyFooterLines';

export type CodexTerminalDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void | Promise<void>;
};

export const CodexTerminalDisplay: React.FC<CodexTerminalDisplayProps> = ({ messageBuffer, logPath, onExit }) => {
  return (
    <AgentLogShell
      messageBuffer={messageBuffer}
      title="🤖 Codex"
      accentColor="green"
      logPath={logPath}
      footerLines={buildReadOnlyFooterLines('Codex')}
      onExit={onExit}
    />
  );
};
