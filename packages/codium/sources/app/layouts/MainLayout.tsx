import { Outlet } from 'react-router-dom'
import {
    Toolbar,
    SidebarToggleBtn,
    BackBtn,
    ForwardBtn,
} from '@/app/components/Toolbar'
import { MainSidebar } from '@/app/components/MainSidebar'

export function MainLayout() {
    return (
        <>
            <Toolbar>
                <SidebarToggleBtn />
                <BackBtn />
                <ForwardBtn />
            </Toolbar>
            <MainSidebar />
            <main className="app__main">
                <div className="app__content">
                    <Outlet />
                </div>
            </main>
        </>
    )
}
