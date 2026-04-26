import type { ReactNode } from 'react'
import { Page } from '@/app/components/Page'
import { Composer } from '@/app/components/Composer'
import { AttachButton } from '@/app/components/AttachButton'
import { AttachmentChip } from '@/app/components/AttachmentChip'
import { ComposerOptions } from '@/app/components/ComposerOptions'
import { ContextRing } from '@/app/components/ContextRing'
import { ModelPicker } from '@/app/components/ModelPicker'
import { EffortPicker } from '@/app/components/EffortPicker'
import { ThemeSwitcher } from '@/app/components/ThemeSwitcher'
import { Toolbar, SidebarToggleBtn, BackBtn, ForwardBtn } from '@/app/components/Toolbar'
import { MainSidebar } from '@/app/components/MainSidebar'
import { AccountPopover } from '@/app/components/AccountPopover'
import { ArchivedChatRow } from '@/app/components/ArchivedChatRow'
import { AutomationTemplateCard } from '@/app/components/AutomationTemplateCard'
import { ColorSwatch } from '@/app/components/ColorSwatch'
import { MenuSeparator } from '@/app/components/MenuSeparator'
import { OptionCard } from '@/app/components/OptionCard'
import { PluginCatalogCard } from '@/app/components/PluginCatalogCard'
import { SearchSurface } from '@/app/components/SearchSurface'
import { SegmentedControl } from '@/app/components/SegmentedControl'
import { SelectButton } from '@/app/components/SelectButton'
import { SettingsRow } from '@/app/components/SettingsRow'
import { SettingsShellPreview } from '@/app/components/SettingsShellPreview'
import { TerminalPreview } from '@/app/components/TerminalPreview'
import { ToggleSwitch } from '@/app/components/ToggleSwitch'
import { UsageLimitSection } from '@/app/components/UsageLimitSection'
import { UserMessage } from '@/app/components/chat/UserMessage'
import { AssistantMessage } from '@/app/components/chat/AssistantMessage'
import { PermissionPrompt } from '@/app/components/chat/PermissionPrompt'
import './Components.css'

function Sample({
    title,
    path,
    wide,
    children,
}: {
    title: string
    path: string
    wide?: boolean
    children: ReactNode
}) {
    return (
        <section
            className={
                wide ? 'component-sample component-sample--wide' : 'component-sample'
            }
        >
            <header className="component-sample__header">
                <h2 className="component-sample__title">{title}</h2>
                <span className="component-sample__path">{path}</span>
            </header>
            <div className="component-sample__body">{children}</div>
        </section>
    )
}

