import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The iPhone home header: MainView.tsx's phone header, drawn by
/// navigation/Header.tsx with headerMetrics.ts on a native phone.
///
///     |16| (logo) ……… Sessions ……… ( ⏷ │ ⚙ ) |16|
///                     ● connecting
///
/// It floats over the content, which scrolls under it, inside a 52pt row
/// below the status bar:
///   - the logo sits in a 44pt glass circle on the left (`HeaderLogo`, a
///     19pt mark in a 32pt box);
///   - the filter menu and settings share one glass pill on the right,
///     split by a 22pt hairline. The pill's 1pt rim is drawn outside the
///     44pt buttons, so it is 46 tall where the circle is 44;
///   - the title is centred between 64pt insets (`centeredTitleContainer`)
///     and the status line hangs 2pt into the title's bottom, outside the
///     centring (HomeHeaderTitle.tsx `subtitleSlot`).
/// A scrim reaches 8pt below the row.
public struct HomeHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        /// MOBILE_GLASS_HEADER_HEIGHT.
        public static let contentHeight: CGFloat = 52
        public static let paddingHorizontal: CGFloat = 16
        /// MOBILE_GLASS_CONTROL_SIZE.
        public static let controlSize: CGFloat = 44
        public static let controlBorder: CGFloat = 1
        /// HeaderLogo.tsx.
        public static let logoBox: CGFloat = 32
        public static let logoSize: CGFloat = 19
        public static let actionDividerHeight: CGFloat = 22
        /// Header.tsx `centeredTitleContainer`.
        public static let titleInset: CGFloat = 64
        public static let statusMarginTop: CGFloat = -2
        public static let statusMinHeight: CGFloat = 16
        public static let statusDotSize: CGFloat = 6
        public static let statusDotGap: CGFloat = 4
        /// `headerBackdropHome`'s `bottom: -8`.
        public static let backdropOverhang: CGFloat = 8
        /// MainView.tsx: content starts 12 below the chrome.
        public static let contentGap: CGFloat = 12
    }

    public struct Input {
        public var width: CGFloat
        public var safeTop: CGFloat
        /// One device pixel (`StyleSheet.hairlineWidth`).
        public var hairline: CGFloat
        public var title: Measurable
        /// The status text, when the socket is not connected.
        public var status: Measurable?

        public init(width: CGFloat, safeTop: CGFloat, hairline: CGFloat, title: Measurable, status: Measurable?) {
            self.width = width
            self.safeTop = safeTop
            self.hairline = hairline
            self.title = title
            self.status = status
        }
    }

    /// The header's own box: the status bar and the 52pt row.
    public var size: CGSize
    /// The scrim behind the controls, 8pt deeper than the header.
    public var backdrop: CGRect
    public var logoControl: CGRect
    public var logo: CGRect
    /// The right-hand glass pill, rim included.
    public var actions: CGRect
    public var filterButton: CGRect
    public var actionDivider: CGRect
    public var settingsButton: CGRect
    public var title: CGRect
    public var statusDot: CGRect?
    public var status: CGRect?

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        let top = input.safeTop
        let rowHeight = M.contentHeight

        size = CGSize(width: width, height: top + rowHeight)
        backdrop = CGRect(x: 0, y: 0, width: width, height: top + rowHeight + M.backdropOverhang)

        logoControl = CGRect(x: M.paddingHorizontal, y: top + (rowHeight - M.controlSize) / 2, width: M.controlSize, height: M.controlSize)
        let logoInset = M.controlBorder + (M.controlSize - 2 * M.controlBorder - M.logoBox) / 2 + (M.logoBox - M.logoSize) / 2
        logo = CGRect(x: logoControl.minX + logoInset, y: logoControl.minY + logoInset, width: M.logoSize, height: M.logoSize)

        let pillWidth = 2 * M.controlBorder + 2 * M.controlSize + input.hairline
        let pillHeight = 2 * M.controlBorder + M.controlSize
        actions = CGRect(x: width - M.paddingHorizontal - pillWidth, y: top + (rowHeight - pillHeight) / 2, width: pillWidth, height: pillHeight)
        let buttonY = actions.minY + M.controlBorder
        filterButton = CGRect(x: actions.minX + M.controlBorder, y: buttonY, width: M.controlSize, height: M.controlSize)
        actionDivider = CGRect(
            x: filterButton.maxX,
            y: buttonY + (M.controlSize - M.actionDividerHeight) / 2,
            width: input.hairline,
            height: M.actionDividerHeight
        )
        settingsButton = CGRect(x: actionDivider.maxX, y: buttonY, width: M.controlSize, height: M.controlSize)

        let slotX = M.titleInset
        let slotWidth = max(0, width - 2 * M.titleInset)
        let titleSize = input.title.size(fitting: slotWidth)
        let titleY = top + (rowHeight - titleSize.height) / 2
        title = CGRect(x: slotX + (slotWidth - titleSize.width) / 2, y: titleY, width: titleSize.width, height: titleSize.height)

        if let status = input.status {
            let text = status.size(fitting: max(0, slotWidth - M.statusDotSize - M.statusDotGap))
            let rowHeight = max(M.statusDotSize, text.height)
            let slotHeight = max(M.statusMinHeight, rowHeight)
            let slotY = titleY + titleSize.height + M.statusMarginTop
            let rowWidth = M.statusDotSize + M.statusDotGap + text.width
            let rowX = slotX + (slotWidth - rowWidth) / 2
            let rowY = slotY + (slotHeight - rowHeight) / 2
            statusDot = CGRect(x: rowX, y: rowY + (rowHeight - M.statusDotSize) / 2, width: M.statusDotSize, height: M.statusDotSize)
            self.status = CGRect(x: rowX + M.statusDotSize + M.statusDotGap, y: rowY + (rowHeight - text.height) / 2, width: text.width, height: text.height)
        } else {
            statusDot = nil
            self.status = nil
        }
    }
}

