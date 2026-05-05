import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Box, Text, useStdout, useInput } from 'ink'
import { MessageBuffer, type BufferedMessage } from './messageBuffer'

interface CodexDisplayProps {
    messageBuffer: MessageBuffer
    logPath?: string
    onExit?: () => void
    onSwitchToLocal?: () => void
}

type CodexConfirmationMode = 'exit' | 'switch' | null
type CodexActionInProgress = 'exiting' | 'switching' | null

export async function handleCodexDisplayInput(opts: {
    input: string
    key: { ctrl?: boolean }
    confirmationMode: CodexConfirmationMode
    actionInProgress: CodexActionInProgress
    resetConfirmation: () => void
    setConfirmationWithTimeout: (mode: Exclude<CodexConfirmationMode, null>) => void
    setActionInProgress: (action: Exclude<CodexActionInProgress, null>) => void
    onExit?: () => void
    onSwitchToLocal?: () => void
    delayMs?: number
}) {
    const {
        input,
        key,
        confirmationMode,
        actionInProgress,
        resetConfirmation,
        setConfirmationWithTimeout,
        setActionInProgress,
        onExit,
        onSwitchToLocal,
        delayMs = 100,
    } = opts

    if (actionInProgress) return

    if (key.ctrl && input === 'c') {
        if (confirmationMode === 'exit') {
            resetConfirmation()
            setActionInProgress('exiting')
            await new Promise(resolve => setTimeout(resolve, delayMs))
            onExit?.()
        } else {
            setConfirmationWithTimeout('exit')
        }
        return
    }

    if (input === ' ') {
        if (confirmationMode === 'switch') {
            resetConfirmation()
            setActionInProgress('switching')
            await new Promise(resolve => setTimeout(resolve, delayMs))
            onSwitchToLocal?.()
        } else {
            setConfirmationWithTimeout('switch')
        }
        return
    }

    if (confirmationMode) {
        resetConfirmation()
    }
}

export const CodexDisplay: React.FC<CodexDisplayProps> = ({ messageBuffer, logPath, onExit, onSwitchToLocal }) => {
    const [messages, setMessages] = useState<BufferedMessage[]>([])
    const [confirmationMode, setConfirmationMode] = useState<CodexConfirmationMode>(null)
    const [actionInProgress, setActionInProgress] = useState<CodexActionInProgress>(null)
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
        setConfirmationMode(null)
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current)
            confirmationTimeoutRef.current = null
        }
    }, [])

    const setConfirmationWithTimeout = useCallback((mode: Exclude<CodexConfirmationMode, null>) => {
        setConfirmationMode(mode)
        if (confirmationTimeoutRef.current) {
            clearTimeout(confirmationTimeoutRef.current)
        }
        confirmationTimeoutRef.current = setTimeout(() => {
            resetConfirmation()
        }, 15000) // 15 seconds timeout
    }, [resetConfirmation])

    useInput(useCallback(async (input, key) => {
        await handleCodexDisplayInput({
            input,
            key,
            confirmationMode,
            actionInProgress,
            resetConfirmation,
            setConfirmationWithTimeout,
            setActionInProgress,
            onExit,
            onSwitchToLocal,
        })
    }, [confirmationMode, actionInProgress, onExit, onSwitchToLocal, setConfirmationWithTimeout, resetConfirmation]))

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
                    {actionInProgress === 'exiting' ? (
                        <Text color="gray" bold>
                            Exiting agent...
                        </Text>
                    ) : actionInProgress === 'switching' ? (
                        <Text color="gray" bold>
                            Switching to local mode...
                        </Text>
                    ) : confirmationMode === 'exit' ? (
                        <Text color="red" bold>
                            ⚠️  Press Ctrl-C again to exit the agent
                        </Text>
                    ) : confirmationMode === 'switch' ? (
                        <Text color="yellow" bold>
                            ⏸️  Press space again to switch to local mode
                        </Text>
                    ) : (
                        <>
                            <Text color="green" bold>
                                🤖 Codex Agent Running • Space to switch local • Ctrl-C to exit
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
