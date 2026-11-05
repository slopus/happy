import Foundation
import HappyWire

/// One artifact as the catalog lists it (`GET /v0/artifacts`, the artifact
/// object): what its row shows and what opens it. Kept on the phone whole,
/// so the list draws from disk before the computer answers. A deleted one
/// is kept as its tombstone: the Artifacts list leaves it out, the Feed
/// still names it.
public struct ArtifactSummary: Codable, Equatable, Sendable, Identifiable {
    /// A still the daemon made of a picture's first frame or a
    /// recording's poster, fitted within 640×640, served at
    /// `/v0/artifacts/:id/versions/:n/previews/<the file's path>`; its size
    /// in pixels. An older daemon makes none.
    public struct Preview: Codable, Equatable, Sendable {
        public var width: Double
        public var height: Double

        public init(width: Double, height: Double) {
            self.width = width
            self.height = height
        }

        init?(json: JSONValue?) {
            guard let width = json?["width"]?.numberValue, let height = json?["height"]?.numberValue,
                  width.isFinite, height.isFinite, width > 0, height > 0 else { return nil }
            self.init(width: width, height: height)
        }
    }

    /// A picture's ThumbHash as the daemon sends it (standard base64);
    /// nil for `null`, nothing, or what can't be one.
    static func thumbhash(_ json: JSONValue?) -> String? {
        guard let value = json?.stringValue, !value.isEmpty, value.count <= 128 else { return nil }
        return value
    }

    public struct Entry: Codable, Equatable, Sendable {
        public var path: String
        public var mimeType: String
        public var size: Double
        /// A picture's or a recording's, from a daemon that reads its media.
        public var thumbhash: String?
        public var preview: Preview?

        public init(path: String, mimeType: String, size: Double, thumbhash: String? = nil, preview: Preview? = nil) {
            self.path = path
            self.mimeType = mimeType
            self.size = size
            self.thumbhash = thumbhash
            self.preview = preview
        }

        /// The entry as a version names its files.
        public var file: AgentWire.ArtifactVersion.File { .init(path: path, mimeType: mimeType, size: size, thumbhash: thumbhash, preview: preview) }
    }

    /// The latest version's cover (`cover`): a picture among its files,
    /// its size in pixels, and the one of the standard shapes it is,
    /// which the Feed shows its post at.
    public struct Cover: Codable, Equatable, Sendable {
        /// The shapes a cover may be (within 2%, the daemon checks); the
        /// set may grow, and a shape this phone doesn't know is no cover.
        public enum Aspect: String, Codable, Equatable, Sendable {
            /// 16:9.
            case wide
            /// 1:1.
            case square

            /// Height over width.
            public var ratio: Double {
                switch self {
                case .wide: 9.0 / 16.0
                case .square: 1
                }
            }
        }

        public var path: String
        public var mimeType: String
        public var width: Double
        public var height: Double
        public var aspect: Aspect
        /// Drawn while the picture loads; nil from an older daemon, or one
        /// that couldn't decode it.
        public var thumbhash: String?
        /// Its still, for the lists' slots; a WebP or GIF cover may move.
        public var preview: Preview?

        public init(path: String, mimeType: String, width: Double, height: Double, aspect: Aspect, thumbhash: String? = nil, preview: Preview? = nil) {
            self.path = path
            self.mimeType = mimeType
            self.width = width
            self.height = height
            self.aspect = aspect
            self.thumbhash = thumbhash
            self.preview = preview
        }

        /// The kinds of picture a cover may be; the daemon turns SVG into PNG.
        public static let mimeTypes: Set<String> = ["image/png", "image/jpeg", "image/webp", "image/gif"]

        /// A cover object; nil for `null`, or one without a path, a known
        /// kind of picture, a size or a known shape (an older daemon's,
        /// which sends no `aspect`).
        init?(json: JSONValue?) {
            guard let json, let path = json["path"]?.stringValue, !path.isEmpty,
                  let mimeType = json["mimeType"]?.stringValue, Self.mimeTypes.contains(mimeType.lowercased()),
                  let width = json["width"]?.numberValue, let height = json["height"]?.numberValue,
                  width.isFinite, height.isFinite, width > 0, height > 0,
                  let aspect = json["aspect"]?.stringValue.flatMap(Aspect.init(rawValue:)) else { return nil }
            self.init(path: path, mimeType: mimeType.lowercased(), width: width, height: height, aspect: aspect,
                      thumbhash: ArtifactSummary.thumbhash(json["thumbhash"]), preview: Preview(json: json["preview"]))
        }
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
    /// A tombstone (`status: "deleted"`): its versions are gone.
    public var deleted: Bool
    /// The latest version's cover, and its one line about itself; nil
    /// from a daemon without covers.
    public var cover: Cover?
    public var summary: String?
    /// The colour the latest version is shown on (`#rgb`, `#rgba`,
    /// `#rrggbb` or `#rrggbbaa`, lowercased); nil for a transparent slot.
    public var background: String?

    public init(id: String, type: String, title: String, latestVersion: Int, entry: Entry?, fileCount: Int = 1, live: Bool = false, createdAt: Double, updatedAt: Double, deleted: Bool = false, cover: Cover? = nil, summary: String? = nil, background: String? = nil) {
        self.id = id
        self.type = type
        self.title = title
        self.latestVersion = latestVersion
        self.entry = entry
        self.fileCount = fileCount
        self.live = live
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.deleted = deleted
        self.cover = cover
        self.summary = summary
        self.background = background
    }

