import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Happy Cloud's welcome (CloudWelcomeViewController), laid out as the
/// first screen is so the two read as one flow: desktop's Cloud slides in
/// the first screen's gallery at its place, Continue with Apple where Start
/// is, Continue with Google 12 under it, and Sign in with GitHub where Use
/// Happy Cloud is under them (12 under, at least 24 above the bottom inset,
/// Apple's and Google's rising to make room), Continue with email 12 under
/// GitHub's when there is one, all as wide as the widest. A note (the
/// account's sign-in has ended, or why a sign-in failed) sits 12 over
/// Apple's. A note coming or going moves nothing: where the slides leave
/// room for `noteRoom` over the buttons it floats there, else that room is
/// kept under the slides whether or not there is a note.
public struct CloudWelcomeLayout: Equatable, Sendable {
    public enum Metrics {
        /// Between the note and the button under it.
        public static let noteGap: CGFloat = 12
        /// Between Apple's button and Google's.
        public static let googleGap: CGFloat = StartLayout.Metrics.buttonGap
    }

    /// The first screen's layout with Apple's and Google's buttons as Start
    /// and GitHub's as Use Happy Cloud: the gallery, its pages and dots,
    /// and the scrolled content's height.
    public var start: StartLayout
    /// Continue with Apple.
    public var button: CGRect
    /// Continue with Google, under it; zero without one.
    public var google: CGRect
    /// Sign in with GitHub, under them.
    public var secondary: CGRect
    /// Continue with email, under GitHub's; zero without it.
    public var tertiary: CGRect = .zero
    /// The note over the buttons; zero without one.
    public var note: CGRect

    /// `safeArea` is the first screen's (without this one's bar, which
    /// sits over the first screen's top row). `button`, `google`,
    /// `secondary` and `tertiary` are the buttons' own sizes; a zero
    /// `google` or `tertiary` leaves that one out. `noteRoom` is the most a
    /// note takes (its longest, two lines), kept for one whether or not
    /// there is one.
    public init(size: CGSize, safeArea: LayoutInsets, button buttonSize: CGSize, google googleSize: CGSize = .zero, secondary: CGSize,
                tertiary: CGSize = .zero, note: Measurable? = nil, noteRoom reserved: CGFloat = 0, slides: [StartLayout.Slide], dots: CGSize) {
        let width = max(0, size.width - safeArea.horizontal)
        let column = min(StartLayout.Metrics.columnMaxWidth, max(0, width - StartLayout.Metrics.sidePadding * 2))
        let noteSize = note?.size(fitting: column) ?? .zero
        // Where the slides, laid out with no note, leave the room over the
        // buttons the note floats there; else the room is always kept.
        let floating = Self(size: size, safeArea: safeArea, button: buttonSize, google: googleSize, secondary: secondary, tertiary: tertiary,
                            keptRoom: 0, slides: slides, dots: dots)
        let dotsBottom = floating.start.gallery.minY + floating.start.dots.maxY
        let fits = floating.start.button.minY - dotsBottom >= max(reserved, noteSize.height) + Metrics.noteGap * 2
        let keptRoom = fits ? 0 : max(reserved, noteSize.height) + Metrics.noteGap
        self.init(size: size, safeArea: safeArea, button: buttonSize, google: googleSize, secondary: secondary, tertiary: tertiary,
                  keptRoom: keptRoom, slides: slides, dots: dots)
        let x = safeArea.left + (width - column) / 2
        self.note = noteSize.height > 0 ? CGRect(x: x, y: button.minY - Metrics.noteGap - noteSize.height, width: column, height: noteSize.height) : .zero
    }

