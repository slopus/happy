import Foundation
import HappyWire

/// How a folder's entries are listed: folders first, then by the chosen
/// key, as Finder lists them.
public struct VaultSort: Codable, Equatable, Hashable, Sendable {
    public enum Key: String, Codable, CaseIterable, Sendable {
        case name
        case updatedAt
        case size
    }

    public var key: Key
    public var ascending: Bool

    public init(key: Key = .name, ascending: Bool? = nil) {
        self.key = key
        // The daemon's defaults: A to Z, newest and largest first.
        self.ascending = ascending ?? (key == .name)
    }

    public static let name = VaultSort()

    /// `entries` folders first, then in this order; ties by name, then ID.
    public func sorted(_ entries: [VaultEntry]) -> [VaultEntry] {
        entries.sorted { a, b in
            if a.isFolder != b.isFolder { return a.isFolder }
            func byName() -> Bool {
                let order = a.name.localizedStandardCompare(b.name)
                return order == .orderedSame ? a.id < b.id : order == .orderedAscending
            }
            switch key {
            case .name:
                return ascending ? byName() : !byName()
            case .updatedAt:
                if a.updatedAt != b.updatedAt { return ascending ? a.updatedAt < b.updatedAt : a.updatedAt > b.updatedAt }
                return byName()
            case .size:
                let (x, y) = (a.size ?? 0, b.size ?? 0)
                if x != y { return ascending ? x < y : x > y }
                return byName()
            }
        }
    }
}

/// The rules a vault's entries change by, without the actor around them.
enum VaultReducer {
    /// Whether resource version `a` is newer than `b`. UUIDv7s order by
    /// time as text; one made here (empty) is older than any.
    static func newer(_ a: String, than b: String) -> Bool {
        if b.isEmpty { return !a.isEmpty }
        return a > b
    }

    /// What an event does to the entries kept.
    enum Outcome: Equatable {
        case ignored
        /// Applied to what is kept.
        case applied(entryId: String)
        /// The kept copy can't be brought forward: read the entry.
        case read(entryId: String, folder: Bool)
        /// Gone for good, with everything below it.
        case removed(entryId: String)
    }

    /// Takes `entry` unless an equal or newer copy is held.
    @discardableResult
    static func accept(_ entry: VaultEntry, into entries: inout [String: VaultEntry]) -> Bool {
        if let held = entries[entry.id], held == entry || newer(held.version, than: entry.version) { return false }
        entries[entry.id] = entry
        return true
    }

    /// A `vault.folder.*` or `vault.file.*` event of the vault `surfaceId`:
    /// an entry made, changed along its version chain, or removed. An entry not held matters when
    /// a screen shows it (`watched`) or it lands in a folder that is read
    /// (`open`, nil for the root).
    static func receive(_ event: JSONValue, surfaceId: String, into entries: inout [String: VaultEntry], watched: (String) -> Bool, open: (String?) -> Bool) -> Outcome {
        let payload = event["payload"]
        let type = event["type"]?.stringValue ?? ""
        let folder = type.hasPrefix("vault.folder.")
        guard folder || type.hasPrefix("vault.file.") else { return .ignored }
        let key = folder ? "folder" : "file"
        switch type.dropFirst(folder ? 13 : 11) {
        case "created":
            guard let entry = payload?[key].flatMap(VaultEntry.init(json:)), entry.surfaceId == surfaceId else { return .ignored }
            guard entries[entry.id] != nil || watched(entry.id) || open(entry.parentId) else { return .ignored }
            return accept(entry, into: &entries) ? .applied(entryId: entry.id) : .ignored
        case "updated":
            guard let id = payload?["\(key)Id"]?.stringValue, let version = payload?["version"]?.stringValue else { return .ignored }
            let changes = payload?["changes"]?.objectValue ?? [:]
            guard let held = entries[id] else {
                let moves = changes["parentId"].map { open($0.stringValue) } ?? false
                let returns = changes["deletedAt"] == .null
                return moves || returns || watched(id) ? .read(entryId: id, folder: folder) : .ignored
            }
            if held.version == version || newer(held.version, than: version) { return .ignored }
            guard held.version == payload?["previousVersion"]?.stringValue, case .object(var fields) = held.json else { return .read(entryId: id, folder: folder) }
            for (key, value) in changes { fields[key] = value }
            fields["version"] = .string(version)
            guard let next = VaultEntry(json: .object(fields)) else { return .read(entryId: id, folder: folder) }
            entries[id] = next
            return .applied(entryId: id)
        case "removed":
            guard let id = payload?["\(key)Id"]?.stringValue else { return .ignored }
            remove(id, from: &entries)
            return .removed(entryId: id)
        default:
            return .ignored
        }
    }

    /// Drops `id` and every entry below it.
    static func remove(_ id: String, from entries: inout [String: VaultEntry]) {
        var gone: Set<String> = [id]
        var grew = true
        while grew {
            grew = false
            for entry in entries.values where !gone.contains(entry.id) {
                if let parent = entry.parentId, gone.contains(parent) { gone.insert(entry.id); grew = true }
            }
        }
        for id in gone { entries[id] = nil }
    }

    /// Whether folder `id` (nil: the root) or a folder above it is in the Trash.
    static func inTrash(_ id: String?, in entries: [String: VaultEntry]) -> Bool {
        var current = id
        var seen = Set<String>()
        while let id = current, seen.insert(id).inserted, let entry = entries[id] {
            if entry.deletedAt != nil { return true }
            current = entry.parentId
        }
        return false
    }

    /// Whether `id` is `folder` or a folder inside it: where a folder can't be moved.
    static func contains(_ folder: String, _ id: String?, in entries: [String: VaultEntry]) -> Bool {
        var current = id
        var seen = Set<String>()
        while let id = current, seen.insert(id).inserted {
            if id == folder { return true }
            current = entries[id]?.parentId
        }
        return false
    }

    /// The live children of folder `parentId` (nil: the root).
    static func children(_ parentId: String?, in entries: [String: VaultEntry]) -> [VaultEntry] {
        entries.values.filter { $0.parentId == parentId && $0.deletedAt == nil }
    }

    /// A free name in a folder for `name`: "Report 2.pdf" after "Report.pdf",
    /// compared as the computer does, ignoring case.
    static func free(_ name: String, among taken: [String]) -> String {
        let used = Set(taken.map { $0.lowercased() })
        guard used.contains(name.lowercased()) else { return name }
        let ext = (name as NSString).pathExtension
        let base = ext.isEmpty ? name : String(name.dropLast(ext.count + 1))
        for number in 2... {
            let candidate = ext.isEmpty ? "\(base) \(number)" : "\(base) \(number).\(ext)"
            if !used.contains(candidate.lowercased()) { return candidate }
        }
        return name
    }
}
