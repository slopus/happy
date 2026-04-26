import { Page } from '@/app/components/Page'
import { Composer } from '@/app/components/Composer'
import { UserMessage } from '@/app/components/chat/UserMessage'
import { AssistantMessage } from '@/app/components/chat/AssistantMessage'
import { PermissionPrompt } from '@/app/components/chat/PermissionPrompt'
import './Chat.css'

type MockMessage =
    | { type: 'user'; id: string; text: string }
    | { type: 'assistant'; id: string; text: string }
    | { type: 'permission'; id: string; question: string; command?: string }

const MOCK: MockMessage[] = [
    {
        type: 'user',
        id: 'u1',
        text: 'Review my recent commits for correctness risks and maintainability concerns.',
    },
    {
        type: 'assistant',
        id: 'a1',
        text: 'I’ll check the last few commits on this branch and flag anything that looks risky. Starting with a diff summary.',
    },
    {
        type: 'assistant',
        id: 'a2',
        text:
            'Looked at the last 5 commits:\n\n' +
            '• feat(codium): 3-way theme switcher — all changes scoped, no breaking renames\n' +
            '• feat(codium): route-based layouts — new nested routes, no orphan routes left\n' +
            '• feat(codium): Page component — moves title into header; check if any page still uses the old `.app__title` class\n' +
            '• feat(codium): Codex-stack deps — lots of additions, want to run a full install to verify the lockfile is coherent',
    },
    {
        type: 'permission',
        id: 'p1',
        question:
            'Do you want to allow network access to install workspace dependencies so I can run type/build checks for your commit review?',
        command: 'pnpm install --frozen-lockfile',
    },
]

export function ChatPage() {
    return (
        <Page title="Commit review" variant="chat">
            <div className="chat">
                <div className="chat__scroll">
                    <div className="chat__thread">
                        {MOCK.map((m) => {
                            if (m.type === 'user')
                                return <UserMessage key={m.id}>{m.text}</UserMessage>
                            if (m.type === 'assistant')
                                return <AssistantMessage key={m.id}>{m.text}</AssistantMessage>
                            return (
                                <PermissionPrompt
                                    key={m.id}
                                    question={m.question}
                                    command={m.command}
                                />
                            )
                        })}
                    </div>
                </div>
                <div className="chat__dock">
                    <div className="chat__dock-inner">
                        <Composer placeholder="Reply to the assistant…" />
                    </div>
                </div>
            </div>
        </Page>
    )
}
