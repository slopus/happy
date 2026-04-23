import { Outlet, useLocation } from 'react-router-dom'
import {
    Toolbar,
    SidebarToggleBtn,
    BackBtn,
    ForwardBtn,
} from '@/app/components/Toolbar'
import { MainSidebar } from '@/app/components/MainSidebar'
import { TerminalHost } from '@/app/components/terminal/TerminalHost'

export function MainLayout() {
    const location = useLocation()
    const isTerminal = location.pathname.startsWith('/terminal/')

    return (
        <>
            <Toolbar>
                <SidebarToggleBtn />
                <BackBtn />
                <ForwardBtn />
            </Toolbar>
            <MainSidebar />
            <main className="app__main">
                <TerminalHost />
                <div
                    className="main-outlet"
                    style={{ display: isTerminal ? 'none' : 'contents' }}
                >
                    <Outlet />
                </div>
            </main>
        </>
    )
}
