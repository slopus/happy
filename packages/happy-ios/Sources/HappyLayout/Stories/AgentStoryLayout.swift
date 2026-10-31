import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Where agents' stories put their live pages, round videos, the repost
/// chip and the viewer's feedback bar (happy-agent `API.md` "Artifact
/// frames", "Overlays", "Agent stories"; design "Sidebar v2: agent story
/// rings"). Pages lay out in their own CSS viewport and are scaled whole,
/// so they look the same on every client.
public enum AgentStoryLayout {
    /// A live page: its CSS viewport, the scale that fits it to its box, and
    /// the corners it is drawn with, in the box's own points.
    public struct Page: Equatable, Sendable {
        public var viewport: CGSize
        public var scale: CGFloat
        public var box: CGRect
        public var radius: CGFloat
    }

    /// An artifact frame: 360 × 640 scaled to fill the canvas, cropped evenly.
    public static func framePage(canvas: CGSize, viewport: CGSize = CGSize(width: 360, height: 640)) -> Page {
        guard canvas.width > 0, canvas.height > 0 else { return Page(viewport: viewport, scale: 0, box: .zero, radius: 0) }
        let scale = max(canvas.width / viewport.width, canvas.height / viewport.height)
        let size = CGSize(width: viewport.width * scale, height: viewport.height * scale)
        return Page(viewport: viewport, scale: scale, box: CGRect(x: (canvas.width - size.width) / 2, y: (canvas.height - size.height) / 2, width: size.width, height: size.height), radius: 0)
    }

    /// An artifact window: `scale` of the canvas's width wide, `aspectRatio`
    /// wide over tall, the page 360 CSS pixels wide in it, its corners 1/27
    /// of the canvas's width. The box is unrotated, centred at the origin.
    public static func windowPage(aspectRatio: Double, scale: Double, canvas: CGSize, pageWidth: CGFloat = 360) -> Page {
        let ratio = CGFloat(min(4, max(0.25, aspectRatio)))
        let width = CGFloat(scale) * canvas.width
        let height = width / ratio
        let viewport = CGSize(width: pageWidth, height: pageWidth / ratio)
        return Page(viewport: viewport, scale: width / pageWidth, box: CGRect(x: -width / 2, y: -height / 2, width: width, height: height), radius: canvas.width / 27)
    }

    /// A round video's circle: `scale` of the canvas's width across.
    public static func roundVideo(scale: Double, canvas: CGSize) -> CGFloat {
        CGFloat(scale) * canvas.width
    }

    /// Whether a tap at `x` on an artifact frame moves between frames: only
    /// in its left and right tenth; the rest is the page's.
    public static func navigates(x: CGFloat, canvas: CGRect, edge: CGFloat = 0.1) -> Bool {
        x < canvas.minX + canvas.width * edge || x > canvas.maxX - canvas.width * edge
    }

    /// The left and right tenth of an artifact frame, in the canvas's space.
    public static func edges(canvas: CGSize, edge: CGFloat = 0.1) -> [CGRect] {
        let width = canvas.width * edge
        return [CGRect(x: 0, y: 0, width: width, height: canvas.height), CGRect(x: canvas.width - width, y: 0, width: width, height: canvas.height)]
    }

    /// The "↻ Reposted from …" chip: at the canvas's bottom-left, 1/27 of
    /// its width in from the edges, its text 1/36 of the width.
    public struct Chip: Equatable, Sendable {
        public var frame: CGRect
        public var fontSize: CGFloat
        public var padding: CGSize
    }

    public static func chip(textWidth: CGFloat, canvas: CGSize, bottomInset: CGFloat = 0) -> Chip {
        let unit = canvas.width / 360
        let font = 11 * unit
        let padding = CGSize(width: 10 * unit, height: 5 * unit)
        let height = ceil(font * 1.25 + 2 * padding.height)
        let width = min(canvas.width - 28 * unit, ceil(textWidth + 2 * padding.width))
        return Chip(frame: CGRect(x: 14 * unit, y: canvas.height - bottomInset - 14 * unit - height, width: width, height: height), fontSize: font, padding: padding)
    }

    /// The viewer's bar on an agent's story: the feedback field from the
    /// canvas's left, then the heart, then repost at the far right, as
    /// the design's `.vf` row: 32 buttons, 8 apart, 10 in.
    public struct Bar: Equatable, Sendable {
        public var field: CGRect
        public var heart: CGRect
        public var repost: CGRect
    }

