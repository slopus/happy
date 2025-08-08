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