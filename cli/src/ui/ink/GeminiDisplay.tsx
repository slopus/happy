/**
 * GeminiDisplay - Ink UI component for Gemini agent
 * 
 * This component provides a terminal UI for the Gemini agent,
 * displaying messages, status, and handling user input.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useStdout, useInput } from 'ink';
import { MessageBuffer, type BufferedMessage } from './messageBuffer';

interface GeminiDisplayProps {
  messageBuffer: MessageBuffer;
  logPath?: string;
  currentModel?: string;
  onExit?: () => void;
}

export const GeminiDisplay: React.FC<GeminiDisplayProps> = ({ messageBuffer, logPath, currentModel, onExit }) => {
  const [messages, setMessages] = useState<BufferedMessage[]>([]);
  const [confirmationMode, setConfirmationMode] = useState<boolean>(false);
  const [actionInProgress, setActionInProgress] = useState<boolean>(false);
  const [model, setModel] = useState<string | undefined>(currentModel);
  const confirmationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { stdout } = useStdout();
  const terminalWidth = stdout.columns || 80;
  const terminalHeight = stdout.rows || 24;

  // Update model when prop changes (only if different to avoid loops)
  useEffect(() => {
    if (currentModel !== undefined && currentModel !== model) {
      setModel(currentModel);
    }
  }, [currentModel]); // Only depend on currentModel, not model, to avoid loops

  useEffect(() => {
    setMessages(messageBuffer.getMessages());

    const unsubscribe = messageBuffer.onUpdate((newMessages) => {
      setMessages(newMessages);
      
      // Extract model from [MODEL:...] messages when messages update
      // Use reverse + find to get the LATEST model message (in case model was changed)
      const modelMessage = [...newMessages].reverse().find(msg => 
        msg.type === 'system' && msg.content.startsWith('[MODEL:')
      );
      
      if (modelMessage) {
        const modelMatch = modelMessage.content.match(/\[MODEL:(.+?)\]/);
        if (modelMatch && modelMatch[1]) {
          const extractedModel = modelMatch[1];
          setModel(prevModel => {
            // Only update if different to avoid unnecessary re-renders
            if (extractedModel !== prevModel) {
              return extractedModel;
            }
            return prevModel;
          });
        }
      }
    });

    return () => {
      unsubscribe();
      if (confirmationTimeoutRef.current) {
        clearTimeout(confirmationTimeoutRef.current);
      }
    };
  }, [messageBuffer]);

  const resetConfirmation = useCallback(() => {
    setConfirmationMode(false);
    if (confirmationTimeoutRef.current) {
      clearTimeout(confirmationTimeoutRef.current);
      confirmationTimeoutRef.current = null;
    }
  }, []);

  const setConfirmationWithTimeout = useCallback(() => {
    setConfirmationMode(true);
    if (confirmationTimeoutRef.current) {
      clearTimeout(confirmationTimeoutRef.current);
    }
    confirmationTimeoutRef.current = setTimeout(() => {
      resetConfirmation();
    }, 15000); // 15 seconds timeout
  }, [resetConfirmation]);

  useInput(useCallback(async (input, key) => {
    if (actionInProgress) return;

    // Handle Ctrl-C
    if (key.ctrl && input === 'c') {
      if (confirmationMode) {
        // Second Ctrl-C, exit
        resetConfirmation();
        setActionInProgress(true);
        await new Promise(resolve => setTimeout(resolve, 100));
        onExit?.();
      } else {
        // First Ctrl-C, show confirmation
        setConfirmationWithTimeout();
      }
      return;
    }

    // Any other key cancels confirmation
    if (confirmationMode) {
      resetConfirmation();
    }
  }, [confirmationMode, actionInProgress, onExit, setConfirmationWithTimeout, resetConfirmation]));

  const getMessageColor = (type: BufferedMessage['type']): string => {
    switch (type) {
      case 'user': return 'magenta';
      case 'assistant': return 'cyan';
      case 'system': return 'blue';
      case 'tool': return 'yellow';
      case 'result': return 'green';
      case 'status': return 'gray';
      default: return 'white';
    }
  };

  const formatMessage = (msg: BufferedMessage): string => {
    const lines = msg.content.split('\n');
    const maxLineLength = terminalWidth - 10;
    return lines.map(line => {
      if (line.length <= maxLineLength) return line;
      const chunks: string[] = [];
      for (let i = 0; i < line.length; i += maxLineLength) {
        chunks.push(line.slice(i, i + maxLineLength));
      }
      return chunks.join('\n');
    }).join('\n');
  };

  return (
    <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
      {/* Main content area with logs */}
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
          <Text color="cyan" bold>✨ Gemini Agent Messages</Text>
          <Text color="gray" dimColor>{'─'.repeat(Math.min(terminalWidth - 4, 60))}</Text>
        </Box>

        <Box flexDirection="column" height={terminalHeight - 10} overflow="hidden">
          {messages.length === 0 ? (
            <Text color="gray" dimColor>Waiting for messages...</Text>
          ) : (
            messages
              .filter(msg => {
                // Filter out empty system messages (used for triggering re-renders)
                if (msg.type === 'system' && !msg.content.trim()) {
                  return false;
                }
                // Filter out model update messages (model extraction happens in useEffect)
                if (msg.type === 'system' && msg.content.startsWith('[MODEL:')) {
                  return false; // Don't show in UI
                }
                // Filter out status messages that are redundant (shown in status bar)
                // But keep Thinking messages - they show agent's reasoning process (like Codex)
                if (msg.type === 'system' && msg.content.startsWith('Using model:')) {
                  return false; // Don't show in UI - redundant with status bar
                }
                // Keep "Thinking..." and "[Thinking] ..." messages - they show agent's reasoning (like Codex)
                return true;
              })
              .slice(-Math.max(1, terminalHeight - 10))
              .map((msg, index, array) => (
                <Box key={msg.id} flexDirection="column" marginBottom={index < array.length - 1 ? 1 : 0}>
                  <Text color={getMessageColor(msg.type)} dimColor>
                    {formatMessage(msg)}
                  </Text>
                </Box>
              ))
          )}
        </Box>
      </Box>

      {/* Status bar at the bottom */}
      <Box
        width={terminalWidth}
        borderStyle="round"
        borderColor={
          actionInProgress ? 'gray' :
          confirmationMode ? 'red' :
          'cyan'
        }
        paddingX={2}
        justifyContent="center"
        alignItems="center"
        flexDirection="column"
      >
        <Box flexDirection="column" alignItems="center">
          {actionInProgress ? (
            <Text color="gray" bold>
              Exiting agent...
            </Text>
          ) : confirmationMode ? (
            <Text color="red" bold>
              ⚠️  Press Ctrl-C again to exit the agent
            </Text>
          ) : (
            <>
              <Text color="cyan" bold>
                ✨ Gemini Agent Running • Ctrl-C to exit
              </Text>
              {model && (
                <Text color="gray" dimColor>
                  Model: {model}
                </Text>
              )}
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

