import { useEffect, useRef } from 'react'
import { Terminal, useTerminal } from '@wterm/react'
import '@wterm/react/css'

interface TerminalPaneProps {
    id: string
}

export function TerminalPane({ id: _id }: TerminalPaneProps) {
    const { ref, write } = useTerminal()
    const ptyIdRef = useRef<string | null>(null)

    useEffect(() => {
        let cancelled = false
        let unsubData: (() => void) | null = null
        let unsubExit: (() => void) | null = null

        ;(async () => {
            const ptyId = await window.pty.create({ cols: 80, rows: 24 })
            if (cancelled) {
                window.pty.kill(ptyId)
                return
            }
            ptyIdRef.current = ptyId
            unsubData = window.pty.onData(ptyId, (data) => write(data))
            unsubExit = window.pty.onExit(ptyId, () => {
                write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
            })
        })()

        return () => {
            cancelled = true
            unsubData?.()
            unsubExit?.()
            const ptyId = ptyIdRef.current
            if (ptyId) {
                window.pty.kill(ptyId)
                ptyIdRef.current = null
            }
        }
    }, [write])

    return (
        <div className="terminal-pane">
            <Terminal
                ref={ref}
                autoResize
                onData={(data) => {
                    const ptyId = ptyIdRef.current
                    if (ptyId) window.pty.write(ptyId, data)
                }}
                onResize={(cols, rows) => {
                    const ptyId = ptyIdRef.current
                    if (ptyId) window.pty.resize(ptyId, cols, rows)
                }}
            />
        </div>
    )
}
