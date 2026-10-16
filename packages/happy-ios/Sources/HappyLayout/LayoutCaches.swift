import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A layout made at a width and kept until the content changes, so asking
/// again at that width measures nothing (AGENTS.md rule 8). It keeps the
/// last two widths: a list asks a section for its size, and the section then
/// lays itself out at that width, or at the width snapped to the screen.
public struct WidthLayoutCache<Layout> {
    private var entries: [(width: CGFloat, layout: Layout)] = []
    /// Layouts made so far (tests).
    public private(set) var made = 0

    public init() {}

    public mutating func layout(width: CGFloat, _ make: (CGFloat) -> Layout) -> Layout {
        if let entry = entries.first(where: { $0.width == width }) { return entry.layout }
        let layout = make(width)
        made += 1
        entries.append((width, layout))
        if entries.count > 2 { entries.removeFirst() }
        return layout
    }

    /// The content changed: the next ask measures again.
    public mutating func invalidate() {
        entries = []
    }
}

/// `GroupedListLayout` with each section measured once per width.
///
/// - A pass with the size, safe area and sections of the pass before it
///   measures nothing and returns nil: there is nothing to apply. That is
///   every scroll frame.
/// - A new width measures every section once.
/// - A section that joined, or that said it changed (`invalidate`), is
///   the only one measured; the others keep their heights, wherever they
///   moved to.
/// - A section that left is forgotten.
public struct GroupedListCache<ID: Hashable> {
    public struct Section {
        public var id: ID
        public var content: Measurable

        public init(id: ID, content: Measurable) {
            self.id = id
            self.content = content
        }
    }

    private struct Applied: Equatable {
        var size: CGSize
        var safeArea: LayoutInsets
        var ids: [ID]
    }

    private var heights: [ID: (width: CGFloat, height: CGFloat)] = [:]
    private var applied: Applied?
    /// Sections measured so far (tests).
    public private(set) var measured = 0

    public init() {}

    /// One section's height may have changed.
    public mutating func invalidate(_ id: ID) {
        heights[id] = nil
        applied = nil
    }

    /// Any section's height may have changed.
    public mutating func invalidateAll() {
        heights = [:]
        applied = nil
    }

    /// The layout for these inputs, or nil when it is the one returned last.
    public mutating func layout(size: CGSize, safeArea: LayoutInsets, sections: [Section]) -> GroupedListLayout? {
        layout(size: size, safeArea: safeArea, ids: sections.map(\.id)) { sections[$0].content }
    }

    /// As above, asking for a section's content (by index) only when it is
    /// measured, so a pass with nothing to do makes nothing.
    public mutating func layout(size: CGSize, safeArea: LayoutInsets, ids: [ID], content: (Int) -> Measurable) -> GroupedListLayout? {
        let next = Applied(size: size, safeArea: safeArea, ids: ids)
        guard next != applied else { return nil }
        let width = GroupedListLayout.contentWidth(size: size, safeArea: safeArea)
        var kept: [ID: (width: CGFloat, height: CGFloat)] = [:]
        var contents: [Measurable] = []
        for (index, id) in ids.enumerated() {
            let height: CGFloat
            if let cached = heights[id] ?? kept[id], cached.width == width {
                height = cached.height
            } else {
                height = content(index).height(fitting: width)
                measured += 1
            }
            kept[id] = (width, height)
            contents.append(.fixed(width: width, height: height))
        }
        heights = kept
        applied = next
        return GroupedListLayout(.init(size: size, safeArea: safeArea, sections: contents))
    }
}

/// Which sections of a long list draw their content. A section within one
/// screen of what shows starts drawing; one that draws keeps drawing until
/// it is more than two screens away, so scrolling to and fro near that edge
/// doesn't draw it again and again. A section with no height draws nothing.
public enum DrawnSections {
    public static func update(_ drawn: Set<Int>, frames: [CGRect], visible: CGRect) -> Set<Int> {
        var result = Set<Int>()
        for (index, frame) in frames.enumerated() where frame.height > 0 {
            let reach = visible.height * (drawn.contains(index) ? 2 : 1)
            if frame.minY < visible.maxY + reach, frame.maxY > visible.minY - reach {
                result.insert(index)
            }
        }
        return result
    }
}
