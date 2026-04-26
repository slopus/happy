import { ColorSwatch } from './ColorSwatch'
import { SelectButton } from './SelectButton'
import { SegmentedControl } from './SegmentedControl'
import { SettingsRow } from './SettingsRow'
import { ToggleSwitch } from './ToggleSwitch'
import './SettingsShellPreview.css'

const NAV = ['General', 'Appearance', 'Plugins', 'Usage']

export function SettingsShellPreview() {
    return (
        <div className="settings-shell-preview">
            <nav className="settings-shell-preview__nav" aria-label="Settings preview">
                <div className="settings-shell-preview__nav-title">Settings</div>
                {NAV.map((item) => (
                    <button
                        key={item}
                        type="button"
                        className={
                            item === 'Appearance'
                                ? 'settings-shell-preview__nav-item settings-shell-preview__nav-item--active'
                                : 'settings-shell-preview__nav-item'
                        }
                    >
                        {item}
                    </button>
                ))}
            </nav>
            <section className="settings-shell-preview__panel">
                <h3 className="settings-shell-preview__title">Appearance</h3>
                <div className="settings-shell-preview__group">
                    <SettingsRow label="Theme">
                        <SegmentedControl
                            ariaLabel="Theme"
                            options={['System', 'Light', 'Dark']}
                            initial="Dark"
                        />
                    </SettingsRow>
                    <SettingsRow label="Accent color" description="Used for focus rings and progress.">
                        <div className="settings-shell-preview__swatches">
                            <ColorSwatch label="Blue" color="#339cff" selected />
                            <ColorSwatch label="Purple" color="#ad7bf9" />
                            <ColorSwatch label="Green" color="#40c977" />
                        </div>
                    </SettingsRow>
                    <SettingsRow label="Terminal font">
                        <SelectButton label="SF Mono" width={180} />
                    </SettingsRow>
                    <SettingsRow label="Compact sidebar">
                        <ToggleSwitch label="Compact sidebar" />
                    </SettingsRow>
                </div>
            </section>
        </div>
    )
}
