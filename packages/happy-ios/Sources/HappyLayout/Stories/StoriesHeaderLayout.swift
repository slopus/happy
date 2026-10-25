import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Stories in home's header, as Telegram's chat list carries them
/// (`StoryPeerListComponent` in `ChatListNavigationBar`): a row of circles
/// under the header while it is open, and up to three small overlapping
/// avatars before the title once it closes. Everything is drawn from where
/// the list is: `pull` is how far it sits below its closed top, 96 when the
/// row is open and at rest.
///
///     open      (logo) ……… Sessions ……… (pill)
///                 (A)   (B)   (C)   (D)
///                 Ada   Bo    Cy    Di
///
///     closed    (logo) …  ⦿⦿⦿ Sessions … (pill)
///
/// The row opens past 65 of pull and closes again under 61. While it is
/// open the circles follow the list, shrinking into the title as it rises;
/// closed, they stay in the title and only lean out a little as the list
/// is pulled. Between the two the change is animated (`StoriesHeaderMotion`).
public struct StoriesHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        /// `ChatListNavigationBar.storiesScrollHeight`: the room the open row
        /// adds above the list.
        public static let scrollHeight: CGFloat = 96
        public static let unlockPull: CGFloat = 65
        public static let lockPull: CGFloat = 61
        /// A closed avatar, and how far the next one starts after it.
        public static let collapsedWidth: CGFloat = 24
        public static let collapsedPitch: CGFloat = 14
        public static let collapsedCount = 3
        /// How far the open row's avatars sit under the title's middle.
        public static let rowDrop: CGFloat = 66
        /// Between the closed avatars and the title.
        public static let titleSpacing: CGFloat = 8
        /// A closed avatar, and one leaning out under a pull, against an open one.
        public static let minScale: CGFloat = 24 / 52
        public static let pulledScale: CGFloat = 28 / 52
        /// How the closed avatars lean out under a pull: the last goes this
        /// much right and down, the first this much left, all of them down.
        public static let pullSpread: CGFloat = 20
        public static let pullLead: CGFloat = 4
        public static let pullDrop: CGFloat = 10
        /// The title moves this much right under a full pull.
        public static let titlePull: CGFloat = 12
        /// Past the open rest the circles follow the list down this much of
        /// the way and grow a little.
        public static let overscrollFollow: CGFloat = 83 * 0.5
        public static let overscrollGrowth: CGFloat = 0.1
        /// The open row's items, 60 × 77, 12 in from the sides (Telegram
        /// insets them 4 less than its 16 bar padding).
        public static let inset: CGFloat = 12
        public static let rowTop: CGFloat = 12
        public static let rowHeight: CGFloat = 98
        public static let maxSpacing: CGFloat = 100
        /// The avatar's middle, down from the item's top.
        public static let avatarMid: CGFloat = 30
        /// The title stays this far inside the band between the buttons, and
        /// starts balancing in it this close to either end.
        public static let bandMargin: CGFloat = 4
        public static let balanceRamp: CGFloat = 20
        /// The closed avatars' target, as tall as a header button.
        public static let buttonHeight: CGFloat = 44
        /// The one-time tooltip's arrow points up at the closed avatars'
        /// middle from this far under their target, 1 right of it, as
        /// Telegram places it (`anchorForTooltip`, nudged 6 down and 1 right).
        public static let tooltipDrop: CGFloat = 8
        /// The ring's width grows toward this as a circle shrinks, so a small
        /// one still shows it.
        public static let minimizedRing: CGFloat = 4.3
        public static let unlockDuration: Double = 0.35
        public static let lockDuration: Double = 0.25
    }

    /// Where the change between open and closed stands: `min` is how far the
    /// closed avatars lean out, `max` how far open the row is (past 1 when
    /// pulled beyond its rest), `side` how present the open row's names and
    /// further circles are.
    public struct State: Equatable, Sendable {
        public var min: CGFloat
        public var max: CGFloat
        public var side: CGFloat

        public init(min: CGFloat, max: CGFloat, side: CGFloat) {
            self.min = min
            self.max = max
            self.side = side
        }

        /// Where a list `pull` below its closed top puts things, open or not.
        public static func target(unlocked: Bool, pull: CGFloat) -> State {
            let fraction = Swift.max(0, Swift.min(4, pull / Metrics.scrollHeight))
            return unlocked ? State(min: 0, max: fraction, side: 1) : State(min: fraction, max: 0, side: 0)
        }

        func mixed(to other: State, amount t: CGFloat) -> State {
            State(min: lerp(min, other.min, t), max: lerp(max, other.max, t), side: lerp(side, other.side, t))
        }
    }

    /// Whether the row is open after a list `pull`: it opens past 65 and
    /// closes under 61, keeping what it was between.
    public static func unlocked(_ current: Bool, pull: CGFloat) -> Bool {
        if pull >= Metrics.unlockPull { return true }
        if pull <= Metrics.lockPull { return false }
        return current
    }

    /// Where a list let go of with the row `unlocked` comes to rest, given
    /// where it would glide to: never part way into the row's room. As
    /// Telegram's chat list ends a scroll there, it goes to whichever the
    /// row will be once the glide is done (the glide closes it under 61, it
    /// never opens it), so a short flick up puts the row away.
    public static func resting(unlocked: Bool, glide: CGFloat) -> CGFloat {
        guard glide > 0, glide < Metrics.scrollHeight else { return glide }
        return unlocked && glide > Metrics.lockPull ? Metrics.scrollHeight : 0
    }

    public struct Input: Equatable, Sendable {
        public var width: CGFloat
        /// The header's title where it would be centred alone.
        public var title: CGRect
        /// Between the header's left control and its right pill.
        public var bandMinX: CGFloat
        public var bandMaxX: CGFloat
        public var count: Int
        /// The first circle that closes into the title: 1 to leave out the
        /// person's own, first, when it has nothing new.
        public var collapseStart: Int
        /// How far the open row is scrolled sideways.
        public var scroll: CGFloat
        public var state: State

        public init(width: CGFloat, title: CGRect, bandMinX: CGFloat, bandMaxX: CGFloat, count: Int, collapseStart: Int, scroll: CGFloat, state: State) {
            self.width = width
            self.title = title
            self.bandMinX = bandMinX
            self.bandMaxX = bandMaxX
            self.count = count
            self.collapseStart = collapseStart
            self.scroll = scroll
            self.state = state
        }
    }

    public struct Item: Equatable, Sendable {
        /// The avatar's middle, in the header's space.
        public var center: CGPoint
        /// Against the open row's 52 avatar; the name and ring scale with it.
        public var scale: CGFloat
        public var alpha: CGFloat
        /// One of the avatars that close into the title.
        public var collapses: Bool
        /// Drawn over the circles after it.
        public var zPosition: CGFloat
        /// Where the circle before it stands, from this one's middle, while
        /// they overlap: this one is cut around it.
        public var neighbor: CGPoint?
    }

    /// The open row's band in the header's space: what scrolls sideways
    /// and takes touches while it is open.
    public var row: CGRect
    public var contentWidth: CGFloat
    /// Each circle's frame in the open row, in the row's content.
    public var rowItems: [CGRect]
    public var items: [Item]
    /// Where the title starts; nil leaves it centred.
    public var titleX: CGFloat?
    /// The closed avatars' target, when there are any.
    public var button: CGRect?
    /// How many avatars close into the title.
    public var collapsedCount: Int
    /// Where the one-time tooltip under the closed avatars points.
    public var tooltipTip: CGPoint?

    public init(_ input: Input) {
        typealias M = Metrics
        let width = Swift.max(0, input.width)
        let state = input.state
        let open = Swift.min(1, state.max)
        let overscroll = Swift.max(0, state.max - 1)
        let n = Swift.max(0, input.count)
        let rowY = input.title.midY + M.rowDrop - M.avatarMid
        row = CGRect(x: 0, y: rowY - M.rowTop, width: width, height: M.rowHeight)
        let (frames, content) = Self.rowFrames(width: width, count: n)
        rowItems = frames.map { $0.offsetBy(dx: 0, dy: M.rowTop) }
        contentWidth = content

        let start = Swift.min(Swift.max(0, input.collapseStart), n)
        let count = Swift.min(n - start, M.collapsedCount)
        collapsedCount = count
        let collapsedWidth = count > 0 ? M.collapsedWidth + M.collapsedPitch * CGFloat(count - 1) : 0
        let spacing = count > 0 ? M.titleSpacing : 0
        let origin = Self.contentOrigin(width: width, content: collapsedWidth + spacing + input.title.width, minX: input.bandMinX, maxX: input.bandMaxX)

        // The circles the open row shows from its left edge close first,
        // never the person's own, and always as many as there are room for.
        let visible = CGRect(x: input.scroll, y: 0, width: width, height: 1)
        let firstVisible = frames.firstIndex { $0.maxX > visible.minX && $0.minX < visible.maxX } ?? 0
        let first = Swift.min(Swift.max(start, firstVisible), Swift.max(start, n - count))

        func measure(_ i: Int) -> (center: CGPoint, scale: CGFloat) {
            let frame = frames[i].offsetBy(dx: -input.scroll, dy: 0)
            let regular = CGPoint(x: frame.midX, y: rowY + M.avatarMid)
            let index = i - first
            let step = CGFloat(Swift.min(Swift.max(0, index), Swift.max(0, count - 1)))
            let collapsedX = index < 0 ? origin : origin + step * M.collapsedPitch * (1 - state.max)
            let collapsed = CGPoint(x: collapsedX + M.collapsedWidth / 2, y: regular.y - M.rowDrop)
            var leaning = collapsed
            if n > 1 {
                let distance = count > 1 ? Swift.max(0, Swift.min(1, CGFloat(index) / CGFloat(count - 1))) : 0
                leaning.x += distance * M.pullSpread - state.min * M.pullLead
                leaning.y += distance * M.pullSpread + state.min * M.pullDrop
            }
            let closed = lerp(collapsed, leaning, state.min)
            var center = lerp(closed, regular, open)
            center.y += overscroll * M.overscrollFollow
            let small = lerp(M.minScale, M.pulledScale, state.min)
            let full = 1 + Swift.min(0.5, overscroll) * M.overscrollGrowth
            return (center, lerp(small, full, open))
        }

        var items: [Item] = []
        for i in 0..<n {
            let (center, scale) = measure(i)
            let index = i - first
            let collapses = count > 0 && index >= 0 && index < count
            // The rest fade into the last avatar by the title.
            let alpha = collapses ? 1 : state.side
            var neighbor: CGPoint?
            if collapses, index > 0, state.max < 0.5 {
                let left = measure(i - 1).center
                neighbor = CGPoint(x: left.x - center.x, y: left.y - center.y)
            }
            items.append(Item(center: center, scale: scale, alpha: alpha, collapses: collapses, zPosition: collapses ? 1000 - CGFloat(i) * 0.01 : 0.5, neighbor: neighbor))
        }
        self.items = items

        if n == 0 || count == 0 {
            titleX = nil
        } else {
            let collapsedTitle = origin + collapsedWidth + spacing
            let leaning = lerp(collapsedTitle, collapsedTitle + M.titlePull, state.min)
            titleX = lerp(leaning, (width - input.title.width) / 2, open)
        }
        button = count > 0 && state.side < 1
            ? CGRect(x: input.bandMinX, y: input.title.midY - M.buttonHeight / 2, width: Swift.max(0, input.bandMaxX - input.bandMinX), height: M.buttonHeight)
            : nil
        tooltipTip = count > 0
            ? CGPoint(x: origin + collapsedWidth / 2 + 1, y: input.title.midY + M.buttonHeight / 2 + M.tooltipDrop)
            : nil
    }

    /// The open row's items as Telegram's list spaces them: one centred; a
    /// few that fit spread evenly about the middle; more from the left at
    /// 14 apart, scrolling, the spacing grown so the edge never shows a
    /// sliver of a ring. Returns the frames (y 0) and the content's width.
    static func rowFrames(width: CGFloat, count: Int) -> ([CGRect], CGFloat) {
        typealias M = Metrics
        let item = StoriesRowLayout.Metrics.item
        guard count > 0 else { return ([], width) }
        if count == 1 {
            let x = M.inset + floor((width - 2 * M.inset - item.width) / 2)
            return ([CGRect(x: x, y: 0, width: item.width, height: item.height)], width)
        }
        let n = CGFloat(count)
        let base = 2 * M.inset + n * item.width + (n - 1) * StoriesRowLayout.Metrics.spacing
        let spacing = base >= width ? StoriesRowLayout.spacing(containerWidth: width, count: count) : StoriesRowLayout.Metrics.spacing
        let content = 2 * M.inset + n * item.width + (n - 1) * spacing
        if content < width {
            let even = Swift.min(M.maxSpacing, floor((width - 2 * M.inset - n * item.width) / (n + 1)))
            let used = n * item.width + (n - 1) * even
            let x0 = floor((width - used) / 2)
            return ((0..<count).map { CGRect(x: x0 + (item.width + even) * CGFloat($0), y: 0, width: item.width, height: item.height) }, width)
        }
        return ((0..<count).map { CGRect(x: M.inset + (item.width + spacing) * CGFloat($0), y: 0, width: item.width, height: item.height) }, content)
    }

    /// The left edge of the title's content, `content` wide: centred on the
    /// screen while that keeps it clear of both buttons, in the middle of
    /// the band between them once it would touch one, and on a smooth step
    /// from one to the other over the last 20 points.
    public static func contentOrigin(width: CGFloat, content: CGFloat, minX: CGFloat, maxX: CGFloat) -> CGFloat {
        let low = minX + Metrics.bandMargin
        let high = maxX - Metrics.bandMargin
        let centred = (width - content) / 2
        let balanced = (low + high - content) / 2
        let gap = Swift.min(centred - low, high - (centred + content))
        let x = Swift.max(0, Swift.min(1, 1 - gap / Metrics.balanceRamp))
        return centred + (balanced - centred) * x * x * (3 - 2 * x)
    }

    /// A ring's width before the circle's scale, so that it reads about as
    /// wide at any size: `base` open, 4.3 when shrunk to nothing.
    public static func ringWidth(_ base: CGFloat, scale: CGFloat) -> CGFloat {
        let s = Swift.max(0, Swift.min(1, scale))
        return base * s + Metrics.minimizedRing * (1 - s)
    }
}

