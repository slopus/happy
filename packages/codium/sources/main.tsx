import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './app/routes'
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
            <RouterProvider router={router} />
        </Providers>
    </React.StrictMode>
)
