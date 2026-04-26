import './ArchivedChatRow.css'

interface ArchivedChatRowProps {
    title: string
    date: string
    summary: string
}

function RestoreIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v6h6" />
        </svg>
    )
}

export function ArchivedChatRow({ title, date, summary }: ArchivedChatRowProps) {
    return (
        <div className="archived-chat-row">
            <div className="archived-chat-row__body">
                <div className="archived-chat-row__title">{title}</div>
                <div className="archived-chat-row__summary">{summary}</div>
            </div>
            <div className="archived-chat-row__aside">
                <span className="archived-chat-row__date">{date}</span>
                <button type="button" className="archived-chat-row__restore" aria-label={`Restore ${title}`}>
                    <RestoreIcon />
                </button>
            </div>
        </div>
    )
}
