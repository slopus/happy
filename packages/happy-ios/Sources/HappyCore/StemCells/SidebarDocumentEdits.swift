import Foundation

/// The person's edits of the document, as desktop makes them
/// (`happy-desktop-state/src/spaces/spacesSidebarDocument.ts`). Each returns
/// the edited document, or nil when the edit names nothing or changes
/// nothing. The store sends the difference as operations.
///
/// Node IDs are unique across the document, so a node is named by its ID;
/// Search and Create by `happy-search` and `happy-create`.
public enum SidebarDocumentEdits {
    /// Where a folded section's run stops: at the next section or separator.
    private static func breaksRun(_ node: SpaceSidebarNode) -> Bool { node.kind == .section || node.kind == .separator }

    /// Where the rows after `index` stop belonging to it.
    static func blockEnd(_ nodes: [SpaceSidebarNode], _ index: Int) -> Int {
        var end = index + 1
        while end < nodes.count && !breaksRun(nodes[end]) { end += 1 }
        return end
    }

    /// The node itself, with the run it folds away when it is a folded section.
    static func runEnd(_ nodes: [SpaceSidebarNode], _ index: Int) -> Int {
        nodes.indices.contains(index) && nodes[index].kind == .section && nodes[index].collapsed ? blockEnd(nodes, index) : index + 1
    }

    /// Moves one node among its own siblings, after `afterId` or first. A
    /// section is a block: its heading and every row after it up to the
    /// next section or separator move as one, and it lands after the whole
    /// block `afterId` belongs to. Any other node landing after a folded
    /// section lands after its run, so a move never hides or reveals rows.
    public static func move(_ document: SpaceSidebarDocument, _ id: String, after afterId: String?) -> SpaceSidebarDocument? {
        if id == afterId { return nil }
        guard let location = SpaceSidebar.locate(document, id) else { return nil }
        let nodes = SpaceSidebar.siblings(document, location.parentPath)
        let from = location.index
        let section = nodes[from].kind == .section
        let end = section ? blockEnd(nodes, from) : runEnd(nodes, from)
        let moved = Array(nodes[from..<end])
        let rest = Array(nodes[..<from]) + Array(nodes[end...])
        var at = 0
        if let afterId {
            guard let after = rest.firstIndex(where: { $0.id == afterId }) else { return nil }
            // Search and Create carry no run: what lands after one lands right there.
            let hidden = rest[after].kind == .search || rest[after].kind == .create
            at = hidden ? after + 1 : section && rest[after].kind != .separator ? blockEnd(rest, after) : runEnd(rest, after)
        }
        let result = Array(rest[..<at]) + moved + Array(rest[at...])
        if result.map(\.id) == nodes.map(\.id) { return nil }
        var edited = document
        SpaceSidebar.withSiblings(&edited, location.parentPath) { $0 = result }
        return edited
    }

    /// Folds or unfolds a section's run, or a row's or session's nested rows.
    public static func fold(_ document: SpaceSidebarDocument, _ id: String) -> SpaceSidebarDocument? {
        guard let location = SpaceSidebar.locate(document, id) else { return nil }
        var edited = document
        SpaceSidebar.withNode(&edited, location.path) { node in
            if node.kind == .section { node.collapsed.toggle() } else if node.kind == .space { node.expanded.toggle() }
        }
        return edited
    }

    /// Deletes a section's heading: its rows stay where they are and join
    /// the block above (the daemon's `remove` of a section).
    public static func removeSection(_ document: SpaceSidebarDocument, _ id: String) -> SpaceSidebarDocument? {
        guard let index = document.items.firstIndex(where: { $0.id == id && $0.kind == .section }) else { return nil }
        var edited = document
        edited.items.remove(at: index)
        return edited
    }

    /// Renames a section's heading.
    public static func relabel(_ document: SpaceSidebarDocument, _ id: String, label: String) -> SpaceSidebarDocument? {
        guard let index = document.items.firstIndex(where: { $0.id == id && $0.kind == .section }) else { return nil }
        var edited = document
        edited.items[index].label = label
        return edited
    }

