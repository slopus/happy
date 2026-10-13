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

    public init(width: CGFloat, text: Measurable) {
        typealias M = Metrics
        let boxWidth = max(0, width - M.marginHorizontal * 2)
        let textHeight = text.height(fitting: max(0, boxWidth - M.padding * 2))
        box = CGRect(x: M.marginHorizontal, y: 0, width: boxWidth, height: textHeight + M.padding * 2)
        self.text = CGRect(x: M.marginHorizontal + M.padding, y: M.padding, width: max(0, boxWidth - M.padding * 2), height: textHeight)
        size = CGSize(width: max(0, width), height: box.height + M.marginBottom)
    }
}
