import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { Providers } from './providers'
import './index.css'

const root = document.getElementById('root')!

const platform = navigator.platform.toLowerCase()
const os = platform.includes('mac')
    ? 'darwin'
    : platform.includes('win')
      ? 'win32'
      : 'linux'
document.documentElement.dataset.windowType = 'electron'
document.documentElement.dataset.os = os

ReactDOM.createRoot(root).render(
    <React.StrictMode>
        <Providers>
            <App />
        </Providers>
    </React.StrictMode>
)
