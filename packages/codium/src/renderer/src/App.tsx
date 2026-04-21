import { useState } from 'react'

export function App() {
    const [count, setCount] = useState(0)

    return (
        <div className="app">
            <h1>Codium</h1>
            <p>Electron + Vite + React</p>
            <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>
        </div>
    )
}