    public enum BarMetrics {
        public static let inset: CGFloat = 10
        public static let gap: CGFloat = 8
        public static let button: CGFloat = 32
        public static let field: CGFloat = 36
    }

    /// `bar` is the viewer's bar under the canvas; `lift` raises it over a keyboard.
    /// `replyOnly` (a story artifact): the field alone, `Viewer.gap` over the bar's foot.
    public static func bar(canvas: CGRect, bar: CGRect, barHeight: CGFloat, lift: CGFloat = 0, replyOnly: Bool = false) -> Bar {
        typealias M = BarMetrics; typealias V = Viewer
        let midY = bar.minY + min(bar.height, barHeight) / 2 - lift
        let repost = CGRect(x: canvas.maxX - M.inset - M.button, y: midY - M.button / 2, width: M.button, height: M.button)
        let heart = repost.offsetBy(dx: -(M.button + M.gap), dy: 0)
        let field = replyOnly ? CGRect(x: canvas.minX + V.inset, y: bar.maxY - V.gap - V.field - lift, width: max(0, canvas.width - 2 * V.inset), height: V.field)
            : CGRect(x: canvas.minX + M.inset, y: midY - M.field / 2, width: max(0, heart.minX - M.gap - canvas.minX - M.inset), height: M.field)
        return Bar(field: field, heart: heart, repost: repost)
    }

    /// A story artifact's viewer, task_174's mock "Story viewer" on a phone, in points.
    public enum Viewer {
        public static let inset: CGFloat = 12, gap: CGFloat = 8, field: CGFloat = 44, foot: CGFloat = 12, captionLine: CGFloat = 20, captionGap: CGFloat = 10
        public static let all: CGFloat = 20, allGap: CGFloat = 6, row: CGFloat = 28, rowGap: CGFloat = 4, face: CGFloat = 24, faceGap: CGFloat = 8, line: CGFloat = 18
        /// The foot's scrim, from `scrimLead` over the caption to the canvas's foot: black at these alphas, these far down, then 0.72;
        /// a blur fades in over its first `blurLead`. The top's runs 136 down.
        public static let scrimLead: CGFloat = 72, blurLead: CGFloat = 56, scrim: [(CGFloat, CGFloat)] = [(0, 0), (24, 0.16), (48, 0.4), (72, 0.6)], scrimFoot: CGFloat = 0.72
        public static let topScrim: [(CGFloat, CGFloat)] = [(0, 0.6), (52, 0.52), (96, 0.22), (136, 0)]
        public static let round: CGFloat = 0.3, roundOrigin = CGPoint(x: 12, y: 86), pill = CGRect(x: 52, y: 54, width: 18, height: 22), dim: CGFloat = 0.62
        public static let drawerShare: CGFloat = 0.66, heading: CGFloat = 50, close: CGFloat = 32, listPad: CGFloat = 6
        public static let drawerFace: CGFloat = 32, drawerGap: CGFloat = 10, drawerPad = CGSize(width: 16, height: 8), drawerText: CGFloat = 20
    }

    /// The header on one line: the name beside the avatar, cut first, then the time, short of the buttons.
    public static func header(_ viewer: StoryViewerLayout, withSound: Bool, name: CGSize, time: CGSize) -> (name: CGRect, time: CGRect) {
        let x = viewer.avatar.maxX + Viewer.gap, end = viewer.titleOrigin.x + viewer.titleWidth(withSound: withSound)
        let name = CGRect(x: x, y: viewer.avatar.midY - Viewer.line / 2, width: max(0, min(name.width, end - x - Viewer.gap - time.width)), height: Viewer.line)
        return (name, CGRect(x: name.maxX + Viewer.gap, y: name.minY, width: time.width, height: Viewer.line))
    }

    /// A reply `width` wide: in the peek (`text` nil) the face and one line, 28 tall; in the
    /// drawer the face, the name and time, and the words `text` tall under them.
    public static func replyRow(width: CGFloat, text: CGFloat?) -> (face: CGRect, line: CGRect, text: CGRect, height: CGFloat) {
        typealias V = Viewer
        guard let text else {
            return (CGRect(x: 0, y: (V.row - V.face) / 2, width: V.face, height: V.face),
                    CGRect(x: V.face + V.faceGap, y: (V.row - V.line) / 2, width: max(0, width - V.face - V.faceGap), height: V.line), .zero, V.row)
        }
        let x = V.drawerPad.width + V.drawerFace + V.drawerGap, line = CGRect(x: x, y: V.drawerPad.height, width: max(0, width - x - V.drawerPad.width), height: V.line)
        return (CGRect(x: V.drawerPad.width, y: V.drawerPad.height, width: V.drawerFace, height: V.drawerFace), line,
                CGRect(x: x, y: line.maxY, width: line.width, height: text), max(V.drawerFace, V.line + text) + 2 * V.drawerPad.height)
    }

