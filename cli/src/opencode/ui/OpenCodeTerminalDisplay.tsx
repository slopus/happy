/**
 * OpenCodeTerminalDisplay
 *
 * Read-only terminal UI for OpenCode sessions started by Happy.
 * This UI intentionally does not accept prompts from stdin; it displays logs and exit controls only.
 */

import React from 'react';

import { AgentLogShell } from '@/ui/ink/AgentLogShell';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { buildReadOnlyFooterLines } from '@/ui/ink/readOnlyFooterLines';

export type OpenCodeTerminalDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void | Promise<void>;
};

export const OpenCodeTerminalDisplay: React.FC<OpenCodeTerminalDisplayProps> = ({ messageBuffer, logPath, onExit }) => {
  return (
    <AgentLogShell
      messageBuffer={messageBuffer}
      title="🤖 OpenCode"
      accentColor="green"
      logPath={logPath}
      footerLines={buildReadOnlyFooterLines('OpenCode')}
      onExit={onExit}
    />
  );
};
