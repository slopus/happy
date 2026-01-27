/**
 * AgentLogShell
 *
 * Reusable Ink “agent display” shell for read-only terminal sessions.
 * Renders a scrolling message log (from MessageBuffer) and a footer with exit controls.
 *
 * Provider-specific displays should live under their backend folders (e.g. src/backends/codex/ui)
 * and use this component as a thin wrapper.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import { MessageBuffer, type BufferedMessage } from './messageBuffer';

type ExitConfirmationState = {
  confirmationMode: boolean;
  actionInProgress: boolean;
};

function getMessageColor(type: BufferedMessage['type']): string {
  switch (type) {
    case 'user':
      return 'magenta';
    case 'assistant':
      return 'cyan';
    case 'system':
      return 'blue';
    case 'tool':
      return 'yellow';
    case 'result':
      return 'green';
    case 'status':
      return 'gray';
    default:
      return 'white';
  }
}

function wrapToWidth(text: string, maxLineLength: number): string {
  if (maxLineLength <= 0) return text;
  const lines = text.split('\n');
  return lines
    .map((line) => {
      if (line.length <= maxLineLength) return line;
      const chunks: string[] = [];
      for (let i = 0; i < line.length; i += maxLineLength) {
        chunks.push(line.slice(i, i + maxLineLength));
      }
      return chunks.join('\n');
    })
    .join('\n');
}

export type AgentLogShellProps = {
  messageBuffer: MessageBuffer;
  title: string;
  accentColor?: string;
  logPath?: string;
  footerLines?: string[];
  filterMessage?: (msg: BufferedMessage) => boolean;
  onExit?: () => void | Promise<void>;
};

export const AgentLogShell: React.FC<AgentLogShellProps> = ({
  messageBuffer,
  title,
  accentColor,
  logPath,
  footerLines,
  filterMessage,
  onExit,
}) => {
  const [messages, setMessages] = useState<BufferedMessage[]>([]);
  const [exitState, setExitState] = useState<ExitConfirmationState>({
    confirmationMode: false,
    actionInProgress: false,
  });

  const confirmationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns || 80;
  const terminalHeight = stdout.rows || 24;

  useEffect(() => {
    setMessages(messageBuffer.getMessages());
    const unsubscribe = messageBuffer.onUpdate((newMessages) => setMessages(newMessages));
    return () => {
      unsubscribe();
      if (confirmationTimeoutRef.current) {
        clearTimeout(confirmationTimeoutRef.current);
      }
    };
  }, [messageBuffer]);

  const resetExitConfirmation = useCallback(() => {
    setExitState((s) => ({ ...s, confirmationMode: false }));
    if (confirmationTimeoutRef.current) {
      clearTimeout(confirmationTimeoutRef.current);
      confirmationTimeoutRef.current = null;
    }
  }, []);

  const setExitConfirmationWithTimeout = useCallback(() => {
    setExitState((s) => ({ ...s, confirmationMode: true }));
    if (confirmationTimeoutRef.current) {
      clearTimeout(confirmationTimeoutRef.current);
    }
    confirmationTimeoutRef.current = setTimeout(() => resetExitConfirmation(), 15000);
  }, [resetExitConfirmation]);

  useInput(
    useCallback(
      async (input, key) => {
        if (exitState.actionInProgress) return;

        if (key.ctrl && input === 'c') {
          if (exitState.confirmationMode) {
            resetExitConfirmation();
            setExitState((s) => ({ ...s, actionInProgress: true }));
            await new Promise((resolve) => setTimeout(resolve, 100));
            await onExit?.();
          } else {
            setExitConfirmationWithTimeout();
          }
          return;
        }

        if (exitState.confirmationMode) {
          resetExitConfirmation();
        }
      },
      [exitState.actionInProgress, exitState.confirmationMode, onExit, resetExitConfirmation, setExitConfirmationWithTimeout],
    ),
  );

  const displayed = typeof filterMessage === 'function' ? messages.filter(filterMessage) : messages;
  const maxVisibleMessages = Math.max(1, terminalHeight - 10);
  const visible = displayed.slice(-maxVisibleMessages);

  const formattedTitle = title.trim().length > 0 ? title.trim() : 'Agent';
  const headerColor = accentColor ?? 'gray';

  const statusBorderColor = exitState.actionInProgress
    ? 'gray'
    : exitState.confirmationMode
      ? 'red'
      : (accentColor ?? 'green');

  const contentMaxLineLength = terminalWidth - 10;

  return (
    <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
      <Box
        flexDirection="column"
        width={terminalWidth}
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        overflow="hidden"
        flexGrow={1}
      >
        <Box flexDirection="column" marginBottom={1}>
          <Text color={headerColor} bold>
            {formattedTitle}
          </Text>
          <Text color="gray" dimColor>
            {'─'.repeat(Math.min(terminalWidth - 4, 60))}
          </Text>
        </Box>

        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {visible.length === 0 ? (
            <Text color="gray" dimColor>
              Waiting for messages...
            </Text>
          ) : (
            visible.map((msg) => (
              <Box key={msg.id} flexDirection="column" marginBottom={1}>
                <Text color={getMessageColor(msg.type)} dimColor>
                  {wrapToWidth(msg.content, contentMaxLineLength)}
                </Text>
              </Box>
            ))
          )}
        </Box>
      </Box>

      <Box
        width={terminalWidth}
        borderStyle="round"
        borderColor={statusBorderColor}
        paddingX={2}
        justifyContent="center"
        alignItems="center"
        flexDirection="column"
        minHeight={4}
      >
        <Box flexDirection="column" alignItems="center">
          {exitState.actionInProgress ? (
            <Text color="gray" bold>
              Exiting...
            </Text>
          ) : exitState.confirmationMode ? (
            <Text color="red" bold>
              ⚠️ Press Ctrl-C again to exit
            </Text>
          ) : (
            <>
              <Text color={accentColor ?? 'green'} bold>
                {formattedTitle} • Ctrl-C to exit
              </Text>
              {(footerLines ?? []).map((line, idx) => (
                <Text key={idx} color="gray" dimColor>
                  {line}
                </Text>
              ))}
            </>
          )}
          {process.env.DEBUG && logPath && (
            <Text color="gray" dimColor>
              Debug logs: {logPath}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
};