/// Where home's content sits under the floating header and above the dock
/// (MainView.tsx `topChromeInset`, `topContentInset`, `bottomContentInset`).
public struct HomeContentInsets: Equatable, Sendable {
    /// What the header covers: the status bar and the 52pt row. Scroll
    /// indicators start here.
    public var chromeTop: CGFloat
    /// Where content starts: 12 below the chrome.
    public var contentTop: CGFloat
    /// What the dock covers, without the home indicator
    /// (`MOBILE_HOME_DOCK_CONTENT_INSET`).
    public var dock: CGFloat
    /// The list's bottom padding: `safeArea.bottom + bottomContentInset`.
    public var listBottom: CGFloat

    public init(safeArea: LayoutInsets, dock: CGFloat) {
        chromeTop = safeArea.top + HomeHeaderLayout.Metrics.contentHeight
        contentTop = chromeTop + HomeHeaderLayout.Metrics.contentGap
        self.dock = dock
        listBottom = safeArea.bottom + dock
    }

    /// The safe area the empty states lay out in: they are padded by
    /// `topContentInset` and `bottomContentInset` alone.
    public var emptyStateSafeArea: LayoutInsets {
        LayoutInsets(top: contentTop, bottom: dock)
    }
}

extension HomeContentInsets {
    /// What a child screen's safe area must grow by so it sees
    /// `emptyStateSafeArea` inside a parent whose own is `safeArea`
    /// (`additionalSafeAreaInsets`). Never negative: a home indicator
    /// taller than the dock keeps its own inset.
    public func additionalSafeArea(over safeArea: LayoutInsets) -> LayoutInsets {
        let target = emptyStateSafeArea
        return LayoutInsets(
            top: max(0, target.top - safeArea.top),
            left: 0,
            bottom: max(0, target.bottom - safeArea.bottom),
            right: 0
        )
    }
}

/// Home as a whole: the content fills the screen and the header floats over
/// its top, scrim included.
public struct HomeScreenLayout: Equatable, Sendable {
    public var content: CGRect
    /// The header's box, as deep as its scrim.
    public var header: CGRect
    public var insets: HomeContentInsets

    public init(size: CGSize, safeArea: LayoutInsets, dock: CGFloat) {
        let width = max(0, size.width)
        content = CGRect(x: 0, y: 0, width: width, height: max(0, size.height))
        header = CGRect(
            x: 0,
            y: 0,
            width: width,
            height: safeArea.top + HomeHeaderLayout.Metrics.contentHeight + HomeHeaderLayout.Metrics.backdropOverhang
        )
        insets = HomeContentInsets(safeArea: safeArea, dock: dock)
    }
}
