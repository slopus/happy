import { ThemeSwitcher } from '@/app/components/ThemeSwitcher'

export function AppearanceSettings() {
    return (
        <>
            <h1 className="app__title">Appearance</h1>
            <p className="app__subtitle">Choose how Codium looks.</p>
            <div className="app__card">
                <span className="app__card-label">Theme</span>
                <ThemeSwitcher />
            </div>
        </>
    )
}
