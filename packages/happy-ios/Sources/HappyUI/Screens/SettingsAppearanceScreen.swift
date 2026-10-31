#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
import UIKit

/// Settings › Appearance (app/(app)/settings/appearance.tsx), iOS rows only:
/// theme, language, chat, avatars, input and display. The web-only rows
/// (Enter to send, command palette) are left out, as on an iPhone. So is
/// Avatar Style: every avatar without a picture wears its placeholder
/// (`AvatarPlaceholder`) whichever style is set, so only Black & White
/// Avatars changes how they look, and this app's own Animated Avatars
/// (`LiveAvatars`, off by default), which moves them.
public final class SettingsAppearanceViewController: UIViewController {
    private enum Dropdown {
        case bubbleColor
    }

    private let context: AppContext
    private let session: AccountSession
    private let list = GroupedListView()
    private let toggles = SettingsToggleRows()
    private var observation: StoreObservation?
    private var settings = AccountSettings()
    private var openDropdown: Dropdown?

    public init(context: AppContext, session: AccountSession) {
        self.context = context
        self.session = session
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func loadView() {
        view = list
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.Settings.appearance
        showsBackTitle()
        observation = session.store.observeSettings { [weak self] snapshot in
            let settings = AccountSettings(snapshot)
            guard let self, settings != self.settings else { return }
            self.settings = settings
            self.rebuild()
        }
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // The language may have changed on the page pushed from here.
        rebuild()
    }

    private func set(_ key: String, _ value: JSONValue) {
        // Shown at once; the store echoes the same value back.
        settings = settings.applying([key: value])
        session.updateSettings([key: value])
    }

    private func toggle(_ key: String, title: String, subtitle: String, icon: String, tint: ColorToken) -> ItemRowView {
        toggles.row(key, title: title, subtitle: subtitle, icon: ItemIcon(.ionicons(icon), tint: tint), isOn: settings.bool(key)) { [weak self] on in
            self?.set(key, .bool(on))
        }
    }

    private func rebuild() {
        let connecting = Palette.statusConnecting
        let purple = Palette.iconPurple
        var sections: [UIView] = []

        let theme = context.account.localSettings.themePreference
        sections.append(ItemGroupView(title: Strings.SettingsAppearance.theme, footer: Strings.SettingsAppearance.themeDescription, rows: [
            ItemRowView(
                title: Strings.Settings.appearance,
                subtitle: Self.themeDescription(theme),
                detail: Self.themeName(theme),
                icon: ItemIcon(.ionicons("contrast-outline"), tint: connecting)
            ) { [weak self] in
                self?.cycleTheme()
            },
        ]))

        let renderer = context.account.localSettings.homeListRenderer
        let rendererRow = ItemRowView(
            title: Strings.HomeRenderer.title,
            subtitle: Strings.HomeRenderer.description,
            detail: renderer.rawValue,
            icon: ItemIcon(.ionicons("list-outline"), tint: connecting)
        ) { [weak self] in
            guard let self else { return }
            let alert = UIAlertController(title: Strings.HomeRenderer.title, message: nil, preferredStyle: .alert)
            for choice in HomeListRenderer.allCases {
                let action = UIAlertAction(title: choice.rawValue, style: .default) { [weak self] _ in
                    guard let self else { return }
                    HomeRendererPreference.set(choice, settings: self.context.account.localSettings)
                    self.rebuild()
                }
                alert.addAction(action)
            }
            alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
            self.present(alert, animated: true)
        }
        sections.append(ItemGroupView(rows: [rendererRow]))

        let chatRenderer = ItemRowView(
            title: Strings.ChatRenderer.title,
            subtitle: Strings.ChatRenderer.description,
            detail: context.account.localSettings.chatListRenderer.rawValue,
            icon: ItemIcon(.ionicons("chatbubbles-outline"), tint: connecting)
        ) { [weak self] in
            guard let self else { return }
            let alert = UIAlertController(title: Strings.ChatRenderer.title, message: nil, preferredStyle: .alert)
            for choice in ChatListRenderer.allCases {
                alert.addAction(UIAlertAction(title: choice.rawValue, style: .default) { [weak self] _ in
                    guard let self else { return }
                    self.context.account.localSettings.chatListRenderer = choice
                    self.rebuild()
                })
            }
            alert.addAction(UIAlertAction(title: Strings.Common.cancel, style: .cancel))
            self.present(alert, animated: true)
        }
        sections.append(ItemGroupView(rows: [chatRenderer]))

        sections.append(ItemGroupView(title: Strings.SettingsLanguage.title, footer: Strings.SettingsLanguage.description, rows: [
            ItemRowView(
                title: Strings.SettingsLanguage.currentLanguage,
                detail: AppLanguage.displayText(
                    preferred: settings.preferredLanguage,
                    deviceLanguages: Locale.preferredLanguages,
                    automatic: Strings.SettingsLanguage.automatic
                ),
                icon: ItemIcon(.ionicons("language-outline"), tint: Palette.iconBlue)
            ) { [weak self] in
                guard let self else { return }
                self.push(.settingsLanguage, context: self.context)
            },
        ]))

        let bubbleColor = settings.userMessageBubbleColor
        let bubbleOpen = openDropdown == .bubbleColor
        let bubbleValue = DropdownValueView(
            preview: BubblePreviewView(color: bubbleColor),
            previewSize: BubblePreviewLayout.size,
            text: Strings.SettingsAppearance.bubbleColorName(bubbleColor.rawValue)
        )
        bubbleValue.isExpanded = bubbleOpen
        let bubbleRow = ItemRowView(
            title: Strings.SettingsAppearance.userMessageBubbleColor,
            subtitle: Strings.SettingsAppearance.userMessageBubbleColorDescription,
            icon: ItemIcon(.ionicons("chatbubble-ellipses-outline"), tint: bubbleColor.palette.indicator)
        ) { [weak self] in
            self?.toggleDropdown(.bubbleColor)
        }
        bubbleRow.trailingView = bubbleValue
        var chatRows: [UIView] = [
            toggle(
                "usageLimitShowRemaining",
                title: Strings.SettingsAppearance.usageLimitShowRemaining,
                subtitle: Strings.SettingsAppearance.usageLimitShowRemainingDescription,
                icon: "speedometer-outline",
                tint: connecting
            ),
            bubbleRow,
        ]
        if bubbleOpen {
            chatRows.append(OptionListView(options: BubbleColor.allCases.map { color in
                OptionRowView(
                    preview: BubblePreviewView(color: color),
                    previewSize: BubblePreviewLayout.size,
                    title: Strings.SettingsAppearance.bubbleColorName(color.rawValue),
                    selected: color == bubbleColor
                ) { [weak self] in
                    self?.openDropdown = nil
                    self?.set("userMessageBubbleColor", .string(color.rawValue))
                    self?.rebuild()
                }
            }))
        }
        sections.append(ItemGroupView(title: Strings.SettingsAppearance.chat, footer: Strings.SettingsAppearance.chatDescription, rows: chatRows))
        // `showDivider={open}`: the line under the row only while it is open.
        bubbleRow.showsDivider = bubbleOpen

        sections.append(ItemGroupView(title: Strings.SettingsAppearance.avatars, rows: [toggle(
            "avatarMonochrome",
            title: Strings.SettingsAppearance.avatarMonochrome,
            subtitle: Strings.SettingsAppearance.avatarMonochromeDescription,
            icon: "contrast-outline",
            tint: connecting
        ), toggles.row(
            LiveAvatars.key,
            title: Strings.LiveAvatars.title,
            subtitle: Strings.LiveAvatars.description,
            icon: ItemIcon(.ionicons("sparkles-outline"), tint: purple),
            isOn: LiveAvatars.isEnabled
        ) { on in
            LiveAvatars.isEnabled = on
        }]))

        let contextSize = toggle(
            "alwaysShowContextSize",
            title: Strings.SettingsAppearance.alwaysShowContextSize,
            subtitle: Strings.SettingsAppearance.alwaysShowContextSizeDescription,
            icon: "analytics-outline",
            tint: purple
        )
        sections.append(ItemGroupView(title: Strings.SettingsAppearance.input, footer: Strings.SettingsAppearance.inputDescription, rows: [contextSize]))
        // ItemGroup counts the empty web-only slot after it, so the row keeps
        // its divider on iOS.
        contextSize.showsDivider = true

        let grouping = settings.sessionListGrouping
        sections.append(ItemGroupView(title: Strings.SettingsAppearance.display, footer: Strings.SettingsAppearance.displayDescription, rows: [
            ItemRowView(
                title: Strings.SessionsFilter.groupingTitle,
                detail: grouping == .project ? Strings.SessionsFilter.groupByProject : Strings.SessionsFilter.flatList,
                icon: ItemIcon(.ionicons("list-outline"), tint: purple)
            ) { [weak self] in
                self?.set("sessionListGrouping", .string(grouping == .project ? SessionListGrouping.flat.rawValue : SessionListGrouping.project.rawValue))
                self?.rebuild()
            },
            toggle(
                "compactToolCalls",
                title: Strings.SettingsAppearance.compactToolCalls,
                subtitle: Strings.SettingsAppearance.compactToolCallsDescription,
                icon: "contract-outline",
                tint: purple
            ),
            toggle(
                "fileDiffsSidebar",
                title: Strings.SettingsAppearance.fileDiffsSidebar,
                subtitle: Strings.SettingsAppearance.fileDiffsSidebarDescription,
                icon: "git-branch-outline",
                tint: Palette.iconTeal
            ),
            toggle(
                "groupToolCalls",
                title: Strings.SettingsFeatures.groupToolCalls,
                subtitle: Strings.SettingsFeatures.groupToolCallsSubtitle,
                icon: "layers-outline",
                tint: Palette.iconViolet
            ),
            toggle(
                "showLineNumbersInToolViews",
                title: Strings.SettingsAppearance.showLineNumbersInToolViews,
                subtitle: Strings.SettingsAppearance.showLineNumbersInToolViewsDescription,
                icon: "code-working-outline",
                tint: purple
            ),
            toggle(
                "showHarnessIconInSessionHeader",
                title: Strings.SettingsAppearance.showHarnessIconInSessionHeader,
                subtitle: Strings.SettingsAppearance.showHarnessIconInSessionHeaderDescription,
                icon: "apps-outline",
                tint: purple
            ),
            toggle(
                "showFlavorIcons",
                title: Strings.SettingsAppearance.showHarnessIconsInSessionList,
                subtitle: Strings.SettingsAppearance.showHarnessIconsInSessionListDescription,
                icon: "apps-outline",
                tint: purple
            ),
        ]))
        list.sections = sections
    }

    /// Opens the dropdown, or closes it when it is open.
    private func toggleDropdown(_ dropdown: Dropdown) {
        openDropdown = openDropdown == dropdown ? nil : dropdown
        rebuild()
    }

    /// Adaptive, Light, Dark, and round again. The choice stays on this
    /// device.
    private func cycleTheme() {
        ThemeController.set(context.account.localSettings.themePreference.next, in: context)
        rebuild()
    }

    private static func themeName(_ theme: ThemePreference) -> String {
        switch theme {
        case .adaptive: Strings.SettingsAppearance.themeAdaptive
        case .light: Strings.SettingsAppearance.themeLight
        case .dark: Strings.SettingsAppearance.themeDark
        }
    }

    private static func themeDescription(_ theme: ThemePreference) -> String {
        switch theme {
        case .adaptive: Strings.SettingsAppearance.themeAdaptiveDescription
        case .light: Strings.SettingsAppearance.themeLightDescription
        case .dark: Strings.SettingsAppearance.themeDarkDescription
        }
    }
}
#endif
