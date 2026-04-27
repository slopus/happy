import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useMemo, useRef } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { v4 as uuid } from 'uuid'
import { Page } from '@/app/components/Page'
import { Composer } from '@/app/components/Composer'
import { UserMessage } from '@/app/components/chat/UserMessage'
import { AssistantMessage } from '@/app/components/chat/AssistantMessage'
import { effortAtom, modelAtom } from '@/app/state'
import { useChatRunner } from '@/app/chat/runner'
import { appendMessageAtom, chatByIdAtomFamily } from '@/app/chat/store'
import './Chat.css'

export function ChatPage() {
    const { id = '' } = useParams<{ id: string }>()
    const chatAtom = useMemo(() => chatByIdAtomFamily(id), [id])
    const chat = useAtomValue(chatAtom)
    const append = useSetAtom(appendMessageAtom)
    const model = useAtomValue(modelAtom)
    const effort = useAtomValue(effortAtom)
    const { run, interrupt } = useChatRunner()
    const scrollRef = useRef<HTMLDivElement>(null)
    /** Whether the user is "pinned" to the bottom — true when they've not
     *  manually scrolled up. We only auto-scroll while pinned, so that
     *  reading older content isn't interrupted by new tokens. */
    const pinnedRef = useRef(true)
    /** Guards the auto-run effect so a re-render doesn't re-fire it. */
    const initialRunFiredRef = useRef(false)

    useEffect(() => {
        const el = scrollRef.current
        if (!el) return
        const onScroll = () => {
            // 32px slack: treat "near the bottom" as still pinned.
            const distance = el.scrollHeight - (el.scrollTop + el.clientHeight)
            pinnedRef.current = distance < 32
        }
        el.addEventListener('scroll', onScroll, { passive: true })
        return () => el.removeEventListener('scroll', onScroll)
    }, [])

    // Auto-scroll only while pinned — never yank the viewport away from
    // content the user is reading.
    useEffect(() => {
        if (!pinnedRef.current) return
        const el = scrollRef.current
        if (!el) return
        el.scrollTop = el.scrollHeight
    }, [chat?.messages.length, chat?.messages[chat.messages.length - 1]?.text.length])

    // Coming from /chat/new the chat already has the user's first message
    // but no assistant response yet — kick off the initial turn here so
    // NewChat doesn't have to know about session lifecycle.
    useEffect(() => {
        if (!chat || initialRunFiredRef.current) return
        const lastMsg = chat.messages[chat.messages.length - 1]
        const hasAssistant = chat.messages.some((m) => m.role === 'assistant')
        if (!hasAssistant && lastMsg?.role === 'user' && chat.status === 'idle') {
            initialRunFiredRef.current = true
            run({ chatId: chat.id, prompt: lastMsg.text, modelId: model, effort })
        }
    }, [chat, run, model, effort])

    if (!chat) return <Navigate to="/chat/new" replace />

    const onSubmit = (text: string) => {
        const trimmed = text.trim()
        if (trimmed.length === 0) return
        if (chat.status === 'streaming') {
            interrupt()
        }
        const userMessage = {
            id: uuid(),
            role: 'user' as const,
            text: trimmed,
            finished: true,
        }
        append({ chatId: chat.id, message: userMessage })
        run({
            chatId: chat.id,
            prompt: trimmed,
            modelId: model,
            effort,
        })
    }

    return (
        <Page title={chat.title} variant="chat">
            <div className="chat">
                <div className="chat__scroll" ref={scrollRef}>
                    <div className="chat__thread">
                        {chat.messages.map((m, i) => {
                            if (m.role === 'user') {
                                return <UserMessage key={m.id}>{m.text}</UserMessage>
                            }
                            const isLast = i === chat.messages.length - 1
                            const streaming = isLast && chat.status === 'streaming'
                            return (
                                <AssistantMessage
                                    key={m.id}
                                    streaming={streaming}
                                    thinking={m.thinking}
                                    tools={m.tools}
                                >
                                    {m.error
                                        ? m.text || `⚠️ ${m.error}`
                                        : m.text || (streaming && !m.tools?.length ? '…' : '')}
                                </AssistantMessage>
                            )
                        })}
                        {chat.status === 'error' && chat.error && !chat.messages.some((m) => m.error) && (
                            <AssistantMessage>{`⚠️ ${chat.error}`}</AssistantMessage>
                        )}
                    </div>
                </div>
                <div className="chat__dock">
                    <div className="chat__dock-inner">
                        <Composer
                            placeholder={
                                chat.status === 'streaming'
                                    ? 'Streaming reply… (sending will interrupt)'
                                    : 'Reply to the assistant…'
                            }
                            onSubmit={onSubmit}
                        />
                    </div>
                </div>
            </div>
        </Page>
    )
}
