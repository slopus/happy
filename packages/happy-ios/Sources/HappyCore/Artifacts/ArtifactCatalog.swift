import Foundation
import HappyWire

/// One artifact as the catalog lists it (`GET /v0/artifacts`, the artifact
/// object): what its row shows and what opens it. Kept on the phone whole,
/// so the list draws from disk before the computer answers.
public struct ArtifactSummary: Codable, Equatable, Sendable, Identifiable {
    public struct Entry: Codable, Equatable, Sendable {
        public var path: String
        public var mimeType: String
        public var size: Double

        public init(path: String, mimeType: String, size: Double) {
            self.path = path
            self.mimeType = mimeType
            self.size = size
        }

        /// The entry as a version names its files.
        public var file: AgentWire.ArtifactVersion.File { .init(path: path, mimeType: mimeType, size: size) }
    }

    public var id: String
    /// `markdown`, `html`, `image`, `image_series`, `video` or `document`;
    /// a newer daemon's type is kept as it came.
    public var type: String
    public var title: String
    public var latestVersion: Int
    public var entry: Entry?
    public var fileCount: Int
    /// A live page reached by URL, which its entry only stands in for.
    public var live: Bool
    /// Milliseconds since 1970.
    public var createdAt: Double
    public var updatedAt: Double

    public init(id: String, type: String, title: String, latestVersion: Int, entry: Entry?, fileCount: Int = 1, live: Bool = false, createdAt: Double, updatedAt: Double) {
        self.id = id
        self.type = type
        self.title = title
        self.latestVersion = latestVersion
        self.entry = entry
        self.fileCount = fileCount
        self.live = live
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// An artifact object, or one this type kept; nil for a tombstone or
    /// one that can't be read.
    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, json["status"]?.stringValue != "deleted" else { return nil }
        self.id = id
        type = json["type"]?.stringValue ?? ""
        title = json["title"]?.stringValue ?? ""
        latestVersion = json["latestVersion"]?.numberValue.map { Int($0) } ?? 1
        entry = Self.entry(json["entry"])
        fileCount = json["fileCount"]?.numberValue.map { Int($0) } ?? 1
        live = json["live"]?.objectValue != nil || json["live"]?.boolValue == true
        createdAt = json["createdAt"]?.numberValue ?? 0
        updatedAt = json["updatedAt"]?.numberValue ?? createdAt
    }

    static func entry(_ json: JSONValue?) -> Entry? {
        guard let json, let path = json["path"]?.stringValue else { return nil }
        return Entry(path: path, mimeType: json["mimeType"]?.stringValue ?? "", size: json["size"]?.numberValue ?? 0)
    }

    /// The entry is a picture or a recording: the row shows it small.
    public var showsPicture: Bool {
        guard let entry, !live else { return false }
        return entry.mimeType.hasPrefix("image/") || entry.mimeType.hasPrefix("video/")
    }

    /// What the artifact viewer opens: always the latest version.
    public var artifact: Artifact {
        Artifact(id: id, version: latestVersion, type: type, title: title, followsLatest: true)
    }
}

/// The catalog's rules, pure: reading pages, following events, ordering
/// and searching. `ArtifactCatalogFeed` keeps the list and runs them.
public enum ArtifactCatalog {
    /// A page of `GET /v0/artifacts`: its live artifacts and the next page's cursor.
    public static func page(_ json: JSONValue) -> (items: [ArtifactSummary], next: String?) {
        let items = (json["artifacts"]?.arrayValue ?? []).compactMap(ArtifactSummary.init(json:))
        return (items, json["nextPageCursor"]?.stringValue)
    }

    /// What one event does to the list.
    public enum Change: Equatable, Sendable {
        /// Not an artifact event, or one that changes nothing kept.
        case none
        case changed([ArtifactSummary])
        /// An update to an artifact this list doesn't hold: read it.
        case read(String)
    }

