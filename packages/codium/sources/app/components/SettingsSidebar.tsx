import { NavLink, useNavigate } from 'react-router-dom'
import { useAtomValue } from 'jotai'
import { preSettingsPathAtom } from '@/app/state'

const NAV = [
    { path: '/settings/appearance', label: 'Appearance' },
    { path: '/settings/general', label: 'General' },
    { path: '/settings/about', label: 'About' },
] as const

function ArrowLeftIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 6-6 6 6 6" />
        </svg>
    )
}

export function SettingsSidebar() {
    const preSettings = useAtomValue(preSettingsPathAtom)
    const navigate = useNavigate()

    return (
        <aside className="app__sidebar">
            <button
                type="button"
                className="app__sidebar-back"
                onClick={() => navigate(preSettings || '/workspace')}
                aria-label="Back"
            >
                <ArrowLeftIcon />
                <span>Back</span>
            </button>
            <div className="app__sidebar-header">Settings</div>
            <div className="app__sidebar-nav">
                {NAV.map((item) => (
                    <NavLink
                        key={item.path}
                        to={item.path}
                        className={({ isActive }) =>
                            isActive ? 'app__nav-item app__nav-item--active' : 'app__nav-item'
                        }
                    >
                        {item.label}
                    </NavLink>
                ))}
            </div>
        </aside>
    )
}
