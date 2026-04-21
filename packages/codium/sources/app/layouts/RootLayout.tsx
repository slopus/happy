import { Outlet } from 'react-router-dom'
import { useAtomValue } from 'jotai'
import { useTheme } from '@/theme'
import { sidebarOpenAtom } from '@/app/state'
import { SearchDialog } from '@/app/components/SearchDialog'

export function RootLayout() {
    useTheme()
    const sidebarOpen = useAtomValue(sidebarOpenAtom)
    return (
        <div className={sidebarOpen ? 'app' : 'app app--sidebar-hidden'}>
            <Outlet />
            <SearchDialog />
        </div>
    )
}
