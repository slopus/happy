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
///
/// The releases are laid out off the main thread (`ChangelogPlan`) at the
/// list's width and text size, and the main thread only places and draws
/// them. The first screenful is planned on its own first, so it is in as
/// the screen slides in, then all of them; a new width or text size plans
/// them all again, and the old plan stays drawn until the new one is in.
/// Only releases near the screen draw their text (`DrawnSections`).
public final class ChangelogViewController: UIViewController, UIScrollViewDelegate {
    private let readMarker: ChangelogReadMarker
    private let changelog: Changelog
    private var list: GroupedListView?
    private(set) var entryViews: [ChangelogEntryView] = []
    private var drawn: Set<Int> = []
    /// The plan the entries show, without its first-screen limit, and how
    /// many of its releases they have.
    private(set) var shown: (input: ChangelogPlan.Input, count: Int)?
    private(set) lazy var plans: OffMainPlan<ChangelogPlan.Input, ChangelogPlan> = {
        let entries = changelog.entries
        let plans = OffMainPlan<ChangelogPlan.Input, ChangelogPlan> { ChangelogPlan.make($0, entries: entries) }
        plans.onApply = { [weak self] in self?.applyPlan() }
        return plans
    }()

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
        // Empty until their plan is in: nothing here measures text.
        entryViews = changelog.entries.map { _ in ChangelogEntryView() }
        let list = GroupedListView(sections: entryViews)
        list.delegate = self
        self.list = list
        view = list
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
        registerForTraitChanges(UIView.textSizeTraits) { (self: Self, _) in
            self.view.setNeedsLayout()
        }
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Every scroll frame lays the list out: only a new size, text size
        // or content asks for anything here.
        guard let list else { return }
        let key = LayoutKey(
            size: list.bounds.size,
            safeArea: list.safeAreaInsets,
            category: list.traitCollection.preferredContentSizeCategory,
            follows: list.traitCollection[FollowsTextSize.self],
            scale: list.traitCollection.displayScale,
            content: list.contentSize
        )
        guard key != laidOut else { return }
        laidOut = key
        requestPlan()
        updateDrawn()
    }

    private struct LayoutKey: Equatable {
        var size: CGSize
        var safeArea: UIEdgeInsets
        var category: UIContentSizeCategory
        var follows: Bool
        var scale: CGFloat
        var content: CGSize
    }

    private var laidOut: LayoutKey?

    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
        updateDrawn()
    }

    /// Asks for the plan at the list's width and text size, unless it is
    /// the one shown or on its way. With nothing shown, the first screen
    /// comes first, then the releases after it.
    private func requestPlan() {
        guard let list, list.bounds.width > 0 else { return }
        let geometry = ChangelogPlan.Input(
            width: GroupedListLayout.contentWidth(size: list.bounds.size, safeArea: LayoutInsets(list.safeAreaInsets)),
            text: list.traitCollection.measuredTextEnvironment,
            maxWidth: ContentWidth.maxWidth
        )
        if let requested = plans.requested, requested.geometry == geometry, !plans.isCurrent { return }
        var input = geometry
        if let shown, shown.input == geometry {
            guard shown.count < entryViews.count else { return }
            input.from = shown.count
        } else if shown == nil {
            input.enough = list.bounds.height
        }
        plans.request(input)
    }

    private func applyPlan() {
        guard let plan = plans.plan else { return }
        let geometry = plan.input.geometry
        let from = plan.input.from
        let to = min(entryViews.count, from + plan.entries.count)
        ApplyPerf.measure(.screen) {
            for index in from..<max(from, to) {
                entryViews[index].plan = plan.entries[index - from]
            }
            return max(0, to - from)
        }
        shown = (geometry, max(to, shown?.input == geometry ? shown?.count ?? 0 : 0))
        requestPlan()
    }

    /// Text is drawn near the screen only (`DrawnSections`).
    private func updateDrawn() {
        guard let list else { return }
        var frames: [CGRect] = []
        frames.reserveCapacity(entryViews.count)
        for view in entryViews { frames.append(view.frame) }
        let next = DrawnSections.update(drawn, frames: frames, visible: list.bounds)
        guard next != drawn else { return }
        for (index, view) in entryViews.enumerated() {
            view.drawsText = next.contains(index)
        }
        drawn = next
    }
}
#endif
