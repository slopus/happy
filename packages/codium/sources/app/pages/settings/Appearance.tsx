import { Page } from '@/app/components/Page'
import { ThemePicker } from '@/app/components/ThemePicker'
import { ThemeSwitcher } from '@/app/components/ThemeSwitcher'

export function AppearanceSettings() {
    return (
        <Page title="Appearance">
            <p className="app__subtitle">Choose how Codium looks.</p>
            <div className="app__card">
                <span className="app__card-label">Mode</span>
                <ThemeSwitcher />
            </div>
            <div className="app__card">
                <span className="app__card-label">Theme</span>
                <ThemePicker />
            </div>
        </Page>
    )
}
