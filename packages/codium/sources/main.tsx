import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './app/routes'
import { bootPlugins } from './plugins'
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

// Plugin host: every built-in plugin registers itself before the UI mounts so
// the inference model picker and Plugins page see a populated catalog.
void bootPlugins()

ReactDOM.createRoot(root).render(
    <React.StrictMode>
        <Providers>
            <RouterProvider router={router} />
        </Providers>
    </React.StrictMode>
)
