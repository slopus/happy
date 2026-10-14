#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// What the home list's rows and notices are drawn with at one text size
/// on one screen: one line of each style as its label draws it, the glyph
/// boxes and the hairline. Made off the main thread from the text
/// environment alone, which is everything in it that comes from the text
/// size and the screen; equal text environments make equal values.
struct HomeTextEnvironment: Equatable, Sendable {
    /// The text size and screen scale this was made for.
    let text: TextEnvironment
    let rows: HomeRowMetrics
    /// One line of an Item's title (`TextStyles.itemTitle`).
    let bannerTitleLine: CGFloat
    /// An Item's subtitle, which wraps; drawn at `text`.
    let bannerSubtitleStyle: TextStyle
    /// The Item's chevron box.
    let chevron: CGSize

    /// Off the main thread: the lines are worked out from the styles'
    /// fonts at this size (`TextStyle.oneLine(in:)`).
    nonisolated init(_ text: TextEnvironment) {
        #if DEBUG
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
        // IconView's `layoutScale`, and the cells' hairline.
        let scale = text.displayScale
        func icon(_ name: String, _ size: CGFloat) -> CGSize {
            Icon.ionicons(name).layout(size: size, scale: scale)?.size ?? CGSize(width: size, height: size)
        }
        func line(_ style: TextStyle) -> CGFloat {
            style.oneLine(in: text)
        }
        self.text = text
        rows = HomeRowMetrics(
            dayHeaderLine: line(TextStyles.sessionDayHeader),
            archiveToggleLine: line(TextStyles.archiveToggle),
            machineLine: line(TextStyles.projectMachine),
            sectionLine: line(TextStyles.projectSection),
            machineIcon: icon("desktop-outline", 12),
            hairline: 1 / max(scale, 1),
            sessionLines: FlatSessionRowLayout.Lines(
                title: line(TextStyles.sessionTitle),
                project: line(TextStyles.sessionProject),
                workspace: line(TextStyles.sessionWorkspace),
                changes: line(TextStyles.sessionLineChanges)
            ),
            branchIcon: icon("git-branch-outline", FlatSessionRowLayout.Metrics.branchIconSize)
        )
        bannerTitleLine = line(TextStyles.itemTitle)
        bannerSubtitleStyle = TextStyles.itemSubtitle
        chevron = icon("chevron-forward", 17)
    }

    /// Made off the main thread and handed back.
    static func make(_ text: TextEnvironment) async -> HomeTextEnvironment {
        await Task.detached(priority: .userInitiated) { HomeTextEnvironment(text) }.value
    }
}

/// The notices over the home list (HomeListHeaderView's input), with the
/// words each one shows. The words are read where the banners are decided,
/// on the main thread, in the screens' language; measuring the header off
/// the main thread reads no strings, the header draws these same words,
/// and a change of words is a new value.
struct HomeBanners: Hashable, Sendable {
    struct Notice: Hashable, Sendable {
        enum Kind: Hashable, Sendable {
            /// OfflineMachinesBanner: opens Troubleshoot.
            case offline
            /// UpdateBanner's store link.
            case nativeUpdate
            /// UpdateBanner's What's new.
            case whatsNew
        }

        var kind: Kind
        var title: String
        var subtitle: String
    }

    /// OfflineMachinesBanner's title; nil hides the plaque.
    let offlineTitle: String?
    let nativeUpdate: Bool
    let whatsNew: Bool
    /// Each notice's title and subtitle, in HomeListHeaderView's order: the
    /// plaque, then the store update or else What's new.
    let notices: [Notice]

    @MainActor
    init(offlineTitle: String? = nil, nativeUpdate: Bool = false, whatsNew: Bool = false) {
        self.offlineTitle = offlineTitle
        self.nativeUpdate = nativeUpdate
        self.whatsNew = whatsNew
        var notices: [Notice] = []
        if let offlineTitle { notices.append(Notice(kind: .offline, title: offlineTitle, subtitle: Strings.Troubleshoot.bannerSubtitle)) }
        if nativeUpdate {
            notices.append(Notice(kind: .nativeUpdate, title: Strings.Home.nativeUpdateAvailable, subtitle: Strings.Home.tapToUpdateAppStore))
        } else if whatsNew {
            notices.append(Notice(kind: .whatsNew, title: Strings.Home.whatsNew, subtitle: Strings.Home.seeLatest))
        }
        self.notices = notices
    }

    var isEmpty: Bool { notices.isEmpty }
}

/// Home list heights without views: the rows, from their kinds and the
/// lines of a `HomeTextEnvironment`, and the notices above them, measured
/// off the main thread. Synchronous and free of shared state; every
/// TextKit object lives for one call.
enum HomeRowMeasurer {
    nonisolated static func heights(_ kinds: [HomeRowKind], width: CGFloat, environment: HomeTextEnvironment) -> [CGFloat] {
        kinds.map { HomeRowHeights.height($0, width: width, metrics: environment.rows) }
    }

    nonisolated static func height(_ kind: HomeRowKind, width: CGFloat, environment: HomeTextEnvironment) -> CGFloat {
        HomeRowHeights.height(kind, width: width, metrics: environment.rows)
    }

    /// The table header's height; 0 when there are no notices. `maxWidth`
    /// is `ContentWidth.maxWidth`, how wide a notice's group may grow.
    nonisolated static func headerHeight(_ banners: HomeBanners, width: CGFloat, maxWidth: CGFloat, environment: HomeTextEnvironment) -> CGFloat {
        let notices = banners.notices.map { notice in
            HomeBannerHeights.Banner(
                // One line beside a subtitle (ItemRowView).
                title: .fixed(width: 0, height: notice.title.isEmpty ? 0 : environment.bannerTitleLine),
                subtitle: subtitle(notice.subtitle, environment: environment)
            )
        }
        return HomeBannerHeights.header(notices, width: width, maxWidth: maxWidth, chevron: environment.chevron)
    }

    /// An Item's subtitle as its label draws it: two lines with the last
    /// one cut short, unless the text sets its own breaks.
    nonisolated static func subtitle(_ text: String, environment: HomeTextEnvironment) -> Measurable {
        let maxLines = text.contains("\n") ? 0 : 2
        return Measurable { width in
            measure(text, style: environment.bannerSubtitleStyle, in: environment.text, width: width, maxLines: maxLines)
        }
    }

    /// Text in a style at a text size, wrapped at `width` the way Chat's
    /// `ChatTextLayout` does: TextKit 1, no line padding, the used rect up
    /// to the screen's next pixel, as a label measures it.
    nonisolated static func measure(_ text: String, style: TextStyle, in environment: TextEnvironment, width: CGFloat, maxLines: Int) -> CGSize {
        guard !text.isEmpty else { return .zero }
        var attributes = style.scaled(environment.scale).attributes(color: .black, lineBreakMode: .byWordWrapping)
        attributes[.font] = style.font(in: environment)
        let storage = NSTextStorage(string: style.uppercase ? text.uppercased() : text, attributes: attributes)
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: max(0, width), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        container.maximumNumberOfLines = maxLines
        if maxLines > 0 { container.lineBreakMode = .byTruncatingTail }
        manager.addTextContainer(container)
        storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container)
        let pixels = max(environment.displayScale, 1)
        func ceiled(_ value: CGFloat) -> CGFloat { (value * pixels).rounded(.up) / pixels }
        return CGSize(width: min(ceiled(used.width), max(0, width)), height: ceiled(used.height))
    }
}
#endif
