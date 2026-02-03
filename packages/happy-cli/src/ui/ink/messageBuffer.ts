export interface BufferedMessage {
    id: string
    timestamp: Date
    content: string
    type: 'user' | 'assistant' | 'system' | 'tool' | 'result' | 'status'
}

export class MessageBuffer {
    private messages: BufferedMessage[] = []
    private listeners: Array<(messages: BufferedMessage[]) => void> = []
    private nextId = 1

    addMessage(content: string, type: BufferedMessage['type'] = 'assistant'): void {
        const message: BufferedMessage = {
            id: `msg-${this.nextId++}`,
            timestamp: new Date(),
            content,
            type
        }
        this.messages.push(message)
        this.notifyListeners()
    }

    /**
     * Update the last message of a specific type by appending content to it
     * Useful for streaming responses where deltas should accumulate in one message
     */
    updateLastMessage(contentDelta: string, type: BufferedMessage['type'] = 'assistant'): void {
        // Find the last message of the specified type
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i].type === type) {
                // Create a new message object with updated content (for React to detect change)
                const oldMessage = this.messages[i];
                const updatedMessage: BufferedMessage = {
                    ...oldMessage,
                    content: oldMessage.content + contentDelta
                };
                // Replace the old message with the new one
                this.messages[i] = updatedMessage;
                this.notifyListeners()
                return
            }
        }
        // If no message of this type exists, create a new one
        // This can happen if updateLastMessage is called before the first message is added
        this.addMessage(contentDelta, type)
    }

    /**
     * Remove the last message of a specific type
     * Useful for removing placeholder messages like "Thinking..." when actual response starts
     */
    removeLastMessage(type: BufferedMessage['type']): boolean {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            if (this.messages[i].type === type) {
                this.messages.splice(i, 1)
                this.notifyListeners()
                return true
            }
        }
        return false
    }

    getMessages(): BufferedMessage[] {
        return [...this.messages]
    }

    clear(): void {
        this.messages = []
        this.nextId = 1
        this.notifyListeners()
    }

    onUpdate(listener: (messages: BufferedMessage[]) => void): () => void {
        this.listeners.push(listener)
        return () => {
            const index = this.listeners.indexOf(listener)
            if (index > -1) {
                this.listeners.splice(index, 1)
            }
        }
    }

    private notifyListeners(): void {
        const messages = this.getMessages()
        this.listeners.forEach(listener => listener(messages))
    }
}