import './AssistantMessage.css'

export function AssistantMessage({ children }: { children: string }) {
    return <div className="chat-message chat-message--assistant">{children}</div>
}
