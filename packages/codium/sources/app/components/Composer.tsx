import { useRef, useState } from 'react'
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor'

function SendIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
        </svg>
    )
}

interface ComposerProps {
    placeholder?: string
    onSubmit?: (text: string) => void
}

export function Composer({ placeholder = 'Ask anything…', onSubmit }: ComposerProps) {
    const editorRef = useRef<ComposerEditorHandle>(null)
    const [text, setText] = useState('')
    const canSend = text.trim().length > 0

    const handleSubmit = (value: string) => {
        const trimmed = value.trim()
        if (!trimmed) return
        onSubmit?.(trimmed)
        editorRef.current?.clear()
        setText('')
        editorRef.current?.focus()
    }

    return (
        <div className="composer">
            <ComposerEditor
                ref={editorRef}
                placeholder={placeholder}
                onSubmit={handleSubmit}
                onUpdate={setText}
            />
            <div className="composer__actions">
                <button
                    type="button"
                    className="composer__send"
                    disabled={!canSend}
                    aria-label="Send message"
                    onClick={() => handleSubmit(text)}
                >
                    <SendIcon />
                </button>
            </div>
        </div>
    )
}
