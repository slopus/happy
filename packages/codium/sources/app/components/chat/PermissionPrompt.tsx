import { useState } from 'react'
import './PermissionPrompt.css'

interface PermissionPromptProps {
    question: string
    command?: string
    onDecision?: (allowed: boolean) => void
}

export function PermissionPrompt({
    question,
    command,
    onDecision,
}: PermissionPromptProps) {
    const [decided, setDecided] = useState<null | 'allowed' | 'denied'>(null)

    const decide = (allowed: boolean) => {
        setDecided(allowed ? 'allowed' : 'denied')
        onDecision?.(allowed)
    }

    return (
        <div className="permission-prompt">
            <div className="permission-prompt__question">{question}</div>
            {command && (
                <pre className="permission-prompt__command">
                    <code>{command}</code>
                </pre>
            )}
            {decided === null ? (
                <div className="permission-prompt__actions">
                    <button
                        type="button"
                        className="permission-prompt__btn permission-prompt__btn--primary"
                        onClick={() => decide(true)}
                    >
                        Yes, allow
                    </button>
                    <button
                        type="button"
                        className="permission-prompt__btn permission-prompt__btn--secondary"
                        onClick={() => decide(false)}
                    >
                        No, deny
                    </button>
                </div>
            ) : (
                <div className="permission-prompt__resolution">
                    {decided === 'allowed' ? 'Allowed' : 'Denied'}
                </div>
            )}
        </div>
    )
}
