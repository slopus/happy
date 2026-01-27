/**
 * GeminiTerminalDisplay
 *
 * Read-only terminal UI for Gemini sessions started by Happy.
 * This UI intentionally does not accept prompts from stdin; it displays logs and exit controls only.
 */

import React, { useEffect, useState } from 'react';

import { AgentLogShell } from '@/ui/ink/AgentLogShell';
import { MessageBuffer, type BufferedMessage } from '@/ui/ink/messageBuffer';
import { buildReadOnlyFooterLines } from '@/ui/ink/readOnlyFooterLines';

export type GeminiTerminalDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  currentModel?: string;
  onExit?: () => void | Promise<void>;
};

export const GeminiTerminalDisplay: React.FC<GeminiTerminalDisplayProps> = ({
  messageBuffer,
  logPath,
  currentModel,
  onExit,
}) => {
  const [model, setModel] = useState<string | undefined>(currentModel);

  useEffect(() => {
    if (currentModel !== undefined && currentModel !== model) {
      setModel(currentModel);
    }
  }, [currentModel]);

  useEffect(() => {
    const unsubscribe = messageBuffer.onUpdate((newMessages) => {
      const modelMessage = [...newMessages].reverse().find((msg) => msg.type === 'system' && msg.content.startsWith('[MODEL:'));
      if (!modelMessage) return;

      const modelMatch = modelMessage.content.match(/\[MODEL:(.+?)\]/);
      if (modelMatch && modelMatch[1]) {
        const extractedModel = modelMatch[1];
        setModel((prevModel) => (extractedModel !== prevModel ? extractedModel : prevModel));
      }
    });

    return () => unsubscribe();
  }, [messageBuffer]);

  const filterMessage = (msg: BufferedMessage): boolean => {
    if (msg.type === 'system' && !msg.content.trim()) return false;
    if (msg.type === 'system' && msg.content.startsWith('[MODEL:')) return false;
    if (msg.type === 'system' && msg.content.startsWith('Using model:')) return false;
    return true;
  };

  const footerLines: string[] = [...buildReadOnlyFooterLines('Gemini')];
  if (model) {
    footerLines.push(`Model: ${model}`);
  }

  return (
    <AgentLogShell
      messageBuffer={messageBuffer}
      title="✨ Gemini"
      accentColor="cyan"
      logPath={logPath}
      filterMessage={filterMessage}
      footerLines={footerLines}
      onExit={onExit}
    />
  );
};
