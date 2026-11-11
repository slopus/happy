import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Happy Cloud's welcome (CloudWelcomeViewController), laid out as the
/// first screen is so the two read as one flow: desktop's Cloud slides in
/// the first screen's gallery at its place, Continue with Apple where Start
/// is and Sign in with GitHub where Use Happy Cloud is under it (12 under,
/// at least 24 above the bottom inset, Apple's rising to make room), both
/// as wide as the wider. A note (the account's sign-in has ended, or why a
/// sign-in failed) sits 12 over Apple's, and the slides centre again over
/// it all.
public struct CloudWelcomeLayout: Equatable, Sendable {
    public enum Metrics {
        /// Between the note and the button under it.
        public static let noteGap: CGFloat = 12
    }

    /// The first screen's layout with the two buttons as Start and Use
    /// Happy Cloud: the gallery, its pages and dots, and the scrolled
    /// content's height.
    public var start: StartLayout
    /// Continue with Apple.
    public var button: CGRect
    /// Sign in with GitHub, under it.
    public var secondary: CGRect
    /// The note over the buttons; zero without one.
    public var note: CGRect

    /// `safeArea` is the first screen's (without this one's bar, which
    /// sits over the first screen's top row). `button` and `secondary` are
    /// the two buttons' own sizes.
    public init(size: CGSize, safeArea: LayoutInsets, button buttonSize: CGSize, secondary: CGSize, note: Measurable? = nil,
                slides: [StartLayout.Slide], dots: CGSize) {
        let width = max(0, size.width - safeArea.horizontal)
        let column = min(StartLayout.Metrics.columnMaxWidth, max(0, width - StartLayout.Metrics.sidePadding * 2))
        let noteSize = note?.size(fitting: column) ?? .zero
        let noteRoom = noteSize.height > 0 ? noteSize.height + Metrics.noteGap : 0
        // The note and Apple's button are one block where Start is.
        start = StartLayout(size: size, safeArea: safeArea, button: CGSize(width: buttonSize.width, height: buttonSize.height + noteRoom),
                            cloud: secondary, slides: slides, dots: dots)
        let block = start.button
        button = CGRect(x: block.minX, y: block.maxY - buttonSize.height, width: block.width, height: buttonSize.height)
        self.secondary = start.cloud
        self.note = noteSize.height > 0
            ? CGRect(x: safeArea.left + (width - column) / 2, y: block.minY, width: column, height: noteSize.height)
            : .zero
    }
}

/// One of Happy Cloud's steps after its welcome (CloudStageViewController):
/// optional art, a title, a line, what the step holds, and its actions at
/// the bottom, all in the slides' column (24 in from the safe area, at most
/// 440):
///
///     art                        a scene's square, when there is one
///     24
///     title
///     12
///     line                       when there is one
///     32
///     content                    when there is any
///     24 at least
///     actions                    16 above the bottom inset (or 16 above
///                                the screen's edge where there is none)
///
/// What is above the actions is centred in the room over them, as
/// desktop's centred setup pages are. The actions ride the keyboard; the
/// rest rises only as much as it must to stay clear of them, never above
/// its top margin, and past that the screen scrolls.
public struct CloudStageLayout: Equatable, Sendable {
    public enum Metrics {
        public static let sidePadding: CGFloat = StartLayout.Metrics.sidePadding
        public static let columnMaxWidth: CGFloat = StartLayout.Metrics.columnMaxWidth
        public static let top: CGFloat = 24
        public static let artGap: CGFloat = 24
        public static let titleGap: CGFloat = 12
        public static let bodyGap: CGFloat = 32
        public static let actionsGap: CGFloat = 24
        /// Under the actions: above the bottom inset, at least this far
        /// from the screen's edge, and above the keyboard.
        public static let bottomPadding: CGFloat = 16
        /// Between a filled action and the next one; a text action under a
        /// filled one sits closer (`textActionGap`).
        public static let actionGap: CGFloat = 12
        public static let textActionGap: CGFloat = 4
    }

    /// One action at the bottom: its height at the column's width and the
    /// gap above it (ignored for the first).
    public struct Action: Equatable, Sendable {
        public var height: CGFloat
        public var gap: CGFloat

        public init(height: CGFloat, gap: CGFloat = Metrics.actionGap) {
            self.height = height
            self.gap = gap
        }
    }

    public var art: CGRect
    public var title: CGRect
    public var body: CGRect
    public var content: CGRect
    public var actions: [CGRect]
    /// The scrolled content's height.
    public var contentHeight: CGFloat
    /// How far the keyboard covers the scroll view, for its bottom inset.
    public var keyboardInset: CGFloat

    /// The column's width in a window this size: what the step's own parts
    /// and its actions are measured at.
    public static func column(size: CGSize, safeArea: LayoutInsets) -> CGFloat {
        min(Metrics.columnMaxWidth, max(0, size.width - safeArea.horizontal - Metrics.sidePadding * 2))
    }