/// The animated change between the open and closed header: from what was
/// drawn when it began toward wherever the list now puts things, on the
/// keyboard's spring (Telegram's `listViewAnimationCurveSystem`), 0.35 s
/// opening and 0.25 s closing.
public struct StoriesHeaderMotion: Equatable, Sendable {
    public var from: StoriesHeaderLayout.State
    public var start: Double
    public var duration: Double

    public init(from: StoriesHeaderLayout.State, start: Double, opening: Bool) {
        self.from = from
        self.start = start
        duration = opening ? StoriesHeaderLayout.Metrics.unlockDuration : StoriesHeaderLayout.Metrics.lockDuration
    }

    public func progress(at time: Double) -> CGFloat {
        guard duration > 0 else { return 1 }
        return Self.curve(CGFloat(Swift.max(0, Swift.min(1, (time - start) / duration))))
    }

    public func state(toward target: StoriesHeaderLayout.State, at time: Double) -> StoriesHeaderLayout.State {
        from.mixed(to: target, amount: progress(at: time))
    }

    public func isFinished(at time: Double) -> Bool { time >= start + duration }

    /// cubic-bezier(0.23, 1, 0.32, 1).
    public static func curve(_ t: CGFloat) -> CGFloat {
        let (x1, y1, x2, y2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0.23, 1, 0.32, 1)
        func bezier(_ u: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat {
            let v = 1 - u
            return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u
        }
        func slope(_ u: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat {
            let v = 1 - u
            return 3 * v * v * a + 6 * v * u * (b - a) + 3 * u * u * (1 - b)
        }
        guard t > 0 else { return 0 }
        guard t < 1 else { return 1 }
        var u = t
        for _ in 0..<8 {
            let d = slope(u, x1, x2)
            if abs(d) < 1e-6 { break }
            u -= (bezier(u, x1, x2) - t) / d
            u = Swift.max(0, Swift.min(1, u))
        }
        // Newton can stall where the curve is flat; halving settles it.
        if abs(bezier(u, x1, x2) - t) > 1e-4 {
            var low: CGFloat = 0, high: CGFloat = 1
            for _ in 0..<30 {
                u = (low + high) / 2
                if bezier(u, x1, x2) < t { low = u } else { high = u }
            }
        }
        return bezier(u, y1, y2)
    }
}

private func lerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat { a + (b - a) * t }
private func lerp(_ a: CGPoint, _ b: CGPoint, _ t: CGFloat) -> CGPoint { CGPoint(x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t)) }
