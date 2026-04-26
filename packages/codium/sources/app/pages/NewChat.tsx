import { useAtomValue, useSetAtom } from 'jotai'
import { useNavigate } from 'react-router-dom'
import { Page } from '@/app/components/Page'
import { Composer } from '@/app/components/Composer'
import { effortAtom, modelAtom } from '@/app/state'
import { useChatRunner } from '@/app/chat/runner'
import { createChatAtom } from '@/app/chat/store'
import './NewChat.css'

export function NewChatPage() {
    const navigate = useNavigate()
    const createChat = useSetAtom(createChatAtom)
    const model = useAtomValue(modelAtom)
    const effort = useAtomValue(effortAtom)
    const { run } = useChatRunner()

    return (
        <Page title="New chat">
            <div className="new-chat">
                <h2 className="new-chat__headline">What can I help with?</h2>
                <div className="new-chat__composer">
                    <Composer
                        onSubmit={(text) => {
                            const trimmed = text.trim()
                            if (trimmed.length === 0) return
                            const chat = createChat({ firstUserMessage: trimmed })
                            // Kick off inference in the background; ChatPage will reactively
                            // show the assistant message as deltas land.
                            void run({
                                chatId: chat.id,
                                history: chat.messages,
                                modelId: model,
                                effort,
                            })
                            navigate(`/chat/${chat.id}`)
                        }}
                    />
                </div>
            </div>
        </Page>
    )
}
