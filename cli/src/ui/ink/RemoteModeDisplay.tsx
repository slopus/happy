import React, { useState, useEffect } from 'react'
import { Box, Text, useStdout } from 'ink'
import { MessageBuffer, type BufferedMessage } from './messageBuffer'

interface RemoteModeDisplayProps {
    messageBuffer: MessageBuffer
    logPath?: string
}

export const RemoteModeDisplay: React.FC<RemoteModeDisplayProps> = ({ messageBuffer, logPath }) => {
    const [messages, setMessages] = useState<BufferedMessage[]>([])
    const { stdout } = useStdout()
    const terminalWidth = stdout.columns || 80
    const terminalHeight = stdout.rows || 24

    useEffect(() => {
        setMessages(messageBuffer.getMessages())
        
        const unsubscribe = messageBuffer.onUpdate((newMessages) => {
            setMessages(newMessages)
        })

        return unsubscribe
    }, [messageBuffer])

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
                    <Text color="gray" bold>📡 Remote Mode - Claude Messages</Text>
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
                borderColor="green"
                paddingX={2}
                justifyContent="center"
                alignItems="center"
                flexDirection="column"
            >
                <Text color="green" bold>
                    📱 Press any key to switch to control from terminal
                </Text>
                {process.env.DEBUG && logPath && (
                    <Text color="gray" dimColor>
                        Debug logs: {logPath}
                    </Text>
                )}
            </Box>
        </Box>
    )
}