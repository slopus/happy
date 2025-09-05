import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Text, useStdout, useInput } from 'ink'
import { MessageBuffer, type BufferedMessage } from './messageBuffer'

interface CodexDisplayProps {
    messageBuffer: MessageBuffer
    logPath?: string
    onExit?: () => void
}

export const CodexDisplay: React.FC<CodexDisplayProps> = ({ messageBuffer, logPath, onExit }) => {
    const [messages, setMessages] = useState<BufferedMessage[]>([])
    const [confirmationMode, setConfirmationMode] = useState<boolean>(false)
    const [actionInProgress, setActionInProgress] = useState<boolean>(false)
    const confirmationTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const { stdout } = useStdout()
    const terminalWidth = stdout.columns || 80
    const terminalHeight = stdout.rows || 24

    useEffect(() => {
        setMessages(messageBuffer.getMessages())
        
        const unsubscribe = messageBuffer.onUpdate((newMessages) => {
            setMessages(newMessages)
        })

        return () => {
            unsubscribe()
            if (confirmationTimeoutRef.current) {
                clearTimeout(confirmationTimeoutRef.current)
            }
        }
    }, [messageBuffer])

    const resetConfirmation = useCallback(() => {
        setConfirmationMode(false)
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current)
            confirmationTimeoutRef.current = null
        }
    }, [])

    const setConfirmationWithTimeout = useCallback(() => {
        setConfirmationMode(true)
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current)
        }
        confirmationTimeoutRef.current = setTimeout(() => {
            resetConfirmation()
        }, 15000) // 15 seconds timeout
    }, [resetConfirmation])

    useInput(useCallback(async (input, key) => {
        // Don't process input if action is in progress
        if (actionInProgress) return
        
        // Handle Ctrl-C - exits the agent directly instead of switching modes
        if (key.ctrl && input === 'c') {
            if (confirmationMode) {
                // Second Ctrl-C, exit
                resetConfirmation()
                setActionInProgress(true)
                // Small delay to show the status message
                await new Promise(resolve => setTimeout(resolve, 100))
                onExit?.()
            } else {
                // First Ctrl-C, show confirmation
                setConfirmationWithTimeout()
            }
            return
        }

        // Any other key cancels confirmation
        if (confirmationMode) {
            resetConfirmation()
        }
    }, [confirmationMode, actionInProgress, onExit, setConfirmationWithTimeout, resetConfirmation]))

    const getMessageColor = (type: BufferedMessage['type']): string => {
        switch (type) {
            case 'user': return 'magenta'
            case 'assistant': return 'cyan'
            case 'system': return 'blue'
            case 'tool': return 'yellow'
            case 'result': return 'green'
            case 'status': return 'gray'
            default: return 'white'
        }
    }

    const formatMessage = (msg: BufferedMessage): string => {
        const lines = msg.content.split('\n')
        const maxLineLength = terminalWidth - 10 // Account for borders and padding
        return lines.map(line => {
            if (line.length <= maxLineLength) return line
            const chunks: string[] = []
            for (let i = 0; i < line.length; i += maxLineLength) {
                chunks.push(line.slice(i, i + maxLineLength))
            }
            return chunks.join('\n')
        }).join('\n')
    }

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
                    <Text color="gray" bold>🤖 Codex Agent Messages</Text>
                    <Text color="gray" dimColor>{'─'.repeat(Math.min(terminalWidth - 4, 60))}</Text>
                </Box>
                
                <Box flexDirection="column" height={terminalHeight - 10} overflow="hidden">
                    {messages.length === 0 ? (
                        <Text color="gray" dimColor>Waiting for messages...</Text>
                    ) : (
                        // Show only the last messages that fit in the available space
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

            {/* Modal overlay at the bottom */}
            <Box 
                width={terminalWidth}
                borderStyle="round"
                borderColor={
                    actionInProgress ? "gray" :
                    confirmationMode ? "red" : 
                    "green"
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
                            <Text color="green" bold>
                                🤖 Codex Agent Running • Ctrl-C to exit
                            </Text>
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
    )
}