import Foundation

/// Where a text selection's highlight, grab handles and menu go, as
/// Telegram's `TextSelectionNode` places them. The line rects come from
/// the text layout that drew the glyphs, so they are passed in, never
/// measured here.
public enum SelectionGeometry {
    public enum Metrics {
        /// The handle's dot and the image it is drawn in: 12 across, its
        /// stem 2 wide.
        public static let knobDiameter: CGFloat = 12
        public static let knobWidth: CGFloat = 12
        public static let stemWidth: CGFloat = 2
        /// How far a touch may miss a handle and still take it: close
        /// first, then a finger's width.
        public static let knobSlop = CGSize(width: 4, height: 8)
        public static let knobReach: CGFloat = 14
        /// Lines this close meet halfway, so the highlight has no seams.
        public static let lineGap: CGFloat = 4
        /// The menu keeps this clear of the selection.
        public static let menuClearance: CGFloat = 12
        /// The highlight's rounded corners.
        public static let cornerRadius: CGFloat = 2
        /// A press in the text this long selects the word under it.
        public static let pressDuration: TimeInterval = 0.3
        /// The highlight in: alpha over 0.3 (ease out), shrinking from
        /// twice its size over 0.26; the handles fade in over 0.14 after
        /// 0.19 and spring from half their size over 0.2 after 0.25
        /// (damping 80). Out, everything fades over 0.18.
        public static let highlightFade: TimeInterval = 0.3
        public static let highlightShrink: TimeInterval = 0.26
        public static let knobFade: TimeInterval = 0.14
        public static let knobFadeDelay: TimeInterval = 0.19
        public static let knobSpring: TimeInterval = 0.2
        public static let knobSpringDelay: TimeInterval = 0.25
        public static let knobSpringDamping: CGFloat = 80
        public static let fadeOut: TimeInterval = 0.18
    }

    public enum Knob: Equatable, Sendable { case start, end }

    /// One line's rects in reading order, each line meeting the next
    /// halfway across a gap of up to 4, as `updateSelection` closes them.
    public static func joined(_ rects: [CGRect]) -> [CGRect] {
        var rects = rects
        guard rects.count > 1 else { return rects }
        for index in 0..<(rects.count - 1) {
            let gap = rects[index + 1].minY - rects[index].maxY
            if gap > 0, gap <= Metrics.lineGap {
                rects[index].size.height += gap / 2
                rects[index + 1].size.height += gap / 2
                rects[index + 1].origin.y -= gap / 2
            }
        }
        return rects
    }

    /// The start handle over the selection's first line, `edge`: its dot
    /// above the line, its stem down the line's height.
    public static func startKnob(edge: CGRect) -> CGRect {
        typealias M = Metrics
        return CGRect(x: floor(edge.minX - M.knobWidth / 2), y: edge.minY - M.knobDiameter, width: M.knobWidth, height: M.knobDiameter + edge.height)
    }

    /// The end handle on the selection's last line, `edge`: its stem down
    /// the line, its dot under it.
    public static func endKnob(edge: CGRect) -> CGRect {
        typealias M = Metrics
        return CGRect(x: floor(edge.maxX - M.knobWidth / 2), y: edge.minY, width: M.knobWidth, height: M.knobDiameter + edge.height)
    }

