#if canImport(UIKit)
import HappyIcons
import HappyLayout
import UIKit

/// What the home list's headings and notices are drawn with: the fonts,
/// line heights, glyph boxes and content width of this screen. Built on the
/// main thread when the traits change and kept; immutable after, so the
/// measurer may read it from any thread. Equal environments give equal
/// heights; a new font or scale is a new environment.
struct HomeTextEnvironment: Equatable, @unchecked Sendable {
    /// The screen's scale the glyph boxes and hairline are for.
    let scale: CGFloat
    let rows: HomeRowMetrics
    /// `ContentWidth.maxWidth`: how wide a notice's group may grow.
    let maxWidth: CGFloat
    /// One line of an Item's title (`TextStyles.itemTitle`).
    let bannerTitleLine: CGFloat
    /// An Item's subtitle, which wraps.
    let bannerSubtitleStyle: TextStyle
    let bannerSubtitleFont: UIFont
    /// The Item's chevron box.
    let chevron: CGSize

    /// This screen's environment. Cheap: a few fonts and two glyph boxes.
    @MainActor
    static func current(scale: CGFloat) -> HomeTextEnvironment {
        // IconView's `layoutScale`, and the cells' hairline.
        let scale = scale > 0 ? scale : UIGraphicsImageRendererFormat.preferred().scale
        func icon(_ name: String, _ size: CGFloat) -> CGSize {
            Icon.ionicons(name).layout(size: size, scale: scale)?.size ?? CGSize(width: size, height: size)
        }
        return HomeTextEnvironment(
            scale: scale,
            rows: HomeRowMetrics(
                dayHeaderLine: TextStyles.sessionDayHeader.lineHeightValue,
                archiveToggleLine: TextStyles.archiveToggle.lineHeightValue,
                machineLine: TextStyles.projectMachine.lineHeightValue,
                sectionLine: TextStyles.projectSection.lineHeightValue,
                machineIcon: icon("desktop-outline", 12),
                hairline: 1 / max(scale, 1)
            ),
            maxWidth: ContentWidth.maxWidth,
            bannerTitleLine: TextStyles.itemTitle.lineHeightValue,
            bannerSubtitleStyle: TextStyles.itemSubtitle,
            bannerSubtitleFont: TextStyles.itemSubtitle.font,
            chevron: icon("chevron-forward", 17)
        )
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.scale == rhs.scale
            && lhs.rows == rhs.rows
            && lhs.maxWidth == rhs.maxWidth
            && lhs.bannerTitleLine == rhs.bannerTitleLine
            && lhs.bannerSubtitleStyle == rhs.bannerSubtitleStyle
            && lhs.bannerSubtitleFont.fontName == rhs.bannerSubtitleFont.fontName
            && lhs.bannerSubtitleFont.pointSize == rhs.bannerSubtitleFont.pointSize
            && lhs.chevron == rhs.chevron
    }
}

/// The notices over the home list (HomeListHeaderView's inputs).
struct HomeBanners: Hashable, Sendable {
    /// OfflineMachinesBanner's title; nil hides the plaque.
    var offlineTitle: String?
    var nativeUpdate: Bool
    var whatsNew: Bool

    init(offlineTitle: String? = nil, nativeUpdate: Bool = false, whatsNew: Bool = false) {
        self.offlineTitle = offlineTitle
        self.nativeUpdate = nativeUpdate
        self.whatsNew = whatsNew
    }

    var isEmpty: Bool { offlineTitle == nil && !nativeUpdate && !whatsNew }

    /// Each notice's title and subtitle, in HomeListHeaderView's order: the
    /// plaque, then the store update or else What's new.
    var notices: [(title: String, subtitle: String)] {
        var notices: [(title: String, subtitle: String)] = []
        if let offlineTitle { notices.append((offlineTitle, Strings.Troubleshoot.bannerSubtitle)) }
        if nativeUpdate {
            notices.append((Strings.Home.nativeUpdateAvailable, Strings.Home.tapToUpdateAppStore))
        } else if whatsNew {
            notices.append((Strings.Home.whatsNew, Strings.Home.seeLatest))
        }
        return notices
    }
}

/// Home list heights without views, for the background derivation: the
/// rows other than flat sessions, and the notices above them. Synchronous
/// and free of shared state; every TextKit object lives for one call.
enum HomeRowMeasurer {
    nonisolated static func heights(_ kinds: [HomeRowKind], width: CGFloat, environment: HomeTextEnvironment) -> [CGFloat] {
        kinds.map { HomeRowHeights.height($0, width: width, metrics: environment.rows) }
    }

    nonisolated static func height(_ kind: HomeRowKind, width: CGFloat, environment: HomeTextEnvironment) -> CGFloat {
        HomeRowHeights.height(kind, width: width, metrics: environment.rows)
    }

    /// The table header's height; 0 when there are no notices.
    nonisolated static func headerHeight(_ banners: HomeBanners, width: CGFloat, environment: HomeTextEnvironment) -> CGFloat {
        let notices = banners.notices.map { notice in
            HomeBannerHeights.Banner(
                // One line beside a subtitle (ItemRowView).
                title: .fixed(width: 0, height: notice.title.isEmpty ? 0 : environment.bannerTitleLine),
                subtitle: subtitle(notice.subtitle, environment: environment)
            )
        }
        return HomeBannerHeights.header(notices, width: width, maxWidth: environment.maxWidth, chevron: environment.chevron)
    }

    /// An Item's subtitle as its label draws it: two lines with the last
    /// one cut short, unless the text sets its own breaks.
    nonisolated static func subtitle(_ text: String, environment: HomeTextEnvironment) -> Measurable {
        let maxLines = text.contains("\n") ? 0 : 2
        return Measurable { width in
            measure(text, style: environment.bannerSubtitleStyle, font: environment.bannerSubtitleFont, width: width, maxLines: maxLines)
        }
    }

    /// Text in a style, wrapped at `width` the way Chat's `ChatTextLayout`
    /// does: TextKit 1, no line padding, the used rect rounded up.
    nonisolated static func measure(_ text: String, style: TextStyle, font: UIFont, width: CGFloat, maxLines: Int) -> CGSize {
        guard !text.isEmpty else { return .zero }
        var attributes = style.attributes(color: .black, lineBreakMode: .byWordWrapping)
        attributes[.font] = font
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
        return CGSize(width: min(ceil(used.width), max(0, width)), height: ceil(used.height))
    }
}
#endif
