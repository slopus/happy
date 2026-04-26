import { useRef, useState } from 'react'
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor'
import { AttachButton } from './AttachButton'
import { ComposerOptions } from './ComposerOptions'
import { AttachmentChip, type Attachment } from './AttachmentChip'
import './Composer.css'

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

function ShieldIcon() {
    return (
        <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
            <path d="m9 12 2 2 4-4" />
        </svg>
    )
}

function MicIcon() {
    return (
        <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <path d="M12 19v3" />
        </svg>
    )
}

function ChevronDown() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="m6 9 6 6 6-6" />
        </svg>
    )
}

interface ComposerProps {
    placeholder?: string
    onSubmit?: (text: string, attachments: Attachment[]) => void
}

export function Composer({
    placeholder = 'Ask Codex anything. @ to use plugins or mention files',
    onSubmit,
}: ComposerProps) {
    const editorRef = useRef<ComposerEditorHandle>(null)
    const [text, setText] = useState('')
    const [attachments, setAttachments] = useState<Attachment[]>([])
    const canSend = text.trim().length > 0 || attachments.length > 0

    const addAttachments = (files: Attachment[]) => {
        setAttachments((prev) => {
            const existing = new Set(prev.map((a) => a.path))
            return [...prev, ...files.filter((f) => !existing.has(f.path))]
        })
    }

    const removeAttachment = (path: string) => {
        setAttachments((prev) => prev.filter((a) => a.path !== path))
    }

    const handleSubmit = (value: string) => {
        if (!canSend) return
        const trimmed = value.trim()
        onSubmit?.(trimmed, attachments)
        editorRef.current?.clear()
        setText('')
        setAttachments([])
        editorRef.current?.focus()
    }

    return (
        <div className="composer">
            <div className="composer__primary">
                {attachments.length > 0 && (
                    <div className="composer__attachments">
                        {attachments.map((a) => (
                            <AttachmentChip
                                key={a.path}
                                attachment={a}
                                onRemove={removeAttachment}
                            />
                        ))}
                    </div>
                )}
                <ComposerEditor
                    ref={editorRef}
                    placeholder={placeholder}
                    onSubmit={handleSubmit}
                    onUpdate={setText}
                />
                <div className="composer__footer">
                    <div className="composer__footer-group composer__footer-group--left">
                        <AttachButton onSelect={addAttachments} />
                        <button
                            type="button"
                            className="composer-footer__btn composer-footer__btn--accent"
                        >
                            <ShieldIcon />
                            <span className="composer-footer__btn-text">Auto-review</span>
                            <ChevronDown />
                        </button>
                    </div>
                    <div className="composer__footer-group composer__footer-group--right">
                        <button
                            type="button"
                            className="composer-footer__btn composer-footer__btn--model-effort"
                            aria-label="Model and reasoning effort"
                        >
                            <span className="composer-footer__btn-text composer-footer__btn-text--strong">
                                5.5
                            </span>
                            <span className="composer-footer__btn-text composer-footer__btn-text--muted">
                                High
                            </span>
                            <ChevronDown />
                        </button>
                        <button
                            type="button"
                            className="composer-footer__btn composer-footer__btn--icon composer-footer__btn--mic"
                            aria-label="Voice input"
                        >
                            <MicIcon />
                        </button>
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
            </div>
            <ComposerOptions onSelect={addAttachments} />
        </div>
    )
}
