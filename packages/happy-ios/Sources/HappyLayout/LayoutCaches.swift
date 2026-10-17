import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// A layout made at a width and kept until the content changes, so asking
/// again at that width measures nothing (AGENTS.md rule 8). It keeps the
/// last two widths: a list asks a section for its size, and the section then
/// lays itself out at that width, or at the width snapped to the screen.
///
/// `make` runs outside any access to the cache, so a view it measures may
/// invalidate the cache meanwhile (a label drawing for the first time asks
/// its superview for layout). A layout made across an invalidation is
/// returned but not kept: the next ask measures again.
public struct WidthLayoutCache<Layout> {
    private var entries: [(width: CGFloat, layout: Layout)] = []
    /// Bumped by every invalidation, so a layout made across one is known.
    private var generation = 0
    /// Layouts made so far (tests).
    public private(set) var made = 0

    public init() {}

    /// The layout kept for `width`, if any.
    public func cached(width: CGFloat) -> Layout? {
        entries.first(where: { $0.width == width })?.layout
    }

    /// `make(width)`, kept unless the cache was invalidated while it ran.
    /// Static so that `make` runs with no access to the cache open: the
    /// cache is reached through `cache` only before and after it.
    public static func layout<Owner: AnyObject>(
        _ owner: Owner,
        _ cache: ReferenceWritableKeyPath<Owner, WidthLayoutCache>,
        width: CGFloat,
        _ make: (CGFloat) -> Layout
    ) -> Layout {
        if let layout = owner[keyPath: cache].cached(width: width) { return layout }
        let generation = owner[keyPath: cache].generation
        let layout = make(width)
        owner[keyPath: cache].store(layout, width: width, madeAt: generation)
        return layout
    }

    /// As above, for a cache held in a local variable: nothing measured by
    /// `make` can reach it.
    public mutating func layout(width: CGFloat, _ make: (CGFloat) -> Layout) -> Layout {
        if let layout = cached(width: width) { return layout }
        let generation = generation
        let layout = make(width)
        store(layout, width: width, madeAt: generation)
        return layout
    }

    /// Keeps `layout`, made when the cache was at `madeAt`, unless it has
    /// been invalidated since.
    private mutating func store(_ layout: Layout, width: CGFloat, madeAt: Int) {
        made += 1
        guard madeAt == generation else { return }
        entries.append((width, layout))
        if entries.count > 2 { entries.removeFirst() }
    }

    /// The content changed: the next ask measures again.
    public mutating func invalidate() {
        entries = []
        generation += 1
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
    /// Bumped by every invalidation, so heights measured across one are
    /// known.
    private var generation = 0
    /// Sections measured so far (tests).
    public private(set) var measured = 0

    public init() {}

    /// One section's height may have changed.
    public mutating func invalidate(_ id: ID) {
        heights[id] = nil
        applied = nil
        generation += 1
    }

    /// Any section's height may have changed.
    public mutating func invalidateAll() {
        heights = [:]
        applied = nil
        generation += 1
    }

    /// The layout for these inputs, or nil when it is the one returned last.
    public mutating func layout(size: CGSize, safeArea: LayoutInsets, sections: [Section]) -> GroupedListLayout? {
        layout(size: size, safeArea: safeArea, ids: sections.map(\.id)) { sections[$0].content }
    }

    /// As above, asking for a section's content (by index) only when it is
    /// measured, so a pass with nothing to do makes nothing. For a cache
    /// held in a local variable: nothing measured can reach it.
    public mutating func layout(size: CGSize, safeArea: LayoutInsets, ids: [ID], content: (Int) -> Measurable) -> GroupedListLayout? {
        guard let plan = plan(size: size, safeArea: safeArea, ids: ids) else { return nil }
        let heights = plan.measure(content)
        return finish(plan, heights: heights)
    }

    /// As above, with the sections measured while no access to the cache
    /// is open, so a section measured may invalidate it (a label drawing
    /// for the first time asks the list for layout). Heights measured
    /// across an invalidation are used for this layout but not kept, and
    /// the next pass measures again.
    public static func layout<Owner: AnyObject>(
        _ owner: Owner,
        _ cache: ReferenceWritableKeyPath<Owner, GroupedListCache>,
        size: CGSize,
        safeArea: LayoutInsets,
        ids: [ID],
        content: (Int) -> Measurable
    ) -> GroupedListLayout? {
        guard let plan = owner[keyPath: cache].plan(size: size, safeArea: safeArea, ids: ids) else { return nil }
        let heights = plan.measure(content)
        return owner[keyPath: cache].finish(plan, heights: heights)
    }

    /// A pass's inputs, with the heights already known at its width.
    private struct Plan {
        var next: Applied
        var width: CGFloat
        var known: [CGFloat?]
        var generation: Int

        /// Every height: the known ones, and the rest measured, a section
        /// listed twice once.
        func measure(_ content: (Int) -> Measurable) -> [(height: CGFloat, measured: Bool)] {
            var made: [ID: CGFloat] = [:]
            return zip(next.ids, known).enumerated().map { index, pair in
                let (id, height) = pair
                if let height { return (height, false) }
                if let height = made[id] { return (height, false) }
                let measured = content(index).height(fitting: width)
                made[id] = measured
                return (measured, true)
            }
        }
    }

    private func plan(size: CGSize, safeArea: LayoutInsets, ids: [ID]) -> Plan? {
        let next = Applied(size: size, safeArea: safeArea, ids: ids)
        guard next != applied else { return nil }
        let width = GroupedListLayout.contentWidth(size: size, safeArea: safeArea)
        let known: [CGFloat?] = ids.map { id in
            guard let cached = heights[id], cached.width == width else { return nil }
            return cached.height
        }
        return Plan(next: next, width: width, known: known, generation: generation)
    }

    private mutating func finish(_ plan: Plan, heights measuredHeights: [(height: CGFloat, measured: Bool)]) -> GroupedListLayout {
        let ids = plan.next.ids
        var kept: [ID: (width: CGFloat, height: CGFloat)] = [:]
        var contents: [Measurable] = []
        for (id, entry) in zip(ids, measuredHeights) {
            if entry.measured { measured += 1 }
            kept[id] = (plan.width, entry.height)
            contents.append(.fixed(width: plan.width, height: entry.height))
        }
        if plan.generation == generation {
            heights = kept
            applied = plan.next
        }
        return GroupedListLayout(.init(size: plan.next.size, safeArea: plan.next.safeArea, sections: contents))
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
