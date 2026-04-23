export function UserMessage({ children }: { children: string }) {
    return (
        <div className="chat-message chat-message--user">
            <div className="chat-message__bubble">{children}</div>
        </div>
    )
}
