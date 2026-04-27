import { useState } from 'react'
import { Streamdown } from 'streamdown'
import type { ChatToolCall } from '@/app/chat/store'
import './AssistantMessage.css'

interface AssistantMessageProps {
    children: string
    /** Reasoning summary streamed alongside the visible answer. Renders
     *  as a collapsible block above the answer when present. */
    thinking?: string
    /** Tool invocations the assistant made during this turn. Rendered as
     *  collapsible cards under the visible answer. */
    tools?: ChatToolCall[]
    /** True while the message is still being streamed in — disables hard
     *  parsing of unfinished code fences / tables / etc. */
    streaming?: boolean
}

function ChevronRight({ open }: { open: boolean }) {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
                transform: `rotate(${open ? 90 : 0}deg)`,
                transition: 'transform 120ms ease',
            }}
        >
            <path d="m9 6 6 6-6 6" />
        </svg>
    )
}

export function AssistantMessage({ children, thinking, tools, streaming }: AssistantMessageProps) {
    // Default-open while streaming so users see reasoning land live; once
    // the answer is final, the user can collapse it to focus on the answer.
    const [open, setOpen] = useState(true)

    return (
        <div className="chat-message chat-message--assistant">
            {thinking && thinking.length > 0 && (
                <div className="chat-message__thinking">
                    <button
                        type="button"
                        className="chat-message__thinking-toggle"
                        onClick={() => setOpen((v) => !v)}
                    >
                        <ChevronRight open={open} />
                        <span>{streaming ? 'Thinking…' : 'Thought process'}</span>
                    </button>
                    {open && (
                        <Streamdown
                            className="chat-message__thinking-body"
                            isAnimating={streaming}
                        >
                            {thinking}
                        </Streamdown>
                    )}
                </div>
            )}
            {children.length > 0 && (
                <Streamdown
                    className="chat-message__markdown"
                    isAnimating={streaming}
                >
                    {children}
                </Streamdown>
            )}
            {tools?.map((t) => <ToolCall key={t.id} tool={t} />)}
        </div>
    )
}

function ToolCall({ tool }: { tool: ChatToolCall }) {
    const [open, setOpen] = useState(false)
    const pending = tool.result === undefined

    return (
        <div className={`tool-call${tool.isError ? ' tool-call--error' : ''}`}>
            <button
                type="button"
                className="tool-call__header"
                onClick={() => setOpen((v) => !v)}
            >
                <ChevronRight open={open} />
                <span className="tool-call__name">{tool.name}</span>
                <span className="tool-call__status">
                    {tool.isError ? '✗ error' : pending ? '…' : '✓'}
                </span>
                <span className="tool-call__summary">{summarizeInput(tool.inputJson)}</span>
            </button>
            {open && (
                <div className="tool-call__body">
                    <div className="tool-call__section-label">Input</div>
                    <pre className="tool-call__pre">{prettyJson(tool.inputJson)}</pre>
                    {tool.result !== undefined && (
                        <>
                            <div className="tool-call__section-label">Output</div>
                            <pre className="tool-call__pre">{tool.result}</pre>
                        </>
                    )}
                </div>
            )}
        </div>
    )
}

/** Render a one-line preview of the tool's input, falling back to the
 *  raw JSON if it doesn't parse (it's still streaming, partial JSON). */
function summarizeInput(json: string): string {
    if (!json) return ''
    try {
        const parsed = JSON.parse(json) as Record<string, unknown>
        // Pick the most useful single field if obvious.
        for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query']) {
            if (typeof parsed[k] === 'string') return String(parsed[k])
        }
        return JSON.stringify(parsed)
    } catch {
        return json.length > 80 ? json.slice(0, 80) + '…' : json
    }
}

function prettyJson(json: string): string {
    if (!json) return ''
    try {
        return JSON.stringify(JSON.parse(json), null, 2)
    } catch {
        return json
    }
}