    /// An artifact object, a tombstone included, or one this type kept;
    /// nil for one that can't be read.
    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue else { return nil }
        self.id = id
        type = json["type"]?.stringValue ?? ""
        title = json["title"]?.stringValue ?? ""
        latestVersion = json["latestVersion"]?.numberValue.map { Int($0) } ?? 1
        entry = Self.entry(json["entry"])
        fileCount = json["fileCount"]?.numberValue.map { Int($0) } ?? 1
        live = json["live"]?.objectValue != nil || json["live"]?.boolValue == true
        createdAt = json["createdAt"]?.numberValue ?? 0
        updatedAt = json["updatedAt"]?.numberValue ?? createdAt
        deleted = json["deleted"]?.boolValue ?? (json["status"]?.stringValue == "deleted")
        cover = Cover(json: json["cover"])
        summary = Self.summary(json["summary"])
        background = Self.background(json["background"])
    }

    /// Post-length words, their line breaks kept, as the daemon keeps
    /// them; nil for `null` or nothing.
    static func summary(_ json: JSONValue?) -> String? {
        guard let text = json?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }

    /// `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, and nothing else.
    static func background(_ json: JSONValue?) -> String? {
        json?.stringValue.flatMap { value in
            value.range(of: "^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$", options: .regularExpression) != nil ? value.lowercased() : nil
        }
    }

    static func entry(_ json: JSONValue?) -> Entry? {
        guard let json, let path = json["path"]?.stringValue else { return nil }
        return Entry(path: path, mimeType: json["mimeType"]?.stringValue ?? "", size: json["size"]?.numberValue ?? 0,
                     thumbhash: thumbhash(json["thumbhash"]), preview: Preview(json: json["preview"]))
    }

    /// The entry is a picture or a recording: the row shows it small.
    public var showsPicture: Bool {
        guard let entry, !live else { return false }
        return entry.mimeType.hasPrefix("image/") || entry.mimeType.hasPrefix("video/")
    }

    /// Where the latest version's cover is served
    /// (`/v0/artifacts/:id/versions/:n/files/<path>`, each segment
    /// escaped); nil without one, and for a tombstone, whose files are gone.
    public var coverPath: String? {
        guard let cover, !deleted else { return nil }
        return served("files", cover.path)
    }

    /// Where the cover's still is served (`…/previews/<path>`), when the
    /// daemon made one.
    public var coverPreviewPath: String? {
        guard let cover, cover.preview != nil, !deleted else { return nil }
        return served("previews", cover.path)
    }

    /// Where a picture's or a recording's still is served: the entry's
    /// first frame or poster, when the daemon made one.
    public var entryPreviewPath: String? {
        guard showsPicture, let entry, entry.preview != nil, !deleted else { return nil }
        return served("previews", entry.path)
    }

    private func served(_ route: String, _ file: String) -> String {
        Self.served(id: id, version: latestVersion, route: route, file: file)
    }

    /// `/v0/artifacts/:id/versions/:n/<route>/<path>`, each segment escaped.
    public static func served(id: String, version: Int, route: String, file: String) -> String {
        let path = file.split(separator: "/", omittingEmptySubsequences: false).map { AgentClient.escape(String($0)) }.joined(separator: "/")
        return "/v0/artifacts/\(AgentClient.escape(id))/versions/\(version)/\(route)/\(path)"
    }

    /// What the artifact viewer opens: always the latest version.
    public var artifact: Artifact {
        Artifact(id: id, version: latestVersion, type: type, title: title, followsLatest: true)
    }
}

/// The catalog's rules, pure: reading pages, following events, ordering
/// and searching. `ArtifactCatalogFeed` keeps the list and runs them.
public enum ArtifactCatalog {
    /// A page of `GET /v0/artifacts?includeDeleted=true`: its artifacts,
    /// tombstones included, and the next page's cursor.
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
    /// fields it carries, `artifact.deleted` leaves its tombstone.
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
            var next = list
            var artifact = next[index]
            if let status = changes["status"]?.stringValue { artifact.deleted = status == "deleted" }
            if let title = changes["title"]?.stringValue { artifact.title = title }
            if let version = changes["latestVersion"]?.numberValue { artifact.latestVersion = Int(version) }
            if changes["entry"] != nil { artifact.entry = ArtifactSummary.entry(changes["entry"]) }
            if let count = changes["fileCount"]?.numberValue { artifact.fileCount = Int(count) }
            if let live = changes["live"] { artifact.live = live.objectValue != nil }
            if let time = changes["updatedAt"]?.numberValue { artifact.updatedAt = time }
            // Present and `null` clears them.
            if changes["cover"] != nil { artifact.cover = ArtifactSummary.Cover(json: changes["cover"]) }
            if changes["summary"] != nil { artifact.summary = ArtifactSummary.summary(changes["summary"]) }
            if changes["background"] != nil { artifact.background = ArtifactSummary.background(changes["background"]) }
            guard artifact != next[index] else { return .none }
            next[index] = artifact
            return .changed(sorted(next))
        case "artifact.deleted":
            guard let id = payload["artifactId"]?.stringValue else { return .none }
            if let artifact = payload["artifact"].flatMap(ArtifactSummary.init(json:)), artifact.id == id {
                return .changed(sorted(list.filter { $0.id != id } + [artifact]))
            }
            guard let index = list.firstIndex(where: { $0.id == id }) else { return .read(id) }
            guard !list[index].deleted else { return .none }
            var next = list
            next[index].deleted = true
            return .changed(next)
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