    /// `artifact.created` adds its artifact, `artifact.updated` changes the
    /// fields it carries, `artifact.deleted` takes it off the list.
    public static func apply(_ event: JSONValue, to list: [ArtifactSummary]) -> Change {
        guard let type = event["type"]?.stringValue, type.hasPrefix("artifact.") else { return .none }
        let payload = event["payload"] ?? .null
        switch type {
        case "artifact.created":
            guard let artifact = payload["artifact"].flatMap(ArtifactSummary.init(json:)) else { return .none }
            return .changed(sorted(list.filter { $0.id != artifact.id } + [artifact]))
        case "artifact.updated":
            guard let id = payload["artifactId"]?.stringValue else { return .none }
            guard let index = list.firstIndex(where: { $0.id == id }) else { return .read(id) }
            let changes = payload["changes"] ?? .null
            if changes["status"]?.stringValue == "deleted" { return .changed(list.filter { $0.id != id }) }
            var next = list
            var artifact = next[index]
            if let title = changes["title"]?.stringValue { artifact.title = title }
            if let version = changes["latestVersion"]?.numberValue { artifact.latestVersion = Int(version) }
            if changes["entry"] != nil { artifact.entry = ArtifactSummary.entry(changes["entry"]) }
            if let count = changes["fileCount"]?.numberValue { artifact.fileCount = Int(count) }
            if let live = changes["live"] { artifact.live = live.objectValue != nil }
            if let time = changes["updatedAt"]?.numberValue { artifact.updatedAt = time }
            guard artifact != next[index] else { return .none }
            next[index] = artifact
            return .changed(sorted(next))
        case "artifact.deleted":
            guard let id = payload["artifactId"]?.stringValue, list.contains(where: { $0.id == id }) else { return .none }
            return .changed(list.filter { $0.id != id })
        default:
            return .none
        }
    }

    /// Newest change first; the ID breaks ties, as the catalog's paging does.
    public static func sorted(_ list: [ArtifactSummary]) -> [ArtifactSummary] {
        list.sorted { $0.updatedAt != $1.updatedAt ? $0.updatedAt > $1.updatedAt : $0.id > $1.id }
    }

    /// The artifacts whose title, or kind's name, holds every word of
    /// `query`, ignoring case and accents.
    public static func matching(_ query: String, in list: [ArtifactSummary], kindName: (String) -> String) -> [ArtifactSummary] {
        let words = query.split(whereSeparator: \.isWhitespace).map { String($0) }
        guard !words.isEmpty else { return list }
        let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
        return list.filter { artifact in
            let haystack = artifact.title + " " + kindName(artifact.type)
            return words.allSatisfy { haystack.range(of: $0, options: options) != nil }
        }
    }
}

/// When something happened, as a list groups it: Today, Yesterday, the
/// seven and thirty days before, then by month (Telegram's and ChatGPT's
/// relative buckets).
public enum DateBucket: Hashable, Sendable {
    case today
    case yesterday
    case previous7Days
    case previous30Days
    /// An older month: its year and month, 1 to 12.
    case month(year: Int, month: Int)

    /// The bucket `date` falls in, seen from `now`. A date after now (a
    /// computer whose clock runs ahead) is today.
    public static func of(_ date: Date, now: Date, calendar: Calendar) -> DateBucket {
        let today = calendar.startOfDay(for: now)
        if date >= today { return .today }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: today), date >= yesterday { return .yesterday }
        if let week = calendar.date(byAdding: .day, value: -7, to: today), date >= week { return .previous7Days }
        if let month = calendar.date(byAdding: .day, value: -30, to: today), date >= month { return .previous30Days }
        let parts = calendar.dateComponents([.year, .month], from: date)
        return .month(year: parts.year ?? 1970, month: parts.month ?? 1)
    }

    /// `items` in their order, cut where the bucket changes. Items given
    /// newest first come out as the buckets do, newest first.
    public static func group<Item>(_ items: [Item], now: Date, calendar: Calendar, date: (Item) -> Date) -> [(bucket: DateBucket, items: [Item])] {
        var groups: [(bucket: DateBucket, items: [Item])] = []
        for item in items {
            let bucket = of(date(item), now: now, calendar: calendar)
            if groups.last?.bucket == bucket {
                groups[groups.count - 1].items.append(item)
            } else if let index = groups.firstIndex(where: { $0.bucket == bucket }) {
                // Out of order (an update arriving late): kept with its bucket.
                groups[index].items.append(item)
            } else {
                groups.append((bucket, [item]))
            }
        }
        return groups
    }
}