    /// A story artifact's foot over its canvas: the caption (`caption` measures it at a width), "View all"
    /// when `all`, and `rows` peeking replies, 12 over the field or the canvas's foot, whichever is higher; its scrim behind them.
    public static func foot(canvas: CGRect, field: CGRect, caption: (CGFloat) -> CGFloat, rows: Int, all: Bool) -> (scrim: CGRect, caption: CGRect, all: CGRect, rows: [CGRect]) {
        typealias V = Viewer
        let x = canvas.minX + V.inset, width = max(0, canvas.width - 2 * V.inset), bottom = min(field.minY, canvas.maxY) - V.foot, tall = caption(width)
        let peek = (0..<rows).map { CGRect(x: x, y: bottom - CGFloat(rows - $0) * (V.row + V.rowGap) + V.rowGap, width: width, height: V.row) }
        let top = peek.first?.minY ?? bottom, more = CGRect(x: x, y: all ? top - V.allGap - V.all : top, width: width, height: all ? V.all : 0)
        let text = CGRect(x: x, y: more.minY - (peek.isEmpty ? 0 : V.captionGap) - tall, width: width, height: tall), scrimTop = text.minY - V.scrimLead
        return (CGRect(x: canvas.minX, y: scrimTop, width: canvas.width, height: max(0, canvas.maxY - scrimTop)), text, more, peek)
    }

    /// The replies' drawer `size` big: the heading and its close button, the rows (`heights`) at the
    /// list's foot, scrolling when they overflow, and the field pinned `gap` above `bottom` (home indicator or keyboard).
    public static func drawer(size: CGSize, bottom: CGFloat, heights: [CGFloat]) -> (heading: CGRect, close: CGRect, list: CGRect, rows: [CGRect], content: CGFloat, field: CGRect, lines: [CGRect]) {
        typealias V = Viewer
        let field = CGRect(x: V.inset, y: size.height - bottom - V.gap - V.field, width: max(0, size.width - 2 * V.inset), height: V.field)
        let list = CGRect(x: 0, y: V.heading, width: size.width, height: max(0, field.minY - V.gap - 1 - V.heading)), total = heights.reduce(0, +)
        var y = max(V.listPad, list.height - V.listPad - total)
        let rows = heights.map { height in defer { y += height }; return CGRect(x: 0, y: y, width: size.width, height: height) }
        // The heading's row: 8 down, a 1 line under it; its text 16 tall, the button 32, both centred.
        let mid = V.gap + (V.heading - V.gap - 1) / 2
        return (CGRect(x: V.drawerPad.width, y: mid - 8, width: max(0, size.width - V.drawerPad.width - V.gap - V.close), height: 16),
                CGRect(x: size.width - V.gap - V.close, y: mid - V.close / 2, width: V.close, height: V.close), list, rows, max(list.height, y + V.listPad), field,
                [CGRect(x: 0, y: list.minY - 1, width: size.width, height: 1), CGRect(x: 0, y: list.maxY, width: size.width, height: 1)])
    }

    /// A story artifact's round video: under the header at the left, 0.3 of the canvas wide,
    /// shrunk in place so it ends `gap` over `limit` (the foot's top, or a lifted field's).
    public static func round(canvas: CGSize, above limit: CGFloat) -> CGRect {
        let o = Viewer.roundOrigin, side = max(0, min(canvas.width * Viewer.round, limit - Viewer.gap - o.y))
        return CGRect(x: o.x, y: o.y, width: side, height: side)
    }

    /// The "Reposted from …" pill under a story artifact's header.
    public static func pill(textWidth: CGFloat, canvas: CGSize) -> Chip {
        let p = Viewer.pill
        return Chip(frame: CGRect(x: p.minX, y: p.minY, width: min(canvas.width - p.minX - Viewer.inset, ceil(textWidth + p.width)), height: p.height), fontSize: 12, padding: CGSize(width: p.width / 2, height: 0))
    }
}
