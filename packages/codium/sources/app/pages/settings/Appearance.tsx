import { Page } from '@/app/components/Page'
import { ThemeSwitcher } from '@/app/components/ThemeSwitcher'

export function AppearanceSettings() {
    return (
        <Page title="Appearance">
            <p className="app__subtitle">Choose how Codium looks.</p>
            <div className="app__card">
                <span className="app__card-label">Theme</span>
                <ThemeSwitcher />
            </div>
        </Page>
    )
}
