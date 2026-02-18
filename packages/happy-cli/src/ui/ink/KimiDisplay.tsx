/**
 * KimiDisplay - Ink UI component for Kimi agent
 *
 * This component provides a terminal UI for the Kimi agent,
 * displaying messages, status, and handling user input.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useStdout, useInput } from 'ink';
import { MessageBuffer, type BufferedMessage } from './messageBuffer';

interface KimiDisplayProps {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void;
}

export const KimiDisplay: React.FC<KimiDisplayProps> = ({ messageBuffer, logPath, onExit }) => {
  const [messages, setMessages] = useState<BufferedMessage[]>([]);
  const [confirmationMode, setConfirmationMode] = useState<boolean>(false);
  const [actionInProgress, setActionInProgress] = useState<boolean>(false);
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns || 80;
  const terminalHeight = stdout.rows || 24;

  useEffect(() => {
    setMessages(messageBuffer.getMessages());

    const unsubscribe = messageBuffer.onUpdate((newMessages) => {
      setMessages(newMessages);
    });

    return () => {
      unsubscribe();
    };
  }, [messageBuffer]);

  const resetConfirmation = useCallback(() => {
    setConfirmationMode(false);
  }, []);

  useInput(useCallback(async (input, key) => {
    if (actionInProgress) return;

    // Handle Ctrl-C
    if (key.ctrl && input === 'c') {
      if (confirmationMode) {
        resetConfirmation();
        setActionInProgress(true);
        await new Promise(resolve => setTimeout(resolve, 100));
        onExit?.();
      } else {
        setConfirmationMode(true);
        setTimeout(() => {
          setConfirmationMode(false);
        }, 15000);
      }
      return;
    }

    // Any other key cancels confirmation mode
    if (confirmationMode) {
      resetConfirmation();
    }
  }, [confirmationMode, actionInProgress, onExit, resetConfirmation]));

  // Get visible messages (fit in terminal height)
  const maxVisibleMessages = Math.max(5, terminalHeight - 6);
  const visibleMessages = messages.slice(-maxVisibleMessages);

  return (
    <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
      {/* Header */}
      <Box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <Text bold color="cyan">Kimi</Text>
        <Text dimColor>Remote Mode</Text>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visibleMessages.map((msg, index) => (
          <Box key={index} flexDirection="row">
            {msg.type === 'user' && (
              <Text color="yellow">► {msg.content}</Text>
            )}
            {msg.type === 'assistant' && (
              <Text>{msg.content}</Text>
            )}
            {msg.type === 'system' && (
              <Text dimColor>{msg.content}</Text>
            )}
            {msg.type === 'status' && (
              <Text color="blue">{msg.content}</Text>
            )}
          </Box>
        ))}
      </Box>

      {/* Footer */}
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        {confirmationMode ? (
          <Text color="red" bold>Press Ctrl-C again to exit</Text>
        ) : (
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor>Ctrl-C: Exit | Space: Switch to local</Text>
            {logPath && <Text dimColor>Log: {logPath}</Text>}
          </Box>
        )}
      </Box>
    </Box>
  );
};
