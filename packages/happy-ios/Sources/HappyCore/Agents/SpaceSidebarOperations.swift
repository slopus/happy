import Foundation
import HappyWire

/// Where an inserted or moved node goes: immediately after a node and
/// everything nested in it, or first under a row or session (`nil`: first
/// in the list).
public enum SpaceSidebarPosition: Equatable, Sendable {
    case after(String)
    case parent(String?)
}

/// A node an `insert` adds. Only the fields its kind has are written.
public struct SpaceSidebarNewNode: Equatable, Sendable {
    public var kind: SpaceSidebarNode.Kind
    public var id: String
    public var expanded: Bool?
    public var foldRibbon: SpaceSidebarFoldRibbon?
    public var label: String?
    public var collapsed: Bool?
    public var html: String?

    public init(kind: SpaceSidebarNode.Kind, id: String, expanded: Bool? = nil, foldRibbon: SpaceSidebarFoldRibbon? = nil, label: String? = nil, collapsed: Bool? = nil, html: String? = nil) {
        self.kind = kind
        self.id = id
        self.expanded = expanded
        self.foldRibbon = foldRibbon
        self.label = label
        self.collapsed = collapsed
        self.html = html
    }

    public static func space(_ id: String, expanded: Bool? = nil) -> SpaceSidebarNewNode { SpaceSidebarNewNode(kind: .space, id: id, expanded: expanded) }
}

/// A `set`'s optional `foldRibbon`: absent, `null` (back to the default), or a value.
public enum SpaceSidebarRibbonPatch: Equatable, Sendable {
    case clear
    case value(SpaceSidebarFoldRibbon)
}

public struct SpaceSidebarSet: Equatable, Sendable {
    public var id: String
    public var label: String?
    public var collapsed: Bool?
    public var expanded: Bool?
    public var foldRibbon: SpaceSidebarRibbonPatch?
    public var html: String?

    public init(id: String, label: String? = nil, collapsed: Bool? = nil, expanded: Bool? = nil, foldRibbon: SpaceSidebarRibbonPatch? = nil, html: String? = nil) {
        self.id = id
        self.label = label
        self.collapsed = collapsed
        self.expanded = expanded
        self.foldRibbon = foldRibbon
        self.html = html
    }

    var isEmpty: Bool { label == nil && collapsed == nil && expanded == nil && foldRibbon == nil && html == nil }
}

/// One change to the sidebar document, keyed by node ID.
public enum SpaceSidebarOperation: Equatable, Sendable {
    case insert(SpaceSidebarNewNode, to: SpaceSidebarPosition)
    case move(String, to: SpaceSidebarPosition)
    case remove(String)
    case set(SpaceSidebarSet)

    var describe: String {
        switch self {
        case .insert(let node, _): "insert \(node.id)"
        case .move(let id, _): "move \(id)"
        case .remove(let id): "remove \(id)"
        case .set(let fields): "set \(fields.id)"
        }
    }
}

/// The document a batch produced, and the operations that changed it, as
/// they applied: an `after` anchor that fell back is replaced by the
/// position used, and operations that changed nothing are left out.
public struct SpaceSidebarApplication: Equatable, Sendable {
    public var document: SpaceSidebarDocument
    public var operations: [SpaceSidebarOperation]
}

extension SpaceSidebar {
    /// Applies `operations` in order to `document`. With `base` — the version
    /// the operations were made against — an `after` anchor that is gone
    /// falls back to the nearest node that preceded it among its siblings in
    /// `base` and still sits under the same parent, or first under that
    /// parent. Throws for the first operation that cannot apply.
    public static func apply(_ document: SpaceSidebarDocument, _ operations: [SpaceSidebarOperation], base: SpaceSidebarDocument? = nil) throws -> SpaceSidebarApplication {
        var working = document
        var applied: [SpaceSidebarOperation] = []
        for (index, operation) in operations.enumerated() {
            if let done = try applyOperation(&working, operation, base: base, index: index) { applied.append(done) }
        }
        if format(working).utf8.count > maxBytes {
            var probe = document
            for (index, operation) in operations.enumerated() {
                _ = try applyOperation(&probe, operation, base: base, index: index)
                if format(probe).utf8.count > maxBytes {
                    throw operationError(index, operation, "the sidebar would exceed 128 KiB.")
                }
            }
        }
        return SpaceSidebarApplication(document: working, operations: applied)
    }

