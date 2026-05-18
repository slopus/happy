import type {
    AgentEvent,
    AgentStartOptions,
} from '../shared/agent-protocol'

export interface AgentSession {
    readonly id: string
    send(text: string): void
    interrupt(): void
    stop(): void
}

export interface OpenSessionArgs {
    sessionId: string
    prompt: string
    resume: boolean
    options: AgentStartOptions
    onEvent(ev: AgentEvent): void
    onClosed?: () => void
}

export function openAgentSession(args: OpenSessionArgs): AgentSession {
    const offEvent = window.agent.onEvent(args.sessionId, args.onEvent)
    const offClosed = window.agent.onClosed(args.sessionId, () => {
        try {
            args.onClosed?.()
        } finally {
            offEvent()
            offClosed()
        }
    })

    window.agent.start({
        sessionId: args.sessionId,
        prompt: args.prompt,
        resume: args.resume,
        options: args.options,
    })

    return {
        id: args.sessionId,
        send: (text) => window.agent.send(args.sessionId, text),
        interrupt: () => window.agent.interrupt(args.sessionId),
        stop: () => window.agent.stop(args.sessionId),
    }
}
