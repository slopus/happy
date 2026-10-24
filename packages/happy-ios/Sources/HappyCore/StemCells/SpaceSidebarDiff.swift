import Foundation

/// A port of `diffSpaceSidebar.ts`: the operations that turn one document
/// into another by node ID. A client edits the tree, then sends the
/// difference, so its batch goes through the daemon's rebase and authorship
/// rules exactly as desktop's does.
extension SpaceSidebar {
    public struct DiffFailure: Error {}

    /// The operations that turn `current` into `proposed`. As few items as
    /// possible move, a section whose block travelled whole moves as one
    /// block, and only what changed is set. Applying the result to
    /// `current` gives `proposed` exactly.
    public static func diff(_ current: SpaceSidebarDocument, _ proposed: SpaceSidebarDocument, widgets: Bool = true) throws -> [SpaceSidebarOperation] {
        let keepWidgets = !widgets
        if keepWidgets && proposed.items.contains(where: { $0.kind == .widget }) {
            throw SpaceSidebarError("This write cannot contain widgets.")
        }
        let wanted = format(proposed, widgets: !keepWidgets)
        for blocks in [true, false] {
            let operations: [SpaceSidebarOperation]
            do {
                operations = try plan(current, proposed, keepWidgets: keepWidgets, blocks: blocks)
            } catch let error as SpaceSidebarError where blocks {
                _ = error
                continue
            }
            let document = try apply(current, operations).document
            if format(document, widgets: !keepWidgets) == wanted { return operations }
        }
        throw DiffFailure()
    }

    private static func plan(_ current: SpaceSidebarDocument, _ proposed: SpaceSidebarDocument, keepWidgets: Bool, blocks: Bool) throws -> [SpaceSidebarOperation] {
        var working = current
        var operations: [SpaceSidebarOperation] = []
        func emit(_ operation: SpaceSidebarOperation) throws {
            if try applyOperation(&working, operation, base: nil, index: operations.count) != nil { operations.append(operation) }
        }
        func visible(_ items: [SpaceSidebarNode]) -> [SpaceSidebarNode] { keepWidgets ? items.filter { $0.kind != .widget } : items }
        func place(_ node: SpaceSidebarNode, _ to: SpaceSidebarPosition) throws {
            try emit(locate(working, node.id) != nil ? .move(node.id, to: to) : .insert(try newNode(node), to: to))
        }

        let target = visible(proposed.items)
        if blocks {
            for step in try topLevelUnits(visible(current.items), target) { try place(step.node, step.to) }
        } else {
            // Item by item: each item lands right after the one before it.
            for (index, node) in target.enumerated() {
                let now = visible(working.items)
                if now.indices.contains(index) && now[index].id == node.id { continue }
                try place(node, index == 0 ? .parent(nil) : .after(target[index - 1].id))
            }
        }

        // Each row's and session's nested sessions, top down.
        func nest(_ parent: SpaceSidebarNode) throws {
            let holder = node(working, at: locate(working, parent.id)!.path)
            let wanted = parent.children.map(\.id)
            let present = holder.children.map(\.id).filter { wanted.contains($0) }
            let still = stationary(present, wanted.filter { present.contains($0) })
            for (index, child) in parent.children.enumerated() where !still.contains(child.id) {
                try place(child, index == 0 ? .parent(parent.id) : .after(parent.children[index - 1].id))
            }
            for child in parent.children { try nest(child) }
        }
        for item in target where item.kind == .space { try nest(item) }

        // Switches and text.
        func settle(_ wanted: SpaceSidebarNode) throws {
            let now = node(working, at: locate(working, wanted.id)!.path)
            if let fields = changedFields(now, wanted) { try emit(.set(fields)) }
            if wanted.kind == .space { for child in wanted.children { try settle(child) } }
        }
        for item in target { try settle(item) }
        if working.foldRibbon != proposed.foldRibbon {
            try emit(.set(SpaceSidebarSet(id: "nav", foldRibbon: proposed.foldRibbon.map(SpaceSidebarRibbonPatch.value) ?? .clear)))
        }

        // Whatever the proposal left out, outermost first.
        var kept = Set<String>()
        func collect(_ node: SpaceSidebarNode) {
            kept.insert(node.id)
            if node.kind == .space { node.children.forEach(collect) }
        }
        proposed.items.forEach(collect)
        var leaving: [String] = []
        func sweep(_ node: SpaceSidebarNode) {
            if keepWidgets && node.kind == .widget { return }
            if !kept.contains(node.id) { leaving.append(node.id) } else if node.kind == .space { node.children.forEach(sweep) }
        }
        working.items.forEach(sweep)
        for id in leaving { try emit(.remove(id)) }
        return operations
    }

