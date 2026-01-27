/**
 * AuggieTerminalDisplay
 *
 * Read-only terminal UI for Auggie sessions started by Happy.
 * This UI intentionally does not accept prompts from stdin; it displays logs and exit controls only.
 */

import React from 'react';

import { AgentLogShell } from '@/ui/ink/AgentLogShell';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildReadOnlyFooterLines } from '@/ui/ink/readOnlyFooterLines';

export type AuggieTerminalDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void | Promise<void>;
};

export const AuggieTerminalDisplay: React.FC<AuggieTerminalDisplayProps> = ({ messageBuffer, logPath, onExit }) => {
  return (
    <AgentLogShell
      messageBuffer={messageBuffer}
      title="🤖 Auggie"
      accentColor="cyan"
      logPath={logPath}
      footerLines={buildReadOnlyFooterLines('Auggie')}
      onExit={onExit}
    />
  );
};

