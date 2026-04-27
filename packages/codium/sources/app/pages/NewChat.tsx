import { useSetAtom } from 'jotai'
import { useNavigate } from 'react-router-dom'
import { Page } from '@/app/components/Page'
import { Composer } from '@/app/components/Composer'
import { createChatAtom } from '@/app/chat/store'
import './NewChat.css'

export function NewChatPage() {
    const navigate = useNavigate()
    const createChat = useSetAtom(createChatAtom)

    return (
        <Page>
            <div className="new-chat">
                <h2 className="new-chat__headline">What can I help with?</h2>
                <div className="new-chat__composer">
                    <Composer
                        onSubmit={(text) => {
                            const trimmed = text.trim()
                            if (trimmed.length === 0) return
                            // ChatPage will see the seeded user message and
                            // kick off the first turn on mount.
                            const chat = createChat({ firstUserMessage: trimmed })
                            navigate(`/chat/${chat.id}`)
                        }}
                    />
                </div>
            </div>
        </Page>
    )
}