    static func operationError(_ index: Int, _ operation: SpaceSidebarOperation, _ reason: String) -> SpaceSidebarError {
        SpaceSidebarError("Operation \(index) (\(operation.describe)) cannot apply: \(reason)", operationIndex: index)
    }

    /// Applies one operation in place; returns it as applied, or nil when it changed nothing.
    static func applyOperation(_ document: inout SpaceSidebarDocument, _ operation: SpaceSidebarOperation, base: SpaceSidebarDocument?, index: Int) throws -> SpaceSidebarOperation? {
        guard isValid(operation) else { throw operationError(index, operation, "it is not a valid sidebar operation.") }
        do {
            switch operation {
            case .insert(let node, let to): return try insert(&document, node, to: to, base: base)
            case .move(let id, let to): return try move(&document, id, to: to, base: base)
            case .remove(let id): return try remove(&document, id)
            case .set(let fields): return try set(&document, fields)
            }
        } catch let error as SpaceSidebarError where error.operationIndex == nil {
            throw operationError(index, operation, error.message)
        }
    }

    /// `spaceSidebarOperationSchema`.
    private static func isValid(_ operation: SpaceSidebarOperation) -> Bool {
        func position(_ to: SpaceSidebarPosition) -> Bool {
            switch to {
            case .after(let id): isValidID(id)
            case .parent(let id): id.map(isValidID) ?? true
            }
        }
        switch operation {
        case .insert(let node, let to):
            guard isValidID(node.id), position(to) else { return false }
            switch node.kind {
            case .space: return node.label == nil && node.collapsed == nil && node.html == nil
            case .section: return node.label.map(isValidLabel) == true && node.expanded == nil && node.foldRibbon == nil && node.html == nil
            case .separator: return node.label == nil && node.collapsed == nil && node.expanded == nil && node.foldRibbon == nil && node.html == nil
            case .widget: return node.html.map { $0.utf16.count <= maxWidgetBytes } == true && node.label == nil && node.collapsed == nil && node.expanded == nil && node.foldRibbon == nil
            case .search, .create: return false
            }
        case .move(let id, let to): return isValidID(id) && position(to)
        case .remove(let id): return isValidID(id)
        case .set(let fields):
            return isValidID(fields.id) && (fields.label.map(isValidLabel) ?? true) && (fields.html.map { $0.utf16.count <= maxWidgetBytes } ?? true)
        }
    }

    // MARK: Locating

    /// Where a node sits: the path of indexes to it, its parent's ID (`nav`
    /// at the top), and its element depth (`nav` is 1, the top level 2).
    struct Location {
        var path: [Int]
        var parentId: String
        var depth: Int
        var index: Int { path.last! }
        var parentPath: [Int] { Array(path.dropLast()) }
    }

    static func locate(_ document: SpaceSidebarDocument, _ id: String) -> Location? {
        func search(_ nodes: [SpaceSidebarNode], _ path: [Int], _ parentId: String, _ depth: Int) -> Location? {
            for (index, node) in nodes.enumerated() {
                if node.id == id { return Location(path: path + [index], parentId: parentId, depth: depth) }
                if node.kind == .space, let found = search(node.children, path + [index], node.id, depth + 1) { return found }
            }
            return nil
        }
        return search(document.items, [], "nav", 2)
    }

    static func node(_ document: SpaceSidebarDocument, at path: [Int]) -> SpaceSidebarNode {
        var node = document.items[path[0]]
        for index in path.dropFirst() { node = node.children[index] }
        return node
    }

    static func siblings(_ document: SpaceSidebarDocument, _ parentPath: [Int]) -> [SpaceSidebarNode] {
        parentPath.isEmpty ? document.items : node(document, at: parentPath).children
    }

    static func withSiblings<T>(_ document: inout SpaceSidebarDocument, _ parentPath: [Int], _ body: (inout [SpaceSidebarNode]) throws -> T) rethrows -> T {
        func descend(_ nodes: inout [SpaceSidebarNode], _ path: ArraySlice<Int>) throws -> T {
            let index = path.first!
            if path.count == 1 { return try body(&nodes[index].children) }
            return try descend(&nodes[index].children, path.dropFirst())
        }
        if parentPath.isEmpty { return try body(&document.items) }
        return try descend(&document.items, parentPath[...])
    }

