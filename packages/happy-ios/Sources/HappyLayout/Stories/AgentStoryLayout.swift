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
    public static func bar(canvas: CGRect, bar: CGRect, barHeight: CGFloat, lift: CGFloat = 0) -> Bar {
        typealias M = BarMetrics
        let midY = bar.minY + min(bar.height, barHeight) / 2 - lift
        let repost = CGRect(x: canvas.maxX - M.inset - M.button, y: midY - M.button / 2, width: M.button, height: M.button)
        let heart = repost.offsetBy(dx: -(M.button + M.gap), dy: 0)
        let fieldX = canvas.minX + M.inset
        let field = CGRect(x: fieldX, y: midY - M.field / 2, width: max(0, heart.minX - M.gap - fieldX), height: M.field)
        return Bar(field: field, heart: heart, repost: repost)
    }
}
