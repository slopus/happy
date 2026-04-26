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
    const { run, cancel } = useChatRunner()
    const scrollRef = useRef<HTMLDivElement>(null)

    // Auto-scroll to bottom when messages grow.
    useEffect(() => {
        const el = scrollRef.current
        if (!el) return
        el.scrollTop = el.scrollHeight
    }, [chat?.messages.length, chat?.messages[chat.messages.length - 1]?.text.length])

    if (!chat) return <Navigate to="/chat/new" replace />

    const onSubmit = (text: string) => {
        const trimmed = text.trim()
        if (trimmed.length === 0) return
        if (chat.status === 'streaming') {
            cancel()
        }
        const userMessage = {
            id: uuid(),
            role: 'user' as const,
            text: trimmed,
            finished: true,
        }
        append({ chatId: chat.id, message: userMessage })
        // The runner reads history fresh — pass the current snapshot plus the
        // new user turn so the assistant sees the full sequence.
        const nextHistory = [...chat.messages, userMessage]
        void run({
            chatId: chat.id,
            history: nextHistory,
            modelId: model,
            effort,
        })
    }

    return (
        <Page title={chat.title} variant="chat">
            <div className="chat">
                <div className="chat__scroll" ref={scrollRef}>
                    <div className="chat__thread">
                        {chat.messages.map((m) =>
                            m.role === 'user' ? (
                                <UserMessage key={m.id}>{m.text}</UserMessage>
                            ) : (
                                <AssistantMessage key={m.id}>
                                    {m.error
                                        ? m.text || `⚠️ ${m.error}`
                                        : m.text || (chat.status === 'streaming' ? '…' : '')}
                                </AssistantMessage>
                            ),
                        )}
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
                                    ? 'Streaming reply… (sending will cancel)'
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