    static func withNode<T>(_ document: inout SpaceSidebarDocument, _ path: [Int], _ body: (inout SpaceSidebarNode) throws -> T) rethrows -> T {
        try withSiblings(&document, Array(path.dropLast())) { try body(&$0[path.last!]) }
    }

    /// How many items a move of the item at `index` takes along: a section
    /// takes its block, anything else only itself.
    static func runLength(_ siblings: [SpaceSidebarNode], _ index: Int) -> Int {
        guard siblings.indices.contains(index), siblings[index].kind == .section else { return 1 }
        var end = index + 1
        while end < siblings.count && siblings[end].kind != .section && siblings[end].kind != .separator { end += 1 }
        return end - index
    }

    // MARK: Operations

    private struct Place {
        var parentPath: [Int]
        var index: Int
        var parentId: String
        var depth: Int
        var position: SpaceSidebarPosition
    }

    private static func insert(_ document: inout SpaceSidebarDocument, _ node: SpaceSidebarNewNode, to: SpaceSidebarPosition, base: SpaceSidebarDocument?) throws -> SpaceSidebarOperation {
        if reservedIDs.contains(node.id) { throw SpaceSidebarError("the ID \(node.id) is reserved.") }
        if locate(document, node.id) != nil { throw SpaceSidebarError("\(node.id) is already in the sidebar.") }
        if node.kind == .widget { try widgetCheck(node.html ?? "") }
        let place = try resolve(document, to, base: base)
        try standCheck(node.kind, place.parentId)
        if place.depth > maxDepth { throw SpaceSidebarError("the sidebar would nest deeper than 16.") }
        if elementCount(document) + 1 > maxElements { throw SpaceSidebarError("the sidebar would hold more than 1,000 elements.") }
        withSiblings(&document, place.parentPath) { $0.insert(nodeOf(node), at: place.index) }
        return .insert(node, to: place.position)
    }

    private static func move(_ document: inout SpaceSidebarDocument, _ id: String, to: SpaceSidebarPosition, base: SpaceSidebarDocument?) throws -> SpaceSidebarOperation? {
        if id == "nav" { throw SpaceSidebarError("the nav root cannot move.") }
        guard let at = locate(document, id) else { throw SpaceSidebarError("\(id) is no longer in the sidebar.") }
        let from = at.index
        let all = siblings(document, at.parentPath)
        let moving = Array(all[from..<(from + runLength(all, from))])
        let target: String? = switch to {
        case .after(let anchor): anchor
        case .parent(let parent): parent
        }
        if let target, moving.contains(where: { contains($0, target) }) {
            throw SpaceSidebarError("\(id) cannot move into itself or what it carries.")
        }
        withSiblings(&document, at.parentPath) { $0.removeSubrange(from..<(from + moving.count)) }
        let place = try resolve(document, to, base: base)
        for node in moving {
            try standCheck(node.kind, place.parentId)
            if place.depth + height(node) - 1 > maxDepth { throw SpaceSidebarError("the sidebar would nest deeper than 16.") }
        }
        withSiblings(&document, place.parentPath) { $0.insert(contentsOf: moving, at: place.index) }
        if place.parentId == at.parentId && place.index == from { return nil }
        return .move(id, to: place.position)
    }

    private static func remove(_ document: inout SpaceSidebarDocument, _ id: String) throws -> SpaceSidebarOperation? {
        if reservedIDs.contains(id) { throw SpaceSidebarError("\(id) cannot be removed.") }
        // Already gone: what the operation asked for is true.
        guard let at = locate(document, id) else { return nil }
        withSiblings(&document, at.parentPath) { _ = $0.remove(at: at.index) }
        return .remove(id)
    }

