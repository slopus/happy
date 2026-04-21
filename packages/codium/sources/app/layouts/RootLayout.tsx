import { Outlet } from 'react-router-dom'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect } from 'react'
import { useTheme } from '@/theme'
import { sidebarOpenAtom, fullscreenAtom } from '@/app/state'
import { SearchDialog } from '@/app/components/SearchDialog'

export function RootLayout() {
    useTheme()
    const sidebarOpen = useAtomValue(sidebarOpenAtom)
    const fullscreen = useAtomValue(fullscreenAtom)
    const setFullscreen = useSetAtom(fullscreenAtom)

    useEffect(() => {
        if (!window.win) return
        setFullscreen(window.win.isFullScreenSync())
        return window.win.onFullScreenChange((fs) => setFullscreen(fs))
    }, [setFullscreen])

    const classes = [
        'app',
        sidebarOpen ? null : 'app--sidebar-hidden',
        fullscreen ? 'app--fullscreen' : null,
    ]
        .filter(Boolean)
        .join(' ')

    return (
        <div className={classes}>
            <Outlet />
            <SearchDialog />
        </div>
    )
}
