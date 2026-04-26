import { useLocation } from 'react-router-dom'
import { useAtomValue } from 'jotai'
import { terminalsAtom } from '@/app/state'
import { TerminalPane } from './TerminalPane'
import './TerminalHost.css'

export function TerminalHost() {
    const terminals = useAtomValue(terminalsAtom)
    const location = useLocation()
    const match = location.pathname.match(/^\/terminal\/([^/]+)$/)
    const activeId = match ? match[1] : null
    const visible = activeId !== null
    const active = terminals.find((t) => t.id === activeId)

    return (
        <div
            className={
                visible ? 'terminal-host terminal-host--visible' : 'terminal-host'
            }
        >
            <header className="page__header">
                <div className="page__header-title">
                    {active?.title ?? 'Terminal'}
                </div>
            </header>
            <div className="terminal-host__panes">
                {terminals.map((t) => (
                    <div
                        key={t.id}
                        className={
                            t.id === activeId
                                ? 'terminal-host__pane terminal-host__pane--active'
                                : 'terminal-host__pane'
                        }
                    >
                        <TerminalPane id={t.id} />
                    </div>
                ))}
            </div>
        </div>
    )
}
