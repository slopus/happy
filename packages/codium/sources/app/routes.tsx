import { createHashRouter, Navigate } from 'react-router-dom'
import { RootLayout } from './layouts/RootLayout'
import { MainLayout } from './layouts/MainLayout'
import { SettingsLayout } from './layouts/SettingsLayout'
import { NewChatPage } from './pages/NewChat'
import { ChatPage } from './pages/Chat'
import { AutomationsPage } from './pages/Automations'
import { PluginsPage } from './pages/Plugins'
import { AppearanceSettings } from './pages/settings/Appearance'
import { GeneralSettings } from './pages/settings/General'
import { AboutSettings } from './pages/settings/About'

export const router = createHashRouter([
    {
        element: <RootLayout />,
        children: [
            {
                element: <MainLayout />,
                children: [
                    { index: true, element: <Navigate to="/chat/new" replace /> },
                    { path: 'chat/new', element: <NewChatPage /> },
                    { path: 'chat/:id', element: <ChatPage /> },
                    { path: 'automations', element: <AutomationsPage /> },
                    { path: 'plugins', element: <PluginsPage /> },
                ],
            },
            {
                path: 'settings',
                element: <SettingsLayout />,
                children: [
                    { index: true, element: <Navigate to="/settings/appearance" replace /> },
                    { path: 'appearance', element: <AppearanceSettings /> },
                    { path: 'general', element: <GeneralSettings /> },
                    { path: 'about', element: <AboutSettings /> },
                ],
            },
        ],
    },
])
