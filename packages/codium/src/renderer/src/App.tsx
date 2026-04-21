import { useState } from 'react'

const NAV = ['Workspace', 'Sessions', 'Extensions', 'Settings'] as const
type Nav = (typeof NAV)[number]

export function App() {
    const [active, setActive] = useState<Nav>('Workspace')
    const [count, setCount] = useState(0)

    return (
        <div className="app">
            <div className="app__titlebar" />
            <aside className="app__sidebar">
                <div className="app__sidebar-header">Codium</div>
                {NAV.map((item) => (
                    <button
                        key={item}
                        className={
                            item === active
                                ? 'app__nav-item app__nav-item--active'
                                : 'app__nav-item'
                        }
                        onClick={() => setActive(item)}
                    >
                        {item}
                    </button>
                ))}
            </aside>
            <main className="app__main">
                <div className="app__content">
                    <h1 className="app__title">{active}</h1>
                    <p className="app__subtitle">
                        Electron + Vite + React bootstrapped with a Codex-inspired
                        dark scaffold.
                    </p>
                    <div className="app__card">
                        <span className="app__card-label">Demo</span>
                        <button className="app__button" onClick={() => setCount((c) => c + 1)}>
                            clicked {count} {count === 1 ? 'time' : 'times'}
                        </button>
                    </div>
                </div>
            </main>
        </div>
    )
}