    /// `safeArea` includes the bar. `keyboardTop` is the keyboard's top in
    /// the view, the safe area's bottom while it is down. `art` is the
    /// scene's side, zero without one; an empty `body` or `content`
    /// measures zero tall and takes no gap.
    public init(size: CGSize, safeArea: LayoutInsets, keyboardTop: CGFloat? = nil, art side: CGFloat = 0,
                title: Measurable, body: Measurable, content: Measurable, actions: [Action]) {
        typealias M = Metrics
        let width = max(0, size.width - safeArea.horizontal)
        let column = Self.column(size: size, safeArea: safeArea)
        let x = safeArea.left + (width - column) / 2
        let titleHeight = title.height(fitting: column)
        let bodyHeight = body.height(fitting: column)
        let contentHeight = content.height(fitting: column)

        var block = titleHeight
        if side > 0 { block += side + M.artGap }
        if bodyHeight > 0 { block += M.titleGap + bodyHeight }
        if contentHeight > 0 { block += M.bodyGap + contentHeight }
        let actionsHeight = actions.enumerated().reduce(CGFloat(0)) { $0 + $1.element.height + ($1.offset > 0 ? $1.element.gap : 0) }

        let edge = max(safeArea.bottom, M.bottomPadding)
        let resting = size.height - edge - M.bottomPadding
        let bottom = min(resting, (keyboardTop ?? size.height) - M.bottomPadding)
        let minTop = safeArea.top + M.top
        // Centred over the actions while the keyboard is down…
        let free = resting - actionsHeight - M.actionsGap - minTop - block
        var y = minTop + max(0, free / 2)
        // …and lifted only as far as the keyboard's actions need.
        let over = y + block + M.actionsGap - (bottom - actionsHeight)
        if over > 0 { y = max(minTop, y - over) }

        art = side > 0 ? CGRect(x: safeArea.left + (width - side) / 2, y: y, width: side, height: side) : .zero
        if side > 0 { y += side + M.artGap }
        self.title = CGRect(x: x, y: y, width: column, height: titleHeight)
        y += titleHeight
        if bodyHeight > 0 { y += M.titleGap }
        self.body = CGRect(x: x, y: y, width: column, height: bodyHeight)
        y += bodyHeight
        if contentHeight > 0 { y += M.bodyGap }
        self.content = CGRect(x: x, y: y, width: column, height: contentHeight)
        y += contentHeight

        var top = max(y + M.actionsGap, bottom - actionsHeight)
        if actions.isEmpty { top = y }
        var frames: [CGRect] = []
        for (index, action) in actions.enumerated() {
            if index > 0 { top += action.gap }
            frames.append(CGRect(x: x, y: top, width: column, height: action.height))
            top += action.height
        }
        self.actions = frames
        self.contentHeight = max(size.height, top + edge + M.bottomPadding)
        keyboardInset = keyboardTop.map { max(0, size.height - $0 - edge) } ?? 0
    }
}

/// A step's own part, top to bottom in the column: rows, fields, a status
/// line, quiet links. Each item is as wide as the column, or its own width
/// centred.
public enum CloudColumnLayout {
    public struct Item: Equatable, Sendable {
        public var size: CGSize
        /// Above it; ignored for the first item.
        public var gap: CGFloat
        /// Its own width, centred, rather than the column's.
        public var centred: Bool

        public init(height: CGFloat, gap: CGFloat = 12) {
            self.init(size: CGSize(width: 0, height: height), gap: gap, centred: false)
        }

        public init(size: CGSize, gap: CGFloat = 12, centred: Bool) {
            self.size = size
            self.gap = gap
            self.centred = centred
        }
    }

    /// Each item's frame and the whole height. An item zero tall takes no
    /// room and no gap, so a part that is hidden leaves nothing behind.
    public static func stack(_ items: [Item], width: CGFloat) -> (frames: [CGRect], height: CGFloat) {
        var y: CGFloat = 0
        var placed = false
        var frames: [CGRect] = []
        for item in items {
            guard item.size.height > 0 else {
                frames.append(CGRect(x: 0, y: y, width: item.centred ? item.size.width : width, height: 0))
                continue
            }
            if placed { y += item.gap }
            let itemWidth = item.centred ? min(width, item.size.width) : width
            frames.append(CGRect(x: (width - itemWidth) / 2, y: y, width: itemWidth, height: item.size.height))
            y += item.size.height
            placed = true
        }
        return (frames, y)
    }
}

/// A server in Join a server's list (desktop's server row): its picture,
/// its name over `@name`, and Join, or Joined, at the right.
public struct CloudServerRowLayout: Equatable, Sendable {
    public enum Metrics {
        public static let height: CGFloat = 76
        public static let picture: CGFloat = 48
        public static let padding: CGFloat = 14
        public static let gap: CGFloat = 12
        public static let titleHeight: CGFloat = 22
        public static let subtitleHeight: CGFloat = 20
        /// Join's width, desktop's 104, at least its label's.
        public static let buttonWidth: CGFloat = 104
    }

    public var picture: CGRect
    public var title: CGRect
    public var subtitle: CGRect
    public var button: CGRect

    /// `button` is Join's (or Joined's) own size.
    public init(width: CGFloat, button buttonSize: CGSize) {
        typealias M = Metrics
        let height = M.height
        picture = CGRect(x: M.padding, y: (height - M.picture) / 2, width: M.picture, height: M.picture)
        let buttonWidth = max(M.buttonWidth, buttonSize.width)
        button = CGRect(x: width - M.padding - buttonWidth, y: (height - buttonSize.height) / 2, width: buttonWidth, height: buttonSize.height)
        let textX = picture.maxX + M.gap
        let textWidth = max(0, button.minX - M.gap - textX)
        let textTop = (height - M.titleHeight - M.subtitleHeight) / 2
        title = CGRect(x: textX, y: textTop, width: textWidth, height: M.titleHeight)
        subtitle = CGRect(x: textX, y: title.maxY, width: textWidth, height: M.subtitleHeight)
    }
}