    private static func set(_ document: inout SpaceSidebarDocument, _ fields: SpaceSidebarSet) throws -> SpaceSidebarOperation? {
        if fields.isEmpty { throw SpaceSidebarError("it changes nothing.") }
        let kind: String
        var location: Location?
        if fields.id == "nav" {
            kind = "nav"
        } else {
            guard let found = locate(document, fields.id) else { throw SpaceSidebarError("\(fields.id) is no longer in the sidebar.") }
            location = found
            kind = node(document, at: found.path).kind.rawValue
        }
        let allowed: [String: [String]] = [
            "nav": ["foldRibbon"], "section": ["label", "collapsed"], "space": ["expanded", "foldRibbon"], "widget": ["html"],
        ]
        // Checked in the schema's field order, as `Object.keys` lists them.
        let given = [("label", fields.label != nil), ("collapsed", fields.collapsed != nil), ("expanded", fields.expanded != nil), ("foldRibbon", fields.foldRibbon != nil), ("html", fields.html != nil)]
            .filter(\.1).map(\.0)
        for field in given where !(allowed[kind] ?? []).contains(field) {
            throw SpaceSidebarError("\(kind == "nav" ? "the nav" : "a \(kind)") has no \(field).")
        }
        if let html = fields.html { try widgetCheck(html) }
        var changed = SpaceSidebarSet(id: fields.id)
        func update(_ ribbon: inout SpaceSidebarFoldRibbon?) {
            switch fields.foldRibbon {
            case nil: break
            case .clear:
                if ribbon != nil { ribbon = nil; changed.foldRibbon = .clear }
            case .value(let value):
                if ribbon != value { ribbon = value; changed.foldRibbon = .value(value) }
            }
        }
        if let location {
            withNode(&document, location.path) { node in
                if let label = fields.label, node.label != label { node.label = label; changed.label = label }
                if let collapsed = fields.collapsed, node.collapsed != collapsed { node.collapsed = collapsed; changed.collapsed = collapsed }
                if let expanded = fields.expanded, node.expanded != expanded { node.expanded = expanded; changed.expanded = expanded }
                if let html = fields.html, node.html != html { node.html = html; changed.html = html }
                update(&node.foldRibbon)
            }
        } else {
            update(&document.foldRibbon)
        }
        return changed.isEmpty ? nil : .set(changed)
    }

    private static func resolve(_ document: SpaceSidebarDocument, _ to: SpaceSidebarPosition, base: SpaceSidebarDocument?) throws -> Place {
        let anchorId: String
        switch to {
        case .parent(let parent): return try first(document, parent)
        case .after(let id): anchorId = id
        }
        if anchorId == "nav" { throw SpaceSidebarError("nothing stands after the nav root.") }
        if let anchor = locate(document, anchorId) {
            return Place(parentPath: anchor.parentPath, index: anchor.index + 1, parentId: anchor.parentId, depth: anchor.depth, position: .after(anchorId))
        }
        guard let base, let before = locate(base, anchorId) else { throw SpaceSidebarError("\(anchorId) is not in the sidebar.") }
        // The anchor left: follow the nearest node that preceded it and is still under its parent.
        let previous = siblings(base, before.parentPath)
        for index in stride(from: before.index - 1, through: 0, by: -1) {
            if let candidate = locate(document, previous[index].id), candidate.parentId == before.parentId {
                return Place(parentPath: candidate.parentPath, index: candidate.index + 1, parentId: candidate.parentId, depth: candidate.depth, position: .after(previous[index].id))
            }
        }
        return try first(document, before.parentId == "nav" ? nil : before.parentId)
    }

    private static func first(_ document: SpaceSidebarDocument, _ parent: String?) throws -> Place {
        guard let parent else { return Place(parentPath: [], index: 0, parentId: "nav", depth: 2, position: .parent(nil)) }
        guard let holder = locate(document, parent) else { throw SpaceSidebarError("\(parent) is no longer in the sidebar.") }
        guard node(document, at: holder.path).kind == .space else { throw SpaceSidebarError("only a row or a session holds sessions, not \(parent).") }
        return Place(parentPath: holder.path, index: 0, parentId: parent, depth: holder.depth + 1, position: .parent(parent))
    }

    /// Rows and sessions may stand under a row or session; every other kind only in the list.
    private static func standCheck(_ kind: SpaceSidebarNode.Kind, _ parentId: String) throws {
        if parentId != "nav" && kind != .space { throw SpaceSidebarError("a \(kind.rawValue) stands only in the top-level list.") }
    }

    static func nodeOf(_ node: SpaceSidebarNewNode) -> SpaceSidebarNode {
        switch node.kind {
        case .space: .space(node.id, expanded: node.expanded == true, foldRibbon: node.foldRibbon)
        case .section: .section(node.id, label: node.label ?? "", collapsed: node.collapsed == true)
        case .separator: .separator(node.id)
        case .widget: .widget(node.id, html: node.html ?? "")
        case .search: .search
        case .create: .create
        }
    }

    static func contains(_ node: SpaceSidebarNode, _ id: String) -> Bool {
        node.id == id || (node.kind == .space && node.children.contains { contains($0, id) })
    }

