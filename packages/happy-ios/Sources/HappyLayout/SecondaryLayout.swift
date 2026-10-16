import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

// Layouts for the screens around a session and a machine: session info,
// the machine screen, the file viewer and changes.

/// A column of content centred in a screen, each item centred on its own
/// line: `<View style={{ flex: 1, alignItems: 'center', justifyContent:
/// 'center', padding }}>` holding an icon or spinner and some text. Used by
/// info.tsx's loading and deleted states, the machine screen's "not found"
/// and the file viewer's loading, error and binary states.
public struct CenteredStackLayout: Equatable, Sendable {
    public struct Item {
        public var content: Measurable
        /// `marginTop` (or the previous item's `marginBottom`).
        public var spacingBefore: CGFloat
        /// The item's own `paddingHorizontal`, which narrows its text but
        /// still counts in its box.
        public var horizontalPadding: CGFloat

        public init(_ content: Measurable, spacingBefore: CGFloat = 0, horizontalPadding: CGFloat = 0) {
            self.content = content
            self.spacingBefore = spacingBefore
            self.horizontalPadding = horizontalPadding
        }
    }

    public struct Input {
        public var size: CGSize
        public var padding: CGFloat
        public var items: [Item]

        public init(size: CGSize, padding: CGFloat = 0, items: [Item]) {
            self.size = size
            self.padding = padding
            self.items = items
        }
    }

    /// Where each item's content goes (inside its horizontal padding).
    public var items: [CGRect]

    public init(_ input: Input) {
        let width = max(0, input.size.width - input.padding * 2)
        var sizes: [CGSize] = []
        var total: CGFloat = 0
        for (index, item) in input.items.enumerated() {
            let size = item.content.size(fitting: max(0, width - item.horizontalPadding * 2))
            sizes.append(size)
            total += size.height + (index == 0 ? 0 : item.spacingBefore)
        }
        var y = input.padding + (max(0, input.size.height - input.padding * 2) - total) / 2
        var frames: [CGRect] = []
        for (index, item) in input.items.enumerated() {
            if index > 0 { y += item.spacingBefore }
            let size = sizes[index]
            frames.append(CGRect(x: (input.size.width - size.width) / 2, y: y, width: size.width, height: size.height))
            y += size.height
        }
        items = frames
    }
}

/// A row of fixed-size parts with a gap between them, centred vertically:
/// `flexDirection: 'row', alignItems: 'center', gap`. GitLineChanges (gap
/// 4) and the Changes row's right element (gap 6) are built from it.
public struct HorizontalStackLayout: Equatable, Sendable {
    public var size: CGSize
    public var items: [CGRect]

    public init(_ sizes: [CGSize], spacing: CGFloat) {
        let height = sizes.map(\.height).max() ?? 0
        var x: CGFloat = 0
        var frames: [CGRect] = []
        for (index, size) in sizes.enumerated() {
            if index > 0 { x += spacing }
            frames.append(CGRect(x: x, y: (height - size.height) / 2, width: size.width, height: size.height))
            x += size.width
        }
        size = CGSize(width: x, height: height)
        items = frames
    }
}

/// components/CodeView.tsx as info.tsx places it inside an item group:
/// `<View style={{ marginHorizontal: 16, marginBottom: 12 }}>` around a
/// `surfaceHigh` box with radius 6 and padding 12, Menlo 12/18 inside.
/// The text comes in pieces (`TextChunks`) stacked with no gap, so a block
/// megabytes long is drawn only where it is near the screen.
public struct CodeBlockLayout: Equatable, Sendable {
    public enum Metrics {
        public static let marginHorizontal: CGFloat = 16
        public static let marginBottom: CGFloat = 12
        public static let padding: CGFloat = 12
        public static let cornerRadius: CGFloat = 6
        public static let fontSize: CGFloat = 12
        public static let lineHeight: CGFloat = 18
    }

    public var size: CGSize
    public var box: CGRect
    public var text: CGRect
    /// Each piece of the text, top to bottom.
    public var pieces: [CGRect]

    /// The width the text wraps at in a block `width` wide.
    public static func textWidth(_ width: CGFloat) -> CGFloat {
        max(0, width - Metrics.marginHorizontal * 2 - Metrics.padding * 2)
    }

    /// `heights` are the pieces' heights at `textWidth(width)`.
    public init(width: CGFloat, pieces heights: [CGFloat]) {
        typealias M = Metrics
        let boxWidth = max(0, width - M.marginHorizontal * 2)
        let textWidth = Self.textWidth(width)
        var y = M.padding
        pieces = heights.map { height in
            defer { y += height }
            return CGRect(x: M.marginHorizontal + M.padding, y: y, width: textWidth, height: height)
        }
        let textHeight = y - M.padding
        box = CGRect(x: M.marginHorizontal, y: 0, width: boxWidth, height: textHeight + M.padding * 2)
        text = CGRect(x: M.marginHorizontal + M.padding, y: M.padding, width: textWidth, height: textHeight)
        size = CGSize(width: max(0, width), height: box.height + M.marginBottom)
    }

    /// The pieces that meet `minY..<maxY`, in the block's coordinates.
    public func pieces(from minY: CGFloat, to maxY: CGFloat) -> Range<Int> {
        guard maxY > minY else { return 0..<0 }
        // The first piece ending below `minY`, then the first starting at
        // or below `maxY`; both by halving, as a block can have hundreds.
        let first = firstPiece { $0.maxY > minY }
        let last = firstPiece { $0.minY >= maxY }
        return first..<max(first, last)
    }

    private func firstPiece(where isPast: (CGRect) -> Bool) -> Int {
        var low = 0
        var high = pieces.count
        while low < high {
            let middle = (low + high) / 2
            if isPast(pieces[middle]) { high = middle } else { low = middle + 1 }
        }
        return low
    }
}