    /// The welcome with `keptRoom` over Apple's button for a note.
    private init(size: CGSize, safeArea: LayoutInsets, button buttonSize: CGSize, google googleSize: CGSize, secondary: CGSize,
                 tertiary: CGSize, keptRoom noteRoom: CGFloat, slides: [StartLayout.Slide], dots: CGSize) {
        let googleRoom = googleSize.height > 0 ? Metrics.googleGap + googleSize.height : 0
        // The note, Apple's button and Google's are one block where Start is;
        // GitHub's and email's are one block where Use Happy Cloud is.
        let lower = tertiary.height > 0
            ? CGSize(width: max(secondary.width, tertiary.width), height: secondary.height + StartLayout.Metrics.buttonGap + tertiary.height)
            : secondary
        start = StartLayout(size: size, safeArea: safeArea,
                            button: CGSize(width: max(buttonSize.width, googleSize.width), height: noteRoom + buttonSize.height + googleRoom),
                            cloud: lower, slides: slides, dots: dots)
        let block = start.button
        button = CGRect(x: block.minX, y: block.maxY - googleRoom - buttonSize.height, width: block.width, height: buttonSize.height)
        google = googleSize.height > 0
            ? CGRect(x: block.minX, y: block.maxY - googleSize.height, width: block.width, height: googleSize.height)
            : .zero
        let cloud = start.cloud
        self.secondary = CGRect(x: cloud.minX, y: cloud.minY, width: cloud.width, height: secondary.height)
        if tertiary.height > 0 {
            self.tertiary = CGRect(x: cloud.minX, y: cloud.maxY - tertiary.height, width: cloud.width, height: tertiary.height)
        }
        note = .zero
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
/// desktop's centred setup pages are, by its steady measure (`steadyBody`,
/// `steadyContent`): a status line at the room kept for it, a list at its
/// loading size. What then comes and goes there grows down from where the
/// block already is, so an error, a hint or a list arriving never moves
/// the title. The actions ride the keyboard and
/// the rest stays centred in the room left over them, never above its top
/// margin; past that the screen scrolls.
///
/// A step whose content is a list (Join a server, `pinsActions`) instead
/// starts at its top margin, and its actions stay where they rest while
/// the rest scrolls under them: however long the list, the actions are in
/// sight, and scrolled to its end the list stops 24 over them.
public struct CloudStageLayout: Equatable, Sendable {
    public enum Metrics {
        public static let sidePadding: CGFloat = StartLayout.Metrics.sidePadding
        public static let columnMaxWidth: CGFloat = StartLayout.Metrics.columnMaxWidth
        public static let top: CGFloat = 24
        /// A step's list of short lines (the admin bot's points), in from the column's sides.
        public static let pointsInset: CGFloat = 12
        public static let artGap: CGFloat = 24
        /// Between the art and a caption under it (Create your profile's
        /// Add photo).
        public static let captionGap: CGFloat = 8
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
    /// Under the art, centred; zero without one.
    public var caption: CGRect
    public var title: CGRect
    public var body: CGRect
    public var content: CGRect
    /// With `pinsActions`, in the view rather than the scrolled content.
    public var actions: [CGRect]
    /// With `pinsActions`, how far up from the screen's bottom edge the
    /// pinned actions (and the gap over them) cover the scrolled content
    /// while the keyboard is down; zero without.
    public var pinnedInset: CGFloat
    /// The scrolled content's height.
    public var contentHeight: CGFloat
    /// How far the keyboard covers the scroll view, for its bottom inset.
    public var keyboardInset: CGFloat
    /// Where the screen scrolls to while the keyboard is up so the last
    /// action rests 16 over it: zero when everything already fits.
    public var keyboardOffset: CGFloat

    /// The column's width in a window this size: what the step's own parts
    /// and its actions are measured at.
    public static func column(size: CGSize, safeArea: LayoutInsets) -> CGFloat {
        min(Metrics.columnMaxWidth, max(0, size.width - safeArea.horizontal - Metrics.sidePadding * 2))
    }

    /// `safeArea` includes the bar. `keyboardTop` is the keyboard's top in
    /// the view, the safe area's bottom while it is down. `art` is the
    /// scene's side, zero without one, and `caption` the size of a line
    /// under it, zero without one; an empty `body` or `content` measures
    /// zero tall and takes no gap. `pinsActions` starts the step at its top
    /// margin and keeps the actions in place while the rest scrolls.
    public init(size: CGSize, safeArea: LayoutInsets, keyboardTop: CGFloat? = nil, art side: CGFloat = 0, caption captionSize: CGSize = .zero,
                title: Measurable, body: Measurable, content: Measurable, steadyBody: Measurable? = nil, steadyContent: Measurable? = nil,
                pinsActions: Bool = false, actions: [Action]) {
        typealias M = Metrics
        let width = max(0, size.width - safeArea.horizontal)
        let column = Self.column(size: size, safeArea: safeArea)
        let x = safeArea.left + (width - column) / 2
        let titleHeight = title.height(fitting: column)
        let bodyHeight = body.height(fitting: column)
        let contentHeight = content.height(fitting: column)
        let steadyBodyHeight = steadyBody?.height(fitting: column) ?? bodyHeight
        let steadyContentHeight = steadyContent?.height(fitting: column) ?? contentHeight

        // Measured steady: what may come and go under the title doesn't count.
        var block = titleHeight
        if side > 0 { block += side + M.artGap }
        let captioned = side > 0 && captionSize.height > 0
        if captioned { block += M.captionGap + captionSize.height }
        if steadyBodyHeight > 0 { block += M.titleGap + steadyBodyHeight }
        if steadyContentHeight > 0 { block += M.bodyGap + steadyContentHeight }
        let actionsHeight = actions.enumerated().reduce(CGFloat(0)) { $0 + $1.element.height + ($1.offset > 0 ? $1.element.gap : 0) }

        let edge = max(safeArea.bottom, M.bottomPadding)
        let resting = size.height - edge - M.bottomPadding
        let bottom = min(resting, (keyboardTop ?? size.height) - M.bottomPadding)
        let minTop = safeArea.top + M.top
        // Centred over the actions, wherever the keyboard has put them.
        let free = bottom - actionsHeight - M.actionsGap - minTop - block
        var y = pinsActions ? minTop : minTop + max(0, free / 2)

        art = side > 0 ? CGRect(x: safeArea.left + (width - side) / 2, y: y, width: side, height: side) : .zero
        if side > 0 { y += side }
        let captionWidth = min(column, captionSize.width)
        caption = captioned ? CGRect(x: safeArea.left + (width - captionWidth) / 2, y: y + M.captionGap, width: captionWidth, height: captionSize.height) : .zero
        if captioned { y += M.captionGap + captionSize.height }
        if side > 0 { y += M.artGap }
        self.title = CGRect(x: x, y: y, width: column, height: titleHeight)
        y += titleHeight
        if bodyHeight > 0 { y += M.titleGap }
        self.body = CGRect(x: x, y: y, width: column, height: bodyHeight)
        y += bodyHeight
        if contentHeight > 0 { y += M.bodyGap }
        self.content = CGRect(x: x, y: y, width: column, height: contentHeight)
        y += contentHeight

        var top = pinsActions ? bottom - actionsHeight : max(y + M.actionsGap, bottom - actionsHeight)
        if actions.isEmpty { top = y }
        var frames: [CGRect] = []
        for (index, action) in actions.enumerated() {
            if index > 0 { top += action.gap }
            frames.append(CGRect(x: x, y: top, width: column, height: action.height))
            top += action.height
        }
        self.actions = frames
        pinnedInset = pinsActions ? edge + M.bottomPadding + actionsHeight + (actions.isEmpty ? 0 : M.actionsGap) : 0
        self.contentHeight = pinsActions ? max(size.height, y + pinnedInset) : max(size.height, top + edge + M.bottomPadding)
        keyboardInset = keyboardTop.map { max(0, size.height - $0 - edge) } ?? 0
        keyboardOffset = keyboardTop == nil || pinsActions ? 0 : max(0, (frames.last?.maxY ?? y) - bottom)
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

/// Create your profile's picture: the person's photo, else their
/// placeholder, round, with a camera badge on its edge at the bottom right.
public enum CloudProfileLayout {
    public enum Metrics {
        public static let avatar: CGFloat = 120
        public static let badge: CGFloat = 36
        public static let badgeGlyph: CGFloat = 18
        /// The badge's border, the gradient's colour, to part it from the photo.
        public static let badgeBorder: CGFloat = 3
        /// "Add photo": its text, and room around it for a thumb.
        public static let captionHeight: CGFloat = 32
        public static let captionPadding: CGFloat = 12
    }

    /// The badge over `avatar`: its centre on the circle's edge, at 45°.
    public static func badge(avatar: CGRect) -> CGRect {
        typealias M = Metrics
        let reach = avatar.width / 2 * 0.70710678
        let centre = CGPoint(x: avatar.midX + reach, y: avatar.midY + reach)
        return CGRect(x: (centre.x - M.badge / 2).rounded(), y: (centre.y - M.badge / 2).rounded(), width: M.badge, height: M.badge)
    }

    /// The caption's size for its text `width` as measured.
    public static func caption(textWidth: CGFloat) -> CGSize {
        CGSize(width: textWidth.rounded(.up) + 2 * Metrics.captionPadding, height: Metrics.captionHeight)
    }
}

/// An invite's own part (CloudInviteViewController), the same in every
/// state so nothing moves as it loads, fails or joins: the server's picture
/// centred, its name and `@name` under it, who invited them (a small
/// picture beside "<name> invited you", the pair centred), and a line for
/// what the invite says, as tall as `status` whatever it holds.
public struct CloudInviteLayout: Equatable, Sendable {
    public enum Metrics {
        public static let picture: CGFloat = 88
        public static let nameHeight: CGFloat = 28
        public static let handleHeight: CGFloat = 20
        public static let inviter: CGFloat = 24
        public static let inviterGap: CGFloat = 8
        public static let nameGap: CGFloat = 14
        public static let handleGap: CGFloat = 2
        public static let inviterTopGap: CGFloat = 18
        public static let statusGap: CGFloat = 18
    }

    public var picture: CGRect
    public var name: CGRect
    public var handle: CGRect
    public var inviterPicture: CGRect
    public var inviterLabel: CGRect
    public var status: CGRect
    public var height: CGFloat

    /// `inviterLabel` is the label's own width, kept within the column
    /// beside the picture; `status` the room its line keeps.
    public init(width: CGFloat, inviterLabel labelWidth: CGFloat, status statusHeight: CGFloat) {
        typealias M = Metrics
        picture = CGRect(x: (width - M.picture) / 2, y: 0, width: M.picture, height: M.picture)
        name = CGRect(x: 0, y: picture.maxY + M.nameGap, width: width, height: M.nameHeight)
        handle = CGRect(x: 0, y: name.maxY + M.handleGap, width: width, height: M.handleHeight)
        let label = min(labelWidth, max(0, width - M.inviter - M.inviterGap))
        let pair = M.inviter + M.inviterGap + label
        let top = handle.maxY + M.inviterTopGap
        inviterPicture = CGRect(x: (width - pair) / 2, y: top, width: M.inviter, height: M.inviter)
        inviterLabel = CGRect(x: inviterPicture.maxX + M.inviterGap, y: top, width: label, height: M.inviter)
        status = CGRect(x: 0, y: inviterPicture.maxY + M.statusGap, width: width, height: statusHeight)
        height = status.maxY
    }
}