    /// The handle a touch at `point` takes, and the point on its line it
    /// takes it by: the middle of the stem, half a dot in from its end.
    public static func knob(at point: CGPoint, start: CGRect?, end: CGRect?) -> (knob: Knob, grab: CGPoint)? {
        typealias M = Metrics
        func grab(_ knob: Knob, _ frame: CGRect) -> (knob: Knob, grab: CGPoint) {
            let dy = knob == .start ? frame.width / 2 : -frame.width / 2
            return (knob, CGPoint(x: frame.midX, y: frame.midY + dy))
        }
        // Where each handle's dot is: the start's on top, the end's below.
        func distance(_ knob: Knob, _ frame: CGRect) -> CGFloat {
            let dot = CGPoint(x: frame.midX, y: knob == .start ? frame.minY + frame.width / 2 : frame.maxY - frame.width / 2)
            return hypot(point.x - dot.x, point.y - dot.y)
        }
        for (slopX, slopY) in [(M.knobSlop.width, M.knobSlop.height), (M.knobReach, M.knobReach)] {
            let inStart = start.map { $0.insetBy(dx: -slopX, dy: -slopY).contains(point) } ?? false
            let inEnd = end.map { $0.insetBy(dx: -slopX, dy: -slopY).contains(point) } ?? false
            // A short selection's handles reach over each other: the
            // nearer dot takes the finger.
            if inStart, inEnd, let start, let end {
                return distance(.end, end) < distance(.start, start) ? grab(.end, end) : grab(.start, start)
            }
            if inStart, let start { return grab(.start, start) }
            if inEnd, let end { return grab(.end, end) }
        }
        return nil
    }

    /// What the menu points at: all of the selection, 12 clear above and below.
    public static func menuAnchor(_ rects: [CGRect]) -> CGRect? {
        guard let first = rects.first else { return nil }
        return rects.dropFirst().reduce(first) { $0.union($1) }.insetBy(dx: 0, dy: -Metrics.menuClearance)
    }
}

/// A message's selectable texts as one run of characters, and what copying
/// part of it puts on the pasteboard. Each piece is one drawn text (a
/// paragraph, a list item, a cell, a code block): its characters are
/// indexed one after the other with nothing between them, and copying
/// puts back what the drawing leaves out, its `joiner` before it after
/// another piece and its `lead` (a list item's marker) when its start is
/// copied.
public struct SelectionText: Equatable, Sendable {
    public struct Piece: Equatable, Sendable {
        public var text: String
        /// Copied before the piece when its first character is.
        public var lead: String
        /// Copied between the piece before and this one.
        public var joiner: String

        public init(_ text: String, lead: String = "", joiner: String = "\n\n") {
            self.text = text
            self.lead = lead
            self.joiner = joiner
        }

        /// Characters as the layouts count them.
        var length: Int { text.utf16.count }
    }

    public let pieces: [Piece]
    /// Where each piece starts in the run.
    public let starts: [Int]
    public let length: Int

    public init(_ pieces: [Piece]) {
        self.pieces = pieces
        var starts: [Int] = []
        var at = 0
        for piece in pieces {
            starts.append(at)
            at += piece.length
        }
        self.starts = starts
        length = at
    }

    /// The part of `range` in each piece, in its own characters.
    public func split(_ range: Range<Int>) -> [(piece: Int, range: Range<Int>)] {
        var parts: [(piece: Int, range: Range<Int>)] = []
        for (index, piece) in pieces.enumerated() {
            let start = starts[index]
            let lower = max(range.lowerBound, start)
            let upper = min(range.upperBound, start + piece.length)
            if lower < upper { parts.append((index, (lower - start)..<(upper - start))) }
        }
        return parts
    }

    /// The piece a run index falls in and its index there; the run's end
    /// is the last piece's end.
    public func locate(_ index: Int) -> (piece: Int, offset: Int)? {
        guard !pieces.isEmpty else { return nil }
        let index = min(max(0, index), length)
        let piece = pieces.indices.last { starts[$0] <= index } ?? 0
        return (piece, index - starts[piece])
    }

    /// What copying `range` gives, as plain text.
    public func copy(_ range: Range<Int>) -> String {
        var result = ""
        for (number, part) in split(range).enumerated() {
            let piece = pieces[part.piece]
            if number > 0 { result += piece.joiner }
            if part.range.lowerBound == 0 { result += piece.lead }
            result += (piece.text as NSString).substring(with: NSRange(location: part.range.lowerBound, length: part.range.count))
        }
        return result
    }
}