    private static func height(_ node: SpaceSidebarNode) -> Int {
        node.kind == .space ? 1 + (node.children.map(height).max() ?? 0) : 1
    }

    private static func elementCount(_ document: SpaceSidebarDocument) -> Int {
        func count(_ node: SpaceSidebarNode) -> Int { 1 + (node.kind == .space ? node.children.reduce(0) { $0 + count($1) } : 0) }
        return 1 + document.items.reduce(0) { $0 + count($1) }
    }
}

// MARK: JSON

extension SpaceSidebarPosition {
    public var json: JSONValue {
        switch self {
        case .after(let id): .object(["after": .string(id)])
        case .parent(let id): .object(["parent": id.map(JSONValue.string) ?? .null])
        }
    }

    public init?(json: JSONValue) {
        guard let object = json.objectValue, object.count == 1 else { return nil }
        if let after = object["after"]?.stringValue { self = .after(after); return }
        switch object["parent"] {
        case .null?: self = .parent(nil)
        case .string(let id)?: self = .parent(id)
        default: return nil
        }
    }
}

extension SpaceSidebarOperation {
    public var json: JSONValue {
        switch self {
        case .insert(let node, let to):
            var object: [String: JSONValue] = ["type": .string(node.kind.rawValue), "id": .string(node.id)]
            if let expanded = node.expanded { object["expanded"] = .bool(expanded) }
            if let ribbon = node.foldRibbon { object["foldRibbon"] = .string(ribbon.rawValue) }
            if let label = node.label { object["label"] = .string(label) }
            if let collapsed = node.collapsed { object["collapsed"] = .bool(collapsed) }
            if let html = node.html { object["html"] = .string(html) }
            return .object(["type": .string("insert"), "node": .object(object), "to": to.json])
        case .move(let id, let to): return .object(["type": .string("move"), "id": .string(id), "to": to.json])
        case .remove(let id): return .object(["type": .string("remove"), "id": .string(id)])
        case .set(let fields):
            var object: [String: JSONValue] = ["type": .string("set"), "id": .string(fields.id)]
            if let label = fields.label { object["label"] = .string(label) }
            if let collapsed = fields.collapsed { object["collapsed"] = .bool(collapsed) }
            if let expanded = fields.expanded { object["expanded"] = .bool(expanded) }
            switch fields.foldRibbon {
            case .clear?: object["foldRibbon"] = .null
            case .value(let ribbon)?: object["foldRibbon"] = .string(ribbon.rawValue)
            case nil: break
            }
            if let html = fields.html { object["html"] = .string(html) }
            return .object(object)
        }
    }

    public init?(json: JSONValue) {
        guard let object = json.objectValue, let type = object["type"]?.stringValue else { return nil }
        switch type {
        case "insert":
            guard let node = object["node"]?.objectValue, let kindName = node["type"]?.stringValue,
                  let kind = SpaceSidebarNode.Kind(rawValue: kindName), let id = node["id"]?.stringValue,
                  let to = object["to"].flatMap(SpaceSidebarPosition.init(json:)) else { return nil }
            self = .insert(SpaceSidebarNewNode(
                kind: kind, id: id, expanded: node["expanded"]?.boolValue,
                foldRibbon: node["foldRibbon"]?.stringValue.flatMap(SpaceSidebarFoldRibbon.init(rawValue:)),
                label: node["label"]?.stringValue, collapsed: node["collapsed"]?.boolValue, html: node["html"]?.stringValue
            ), to: to)
        case "move":
            guard let id = object["id"]?.stringValue, let to = object["to"].flatMap(SpaceSidebarPosition.init(json:)) else { return nil }
            self = .move(id, to: to)
        case "remove":
            guard let id = object["id"]?.stringValue else { return nil }
            self = .remove(id)
        case "set":
            guard let id = object["id"]?.stringValue else { return nil }
            var fields = SpaceSidebarSet(id: id, label: object["label"]?.stringValue, collapsed: object["collapsed"]?.boolValue, expanded: object["expanded"]?.boolValue, html: object["html"]?.stringValue)
            switch object["foldRibbon"] {
            case .null?: fields.foldRibbon = .clear
            case .string(let value)?: fields.foldRibbon = SpaceSidebarFoldRibbon(rawValue: value).map(SpaceSidebarRibbonPatch.value)
            default: break
            }
            self = .set(fields)
        default: return nil
        }
    }
}
