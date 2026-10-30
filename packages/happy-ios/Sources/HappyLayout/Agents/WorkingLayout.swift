import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// Desktop's working line (`AgentWorkingStatus`, `agent-working-status.css`)
/// at the transcript's foot: a 32-high row under 4 of clearance, the 14
/// glyph column (the 8-wide braille loader padded 3 either side, or a 14
/// ring or icon), then the clock, a "·" and the phase, 6 apart on one
/// 16/24 line.
public struct WorkingLayout: Equatable, Sendable {
    public enum Metrics {
        /// The row with its clearance (`AGENT_WORKING_STATUS_ROW_HEIGHT`).
        public static let height: CGFloat = 36
        public static let clearance: CGFloat = 4
        public static let row: CGFloat = 32
        public static let line: CGFloat = 24
        public static let fontSize: CGFloat = 16
        /// The glyph column, and the text after it.
        public static let column: CGFloat = 14
        public static let gap: CGFloat = 6
        /// The loader inside the column: 3 in, 8 wide, 14 high.
        public static let loaderInset: CGFloat = 3
        public static let loader = CGSize(width: 8, height: 14)
        /// The transcript's sides.
        public static let side: CGFloat = 16
        /// A wait's ring (`WaitRing`): its stroke, track and fill alike.
        public static let ringStroke: CGFloat = 2
    }

    /// The ring's radius inside a box, the stroke kept inside it.
    public static func ringRadius(_ box: CGSize) -> CGFloat {
        max(0, (min(box.width, box.height) - Metrics.ringStroke) / 2)
    }

    public enum Glyph: Equatable, Sendable {
        /// The braille loader.
        case loader
        /// A ring or a still icon, filling the column.
        case mark
    }

    /// All in the row's own space, the row being `height` tall.
    public var glyph: CGRect
    public var timer: CGRect?
    public var separator: CGRect?
    public var phase: CGRect

    /// Text widths as measured; `timer` and `separator` nil where no clock
    /// is shown.
    public init(width: CGFloat, glyph kind: Glyph, timer: CGFloat?, separator: CGFloat?, phase: CGFloat) {
        typealias M = Metrics
        let top = M.clearance
        switch kind {
        case .loader:
            glyph = CGRect(x: M.side + M.loaderInset, y: top + (M.row - M.loader.height) / 2, width: M.loader.width, height: M.loader.height)
        case .mark:
            glyph = CGRect(x: M.side, y: top + (M.row - M.column) / 2, width: M.column, height: M.column)
        }
        let lineY = top + (M.row - M.line) / 2
        var x = M.side + M.column + M.gap
        // Widths as measured, unrounded: desktop's flex row runs its text
        // at fractional widths, and a rounding per run would drift the phase.
        if let timer, let separator {
            self.timer = CGRect(x: x, y: lineY, width: timer, height: M.line)
            x += timer + M.gap
            self.separator = CGRect(x: x, y: lineY, width: separator, height: M.line)
            x += separator + M.gap
        } else {
            self.timer = nil
            self.separator = nil
        }
        self.phase = CGRect(x: x, y: lineY, width: max(0, min(phase, width - M.side - x)), height: M.line)
    }
}
