#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Settings › Connected Accounts › Claude Code
/// (app/(app)/settings/connect/claude.tsx). happy-app's OAuth flow is
/// commented out; the page tells you to connect from a terminal.
public final class SettingsConnectClaudeViewController: UIViewController {
    public override func loadView() {
        followsTextSize()
        view = ConnectCommandView(
            title: Strings.ConnectClaude.title,
            body: Strings.ConnectClaude.instruction,
            command: Strings.ConnectClaude.command
        )
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.SettingsTitles.connectClaude
        showsBackTitle()
    }
}

/// What's New (app/(app)/changelog.tsx): one card per release, newest
/// first. Opening it marks the newest one read.
public final class ChangelogViewController: UIViewController {
    private let readMarker: ChangelogReadMarker
    private let changelog: Changelog

    /// `readMarker` defaults to the app's standard defaults, where Home's
    /// update banner looks too.
    public init(readMarker: ChangelogReadMarker = ChangelogReadMarker(storage: UserDefaultsStore(suiteName: ChangelogReadMarker.suiteName))) {
        self.readMarker = readMarker
        self.changelog = Self.bundled
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// The changelog this build ships, or none if it can't be read.
    static let bundled: Changelog = {
        guard let url = Bundle.module.url(forResource: "changelog", withExtension: "json")
            ?? Bundle.module.url(forResource: "changelog", withExtension: "json", subdirectory: "Content"),
            let data = try? Data(contentsOf: url),
            let changelog = try? Changelog.decode(data) else {
            return Changelog(entries: [], latestTitle: "")
        }
        return changelog
    }()

    public override func loadView() {
        guard !changelog.entries.isEmpty else {
            view = CenteredMessageView(
                message: Strings.Changelog.noEntriesAvailable,
                style: TextStyles.changelogEmpty,
                color: Palette.textSecondary
            )
            return
        }
        view = GroupedListView(sections: changelog.entries.map { entry in
            let group = ItemGroupView(title: entry.title, rows: [ChangelogCardView(entry: entry)])
            // The release title is a heading, not ItemGroup's small caps.
            group.headerLabel.style = TextStyles.changelogTitle
            group.headerLabel.color = Palette.text
            return group
        })
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        // Header.tsx's title, which scales; the picture doesn't.
        let titleView = ChangelogTitleView(title: Strings.SettingsTitles.whatsNew)
        setScaledTitleView(titleView)
        title = Strings.SettingsTitles.whatsNew
        showsBackTitle()
        dropsBackButtonOnTablet() // Tablet (HappyUI/Tablet): navigation/Header.tsx
        if !changelog.latestTitle.isEmpty {
            readMarker.markViewed(changelog.latestTitle)
        }
    }
}
#endif
