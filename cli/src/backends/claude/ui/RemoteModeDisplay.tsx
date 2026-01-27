/**
 * RemoteModeDisplay
 *
 * Claude-specific terminal UI for “remote mode” sessions.
 * Unlike Codex/Gemini/OpenCode read-only shells, this display supports switching back to local mode.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import { MessageBuffer, type BufferedMessage } from '@/ui/ink/messageBuffer';

export type RemoteModeConfirmation = 'exit' | 'switch' | null;
export type RemoteModeActionInProgress = 'exiting' | 'switching' | null;

export type RemoteModeKeypressAction =
  | 'none'
  | 'reset'
  | 'confirm-exit'
  | 'confirm-switch'
  | 'exit'
  | 'switch';

export function interpretRemoteModeKeypress(
  state: { confirmationMode: RemoteModeConfirmation; actionInProgress: RemoteModeActionInProgress },
  input: string,
  key: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {},
): { action: RemoteModeKeypressAction } {
  if (state.actionInProgress) return { action: 'none' };

  if (key.ctrl && input === 'c') {
    return { action: state.confirmationMode === 'exit' ? 'exit' : 'confirm-exit' };
  }

  // Ctrl-T: immediate switch to terminal (avoids “space spam” → buffered spaces)
  if (key.ctrl && input === 't') {
    return { action: 'switch' };
  }

  // Double-space confirmation for switching
  if (input === ' ') {
    return { action: state.confirmationMode === 'switch' ? 'switch' : 'confirm-switch' };
  }

  if (state.confirmationMode) {
    return { action: 'reset' };
  }

  return { action: 'none' };
}

export type RemoteModeDisplayProps = {
  messageBuffer: MessageBuffer;
  logPath?: string;
  onExit?: () => void;
  onSwitchToLocal?: () => void;
};

export const RemoteModeDisplay: React.FC<RemoteModeDisplayProps> = ({ messageBuffer, logPath, onExit, onSwitchToLocal }) => {
  const [messages, setMessages] = useState<BufferedMessage[]>([]);
  const [confirmationMode, setConfirmationMode] = useState<RemoteModeConfirmation>(null);
  const [actionInProgress, setActionInProgress] = useState<RemoteModeActionInProgress>(null);
  const confirmationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const actionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
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
      if (confirmationTimeoutRef.current) {
        clearTimeout(confirmationTimeoutRef.current);
      }
      if (actionTimeoutRef.current) {
        clearTimeout(actionTimeoutRef.current);
      }
    };
  }, [messageBuffer]);

  const resetConfirmation = useCallback(() => {
    setConfirmationMode(null);
    if (confirmationTimeoutRef.current) {
      clearTimeout(confirmationTimeoutRef.current);
      confirmationTimeoutRef.current = null;
    }
  }, []);

  const setConfirmationWithTimeout = useCallback(
    (mode: Exclude<RemoteModeConfirmation, null>) => {
      setConfirmationMode(mode);
      if (confirmationTimeoutRef.current) {
        clearTimeout(confirmationTimeoutRef.current);
      }
      confirmationTimeoutRef.current = setTimeout(() => resetConfirmation(), 15000);
    },
    [resetConfirmation],
  );

  useInput(
    useCallback(
      (input, key) => {
        const { action } = interpretRemoteModeKeypress({ confirmationMode, actionInProgress }, input, key as any);
        if (action === 'none') return;
        if (action === 'reset') {
          resetConfirmation();
          return;
        }
        if (action === 'confirm-exit') {
          setConfirmationWithTimeout('exit');
          return;
        }
        if (action === 'confirm-switch') {
          setConfirmationWithTimeout('switch');
          return;
        }
        if (action === 'exit') {
          resetConfirmation();
          setActionInProgress('exiting');
          if (actionTimeoutRef.current) {
            clearTimeout(actionTimeoutRef.current);
          }
          actionTimeoutRef.current = setTimeout(() => onExit?.(), 100);
          return;
        }
        if (action === 'switch') {
          resetConfirmation();
          setActionInProgress('switching');
          if (actionTimeoutRef.current) {
            clearTimeout(actionTimeoutRef.current);
          }
          actionTimeoutRef.current = setTimeout(() => onSwitchToLocal?.(), 100);
        }
      },
      [confirmationMode, actionInProgress, onExit, onSwitchToLocal, setConfirmationWithTimeout, resetConfirmation],
    ),
  );

  const getMessageColor = (type: BufferedMessage['type']): string => {
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
  };

  const formatMessage = (msg: BufferedMessage): string => {
    const lines = msg.content.split('\n');
    const maxLineLength = terminalWidth - 10;
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
  };

  return (
    <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
      <Box
        flexDirection="column"
        width={terminalWidth}
        height={terminalHeight - 4}
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        overflow="hidden"
      >
        <Box flexDirection="column" marginBottom={1}>
          <Text color="gray" bold>
            📡 Remote Mode - Claude Messages
          </Text>
          <Text color="gray" dimColor>
            {'─'.repeat(Math.min(terminalWidth - 4, 60))}
          </Text>
        </Box>

        <Box flexDirection="column" height={terminalHeight - 10} overflow="hidden">
          {messages.length === 0 ? (
            <Text color="gray" dimColor>
              Waiting for messages...
            </Text>
          ) : (
            messages.slice(-Math.max(1, terminalHeight - 10)).map((msg) => (
              <Box key={msg.id} flexDirection="column" marginBottom={1}>
                <Text color={getMessageColor(msg.type)} dimColor>
                  {formatMessage(msg)}
                </Text>
              </Box>
            ))
          )}
        </Box>
      </Box>

      <Box
        width={terminalWidth}
        borderStyle="round"
        borderColor={
          actionInProgress ? 'gray' : confirmationMode === 'exit' ? 'red' : confirmationMode === 'switch' ? 'yellow' : 'green'
        }
        paddingX={2}
        justifyContent="center"
        alignItems="center"
        flexDirection="column"
      >
        <Box flexDirection="column" alignItems="center">
          {actionInProgress === 'exiting' ? (
            <Text color="gray" bold>
              Exiting...
            </Text>
          ) : actionInProgress === 'switching' ? (
            <Text color="gray" bold>
              Switching to local mode...
            </Text>
          ) : confirmationMode === 'exit' ? (
            <Text color="red" bold>
              ⚠️ Press Ctrl-C again to exit completely
            </Text>
          ) : confirmationMode === 'switch' ? (
            <Text color="yellow" bold>
              ⏸️ Press space again (or Ctrl-T) to switch to local mode
            </Text>
          ) : (
            <Text color="green" bold>
              📱 Press space (or Ctrl-T) to switch to local mode • Ctrl-C to exit
            </Text>
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

