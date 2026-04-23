import { useNavigate } from 'react-router-dom'
import { Page } from '@/app/components/Page'
import { Composer } from '@/app/components/Composer'

export function NewChatPage() {
    const navigate = useNavigate()
    return (
        <Page title="New chat">
            <div className="new-chat">
                <h2 className="new-chat__headline">What can I help with?</h2>
                <div className="new-chat__composer">
                    <Composer
                        onSubmit={() => {
                            navigate('/chat/demo')
                        }}
                    />
                </div>
            </div>
        </Page>
    )
}
