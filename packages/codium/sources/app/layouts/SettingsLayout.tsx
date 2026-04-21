import { Outlet } from 'react-router-dom'
import { Toolbar } from '@/app/components/Toolbar'
import { SettingsSidebar } from '@/app/components/SettingsSidebar'

export function SettingsLayout() {
    return (
        <>
            <Toolbar />
            <SettingsSidebar />
            <main className="app__main">
                <div className="app__content">
                    <Outlet />
                </div>
            </main>
        </>
    )
}