    /// Sets a row or attachment down under another parent: under
    /// `parentId`, after its nested node `afterId` or first, or for nil at
    /// the top level, after the item `afterId` or first. Among its own
    /// siblings it is an ordinary move.
    public static func place(_ document: SpaceSidebarDocument, _ id: String, parent parentId: String?, after afterId: String?) -> SpaceSidebarDocument? {
        guard let from = SpaceSidebar.locate(document, id) else { return nil }
        let fromParent: String? = from.parentId == "nav" ? nil : from.parentId
        if fromParent == parentId { return move(document, id, after: afterId) }
        let node = SpaceSidebar.node(document, at: from.path)
        guard node.kind == .space else { return nil }
        if let parentId, SpaceSidebar.contains(node, parentId) { return nil }
        var lifted = document
        SpaceSidebar.withSiblings(&lifted, from.parentPath) { _ = $0.remove(at: from.index) }
        guard let parentId else {
            var at = 0
            if let afterId {
                guard let after = lifted.items.firstIndex(where: { $0.id == afterId }) else { return nil }
                at = runEnd(lifted.items, after)
            }
            lifted.items.insert(node, at: at)
            return lifted
        }
        guard let host = SpaceSidebar.locate(lifted, parentId), SpaceSidebar.node(lifted, at: host.path).kind == .space else { return nil }
        var at = 0
        if let afterId {
            guard let after = SpaceSidebar.node(lifted, at: host.path).children.firstIndex(where: { $0.id == afterId }) else { return nil }
            at = after + 1
        }
        SpaceSidebar.withNode(&lifted, host.path) { parent in
            parent.expanded = true
            parent.children.insert(node, at: at)
        }
        return lifted
    }

    /// Names new work before the document read catches up, where the daemon
    /// puts it: right after the named section or separator; otherwise right
    /// after Happy's own top-level row; otherwise — Happy absent or folded
    /// away under a section — right after Create, and first when there is
    /// no Create.
    public static func insert(_ document: SpaceSidebarDocument, spaceId: String, sectionId: String?, happySpaceId: String?) -> SpaceSidebarDocument? {
        if document.items.contains(where: { $0.kind == .space && $0.id == spaceId }) { return nil }
        func after() -> Int {
            if let sectionId {
                return document.items.firstIndex { ($0.kind == .section || $0.kind == .separator) && $0.id == sectionId } ?? -1
            }
            var folded = false
            for (index, item) in document.items.enumerated() {
                if item.kind == .section { folded = item.collapsed } else if item.kind == .separator { folded = false } else if item.kind == .space && item.id == happySpaceId && !folded { return index }
            }
            return document.items.firstIndex { $0.kind == .create } ?? -1
        }
        var edited = document
        edited.items.insert(.space(spaceId), at: after() + 1)
        return edited
    }

    /// Shows every session of the row or session `id`: each one the
    /// document does not hold yet joins its parent's nested nodes, after
    /// the ones already there, and every node a session joined under opens.
    public static func revealSessions(_ document: SpaceSidebarDocument, _ id: String, sessions: [SessionTree]) -> SpaceSidebarDocument? {
        guard let location = SpaceSidebar.locate(document, id), SpaceSidebar.node(document, at: location.path).kind == .space else { return nil }
        var held = Set<String>()
        func hold(_ node: SpaceSidebarNode) {
            guard node.kind == .space else { return }
            held.insert(node.id)
            node.children.forEach(hold)
        }
        document.items.forEach(hold)
        func reveal(_ node: SpaceSidebarNode, _ wanted: [SessionTree]) -> SpaceSidebarNode? {
            var grew = false
            var children = node.children.map { child -> SpaceSidebarNode in
                guard let tree = wanted.first(where: { $0.id == child.id }), let next = reveal(child, tree.children) else { return child }
                grew = true
                return next
            }
            var added = false
            // Filtered before any is held, as desktop's `filter` then `map` does.
            let missing = wanted.filter { !held.contains($0.id) }
            for session in missing {
                held.insert(session.id)
                let fresh = SpaceSidebarNode.space(session.id)
                children.append(reveal(fresh, session.children) ?? fresh)
                added = true
            }
            guard grew || added else { return nil }
            var next = node
            next.expanded = true
            next.children = children
            return next
        }
        guard let revealed = reveal(SpaceSidebar.node(document, at: location.path), sessions) else { return nil }
        var edited = document
        SpaceSidebar.withNode(&edited, location.path) { $0 = revealed }
        return edited
    }

    /// `sidebarDocumentSessionsHide`: takes the sessions back out from under
    /// a row or session; a space nested under one of them (`attached`)
    /// takes its place. Nil when everything under it is a space.
    public static func hideSessions(_ document: SpaceSidebarDocument, _ id: String, attached: (String) -> Bool) -> SpaceSidebarDocument? {
        guard let location = SpaceSidebar.locate(document, id) else { return nil }
        let node = SpaceSidebar.node(document, at: location.path)
        guard node.kind == .space, !node.children.allSatisfy({ attached($0.id) }) else { return nil }
        func kept(_ nodes: [SpaceSidebarNode]) -> [SpaceSidebarNode] {
            nodes.flatMap { attached($0.id) ? [$0] : kept($0.children) }
        }
        var hidden = node
        hidden.children = kept(node.children)
        var edited = document
        SpaceSidebar.withNode(&edited, location.path) { $0 = hidden }
        return edited
    }

    /// A conversation's sessions as they nest, by agent ID.
    public struct SessionTree: Equatable, Sendable {
        public var id: String
        public var children: [SessionTree]
        public init(id: String, children: [SessionTree] = []) {
            self.id = id
            self.children = children
        }
    }
}