export function ComponentsPage() {
    return (
        <Page title="Components">
            <div className="components-page">
                <p className="components-page__intro">
                    Live Codium component inventory using the same imports and styles as
                    the app surfaces.
                </p>
                <div className="components-grid">
                    <Sample
                        title="Composer"
                        path="components/Composer.tsx + Composer.css"
                        wide
                    >
                        <div className="component-sample__composer">
                            <Composer placeholder="Ask anything..." />
                        </div>
                    </Sample>
                    <Sample
                        title="Composer Controls"
                        path="AttachButton.tsx, ModelPicker.tsx, EffortPicker.tsx, ContextRing.tsx"
                    >
                        <div className="component-sample__row">
                            <AttachButton onSelect={() => undefined} />
                            <ModelPicker />
                            <EffortPicker />
                            <ContextRing ratio={0.62} />
                        </div>
                    </Sample>
                    <Sample
                        title="Attachment Chip"
                        path="AttachmentChip.tsx + AttachmentChip.css"
                    >
                        <div className="component-sample__row">
                            <AttachmentChip
                                attachment={{
                                    path: '/tmp/example-report.md',
                                    name: 'example-report.md',
                                    ext: 'md',
                                }}
                            />
                            <AttachmentChip
                                attachment={{
                                    path: '/tmp/interface-snapshot.png',
                                    name: 'interface-snapshot.png',
                                    ext: 'png',
                                }}
                            />
                        </div>
                    </Sample>
                    <Sample
                        title="Composer Options"
                        path="ComposerOptions.tsx + ComposerOptions.css"
                        wide
                    >
                        <ComposerOptions onSelect={() => undefined} />
                    </Sample>
                    <Sample
                        title="Theme Switcher"
                        path="ThemeSwitcher.tsx + ThemeSwitcher.css"
                    >
                        <ThemeSwitcher />
                    </Sample>
                    <Sample
                        title="Control Primitives"
                        path="SegmentedControl.tsx, ToggleSwitch.tsx, SelectButton.tsx"
                    >
                        <div className="component-sample__stack">
                            <SegmentedControl
                                ariaLabel="Approval mode"
                                options={['Auto', 'Ask', 'Never']}
                                initial="Ask"
                            />
                            <div className="component-sample__row">
                                <ToggleSwitch label="Enable notifications" defaultChecked />
                                <SelectButton label="GPT-5.4" width={180} />
                            </div>
                        </div>
                    </Sample>
                    <Sample
                        title="Color Swatches"
                        path="ColorSwatch.tsx + ColorSwatch.css"
                    >
                        <div className="component-sample__palette">
                            <ColorSwatch label="Blue" color="#339cff" selected />
                            <ColorSwatch label="Purple" color="#ad7bf9" />
                            <ColorSwatch label="Green" color="#40c977" />
                            <ColorSwatch label="Red" color="#fa423e" />
                        </div>
                    </Sample>
                    <Sample title="Toolbar" path="Toolbar.tsx + Toolbar.css">
                        <div className="component-sample__toolbar-frame">
                            <Toolbar>
                                <SidebarToggleBtn />
                                <BackBtn />
                                <ForwardBtn />
                            </Toolbar>
                        </div>
                    </Sample>
                    <Sample title="Sidebar" path="MainSidebar.tsx + MainSidebar.css">
                        <div className="component-sample__sidebar-frame">
                            <MainSidebar />
                        </div>
                    </Sample>
                    <Sample
                        title="Settings Row"
                        path="SettingsRow.tsx + SettingsRow.css"
                        wide
                    >
                        <div className="component-sample__settings-row-frame">
                            <SettingsRow
                                label="Open links in browser"
                                description="Keep external links outside the desktop app."
                            >
                                <ToggleSwitch label="Open links in browser" />
                            </SettingsRow>
                            <SettingsRow label="Default model">
                                <SelectButton label="GPT-5.4" width={220} />
                            </SettingsRow>
                        </div>
                    </Sample>
                    <Sample
                        title="Settings Shell"
                        path="SettingsShellPreview.tsx + SettingsShellPreview.css"
                        wide
                    >
                        <SettingsShellPreview />
                    </Sample>
                    <Sample
                        title="Account Popover"
                        path="AccountPopover.tsx + AccountPopover.css"
                    >
                        <div className="component-sample__account">
                            <AccountPopover />
                        </div>
                    </Sample>
                    <Sample
                        title="Menu Separator"
                        path="MenuSeparator.tsx + MenuSeparator.css"
                    >
                        <div className="component-sample__stack">
                            <span className="component-sample__small-label">Menu group</span>
                            <MenuSeparator />
                            <span className="component-sample__small-label">Second group</span>
                        </div>
                    </Sample>
                    <Sample
                        title="Option Cards"
                        path="OptionCard.tsx + OptionCard.css"
                        wide
                    >
                        <div className="component-sample__option-cards">
                            <OptionCard
                                title="Balanced"
                                description="Default speed and reasoning for day to day work."
                                selected
                            />
                            <OptionCard
                                title="Deep work"
                                description="More careful reasoning for large changes."
                            />
                        </div>
                    </Sample>
                    <Sample
                        title="Automation Templates"
                        path="AutomationTemplateCard.tsx + AutomationTemplateCard.css"
                        wide
                    >
                        <div className="component-sample__automation-grid">
                            <AutomationTemplateCard title="Summarize new issues every weekday" />
                            <AutomationTemplateCard title="Review deploy status after release" />
                            <AutomationTemplateCard title="Send a weekly project digest" />
                        </div>
                    </Sample>
                    <Sample
                        title="Plugin Catalog"
                        path="PluginCatalogCard.tsx + PluginCatalogCard.css"
                        wide
                    >
                        <div className="component-sample__catalog">
                            <PluginCatalogCard
                                name="GitHub"
                                description="Search repositories, issues, pull requests, and CI checks."
                            />
                            <PluginCatalogCard
                                name="Browser Use"
                                description="Inspect, navigate, and screenshot local browser targets."
                            />
                        </div>
                    </Sample>
                    <Sample
                        title="Usage Limit"
                        path="UsageLimitSection.tsx + UsageLimitSection.css"
                        wide
                    >
                        <div className="component-sample__usage">
                            <UsageLimitSection
                                title="Messages"
                                description="Current monthly usage across Codex sessions."
                                percent={72}
                                meta="7,240 of 10,000 messages"
                            />
                            <UsageLimitSection
                                title="Compute"
                                description="Background task and terminal execution allowance."
                                percent={38}
                                meta="19 of 50 hours"
                                action="Upgrade"
                            />
                        </div>
                    </Sample>
                    <Sample
                        title="Archived Chats"
                        path="ArchivedChatRow.tsx + ArchivedChatRow.css"
                        wide
                    >
                        <div className="component-sample__list">
                            <ArchivedChatRow
                                title="Codex visual inspection"
                                summary="Remote debugging notes and component measurements"
                                date="Apr 26"
                            />
                            <ArchivedChatRow
                                title="Settings page pass"
                                summary="Appearance, plugins, archived chats, and usage"
                                date="Apr 25"
                            />
                        </div>
                    </Sample>
                    <Sample
                        title="Search Surface"
                        path="SearchSurface.tsx + SearchSurface.css"
                        wide
                    >
                        <SearchSurface />
                    </Sample>
                    <Sample
                        title="Chat Messages"
                        path="chat/UserMessage.tsx, chat/AssistantMessage.tsx"
                        wide
                    >
                        <div className="component-sample__chat">
                            <UserMessage>
                                Review my latest work for correctness risks.
                            </UserMessage>
                            <AssistantMessage>
                                I checked the visible diff and found the styling split is
                                now component-local.
                            </AssistantMessage>
                        </div>
                    </Sample>
                    <Sample
                        title="Permission Prompt"
                        path="chat/PermissionPrompt.tsx + PermissionPrompt.css"
                        wide
                    >
                        <PermissionPrompt
                            question="Do you want to allow a local verification command?"
                            command="pnpm --filter codium typecheck"
                        />
                    </Sample>
                    <Sample
                        title="Terminal"
                        path="TerminalPreview.tsx + TerminalPreview.css"
                        wide
                    >
                        <TerminalPreview />
                    </Sample>
                </div>
            </div>
        </Page>
    )
}