    private struct Unit {
        var id: String
        var node: SpaceSidebarNode
        var last: String
    }

    /// The top-level moves and inserts, block by block (`topLevelUnits`).
    private static func topLevelUnits(_ current: [SpaceSidebarNode], _ proposed: [SpaceSidebarNode]) throws -> [(node: SpaceSidebarNode, to: SpaceSidebarPosition)] {
        func runOf(_ items: [SpaceSidebarNode], _ index: Int) -> [String] {
            let length = runLength(items, index)
            return items[(index + 1)..<(index + length)].map(\.id)
        }
        var currentRuns: [String: [String]] = [:]
        for (index, item) in current.enumerated() where item.kind == .section { currentRuns[item.id] = runOf(current, index) }
        var whole = Set<String>()
        for (index, item) in proposed.enumerated() {
            guard let before = currentRuns[item.id] else { continue }
            let after = runOf(proposed, index)
            if before.enumerated().allSatisfy({ after.indices.contains($0.offset) && after[$0.offset] == $0.element }) { whole.insert(item.id) }
        }
        func units(_ items: [SpaceSidebarNode]) -> [Unit] {
            var result: [Unit] = []
            var index = 0
            while index < items.count {
                let item = items[index]
                let run = whole.contains(item.id) ? currentRuns[item.id]! : []
                result.append(Unit(id: item.id, node: item, last: run.last ?? item.id))
                index += run.count + 1
            }
            return result
        }
        let before = units(current)
        let after = units(proposed)
        let known = Set(before.map(\.id))
        let afterIds = Set(after.map(\.id))
        let still = stationary(before.map(\.id).filter { afterIds.contains($0) }, after.map(\.id).filter { known.contains($0) })
        for unit in after where unit.node.kind == .section && known.contains(unit.id) && !still.contains(unit.id) && !whole.contains(unit.id) {
            throw SpaceSidebarError("Section \(unit.id) moved without its block.")
        }
        var steps: [(node: SpaceSidebarNode, to: SpaceSidebarPosition)] = []
        var previous: String?
        for unit in after {
            if !still.contains(unit.id) { steps.append((unit.node, previous.map(SpaceSidebarPosition.after) ?? .parent(nil))) }
            previous = unit.last
        }
        return steps
    }

    /// The longest subsequence of `before` that `after` keeps in order,
    /// with the reference implementation's tie-breaking.
    static func stationary(_ before: [String], _ after: [String]) -> Set<String> {
        var positions: [String: Int] = [:]
        for (index, id) in before.enumerated() { positions[id] = index }
        var lengths = after.map { _ in 1 }
        var previous = after.map { _ in -1 }
        var best = -1
        for index in after.indices {
            for earlier in 0..<index where positions[after[earlier]]! < positions[after[index]]! && lengths[earlier] + 1 > lengths[index] {
                lengths[index] = lengths[earlier] + 1
                previous[index] = earlier
            }
            if best == -1 || lengths[index] > lengths[best] { best = index }
        }
        var kept = Set<String>()
        var index = best
        while index != -1 {
            kept.insert(after[index])
            index = previous[index]
        }
        return kept
    }

    private static func newNode(_ node: SpaceSidebarNode) throws -> SpaceSidebarNewNode {
        switch node.kind {
        case .space: SpaceSidebarNewNode(kind: .space, id: node.id, expanded: node.expanded ? true : nil, foldRibbon: node.foldRibbon)
        case .section: SpaceSidebarNewNode(kind: .section, id: node.id, label: node.label, collapsed: node.collapsed ? true : nil)
        case .separator: SpaceSidebarNewNode(kind: .separator, id: node.id)
        case .widget: SpaceSidebarNewNode(kind: .widget, id: node.id, html: node.html)
        case .search, .create: throw SpaceSidebarError("The sidebar needs exactly one \(node.id).")
        }
    }

    private static func changedFields(_ now: SpaceSidebarNode, _ wanted: SpaceSidebarNode) -> SpaceSidebarSet? {
        var fields = SpaceSidebarSet(id: wanted.id)
        if now.kind == .section && wanted.kind == .section {
            if now.label != wanted.label { fields.label = wanted.label }
            if now.collapsed != wanted.collapsed { fields.collapsed = wanted.collapsed }
        } else if now.kind == .space && wanted.kind == .space {
            if now.expanded != wanted.expanded { fields.expanded = wanted.expanded }
            if now.foldRibbon != wanted.foldRibbon { fields.foldRibbon = wanted.foldRibbon.map(SpaceSidebarRibbonPatch.value) ?? .clear }
        } else if now.kind == .widget && wanted.kind == .widget && now.html != wanted.html {
            fields.html = wanted.html
        }
        return fields.isEmpty ? nil : fields
    }
}
