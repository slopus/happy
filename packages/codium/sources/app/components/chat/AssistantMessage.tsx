import { Streamdown } from 'streamdown'
import './AssistantMessage.css'

interface AssistantMessageProps {
    children: string
    /** True while the message is still being streamed in — disables hard
     *  parsing of unfinished code fences / tables / etc. */
    streaming?: boolean
}

export function AssistantMessage({ children, streaming }: AssistantMessageProps) {
    return (
        <div className="chat-message chat-message--assistant">
            <Streamdown
                className="chat-message__markdown"
                isAnimating={streaming}
            >
                {children}
            </Streamdown>
        </div>
    )
}
