import Foundation
import HappyWire

/// What a Feed entry is about, as far as its glyph and its changes' noun
/// go (desktop's `feedSubjectKind`).
public enum FeedSubjectKind: String, Equatable, Hashable, Sendable {
    case task, bot, artifact, document, todoList, calendar, surface, unknown

    public init(_ item: FeedItem) {
        switch item.subject.type {
        case "task": self = .task
        case "bot": self = .bot
        case "artifact": self = .artifact
        case "surface":
            switch item.snapshot.surfaceType {
            case "todo": self = .todoList
            case "document": self = .document
            case "calendar": self = .calendar
            default: self = .surface
            }
        default: self = .unknown
        }
    }
}

/// An avatar on the Feed: a mark as home draws it (a picture over its
/// ThumbHash, a placeholder, Happy's own), round for a person and a
/// rounded square for anything else, or a kind's glyph on its tile.
public enum FeedFace: Equatable, Sendable {
    case mark(Row.Mark, round: Bool)
    case tile(FeedSubjectKind, artifactType: String?)
    /// A cluster with no face of its own: its kind's glyph.
    case clusterTile(String)
}

/// Where the Feed finds faces and names: home's rows (bots, tasks and
/// their agents, projects), the person themselves, and the people the
/// entries credit. Pure and `Sendable`, so a derivation off the main
/// thread reads it.
public struct FeedFaces: Equatable, Sendable {
    /// Marks by `bot:<id>`, `task:<id>`, `agent:<agentId>`, `project:<id>`.
    var marks: [String: Row.Mark] = [:]
    /// Agents' names by agent ID: their bot's, task's or chat's.
    var agentNames: [String: String] = [:]
    var userId: String?
    var photo: String?
    var personSeed: String
    var people: [String: TeamUser]

    /// `rows` as home lists them, the person's team user and picture's
    /// ThumbHash, their placeholder's seed (`Session.personSeed`), and the
    /// people the Feed has read.
    public init(rows: [Row], userId: String?, photo: String?, personSeed: String, people: [String: TeamUser]) {
        for row in rows {
            switch row.targetKind {
            case "bot", "task":
                guard let id = row.targetId, let kind = row.targetKind else { continue }
                marks["\(kind):\(id)"] = row.mark
                if let agentId = row.agentId {
                    marks["agent:\(agentId)"] = row.mark
                    agentNames[agentId] = row.label
                }
            case "project":
                if row.id.hasPrefix("project:") { marks[row.id] = row.mark }
            default:
                if let agentId = row.agentId, row.kind == .session, agentNames[agentId] == nil { agentNames[agentId] = row.label }
            }
        }
        self.userId = userId
        self.photo = photo
        self.personSeed = personSeed
        self.people = people
    }

    /// A subject's own avatar: a bot's face, a task's (its owner's in a
    /// team), else its kind's glyph.
    public func subject(_ item: FeedItem) -> FeedFace {
        let id = item.subject.id
        switch item.subject.type {
        case "bot", "task":
            let mark = marks["\(item.subject.type):\(id)"] ?? .placeholder(seed: id)
            return .mark(mark == .none ? .placeholder(seed: id) : mark, round: false)
        default:
            return .tile(FeedSubjectKind(item), artifactType: item.snapshot.artifactType)
        }
    }

    /// Who made a change: an agent wears its bot's or task's face, a
    /// person their picture or their placeholder, round.
    public func actor(_ actor: FeedActor) -> FeedFace {
        if let agentId = actor.agentId {
            let mark = marks["agent:\(agentId)"] ?? .placeholder(seed: agentId)
            return .mark(mark == .none ? .placeholder(seed: agentId) : mark, round: false)
        }
        if let id = actor.userId {
            if id == userId {
                return .mark(photo.map { .image(path: TeamUser.photoPath(id), thumbhash: $0) } ?? .placeholder(seed: id), round: true)
            }
            let photo = people[id]?.photo
            return .mark(photo.map { .image(path: TeamUser.photoPath(id), thumbhash: $0.thumbhash) } ?? .placeholder(seed: id), round: true)
        }
        // Standalone: the installation's one person, who is reading.
        return .mark(photo.map { .image(path: "/v0/profile/photo", thumbhash: $0) } ?? .placeholder(seed: personSeed), round: true)
    }

    /// What `actor` is called, for VoiceOver: a stand-in where nobody
    /// knows yet.
    public func name(_ actor: FeedActor, words: FeedWords) -> String {
        if let agentId = actor.agentId { return agentNames[agentId] ?? words.anAgent }
        if let id = actor.userId {
            if id == userId { return words.you }
            return people[id].map(\.name).flatMap { $0.isEmpty ? nil : $0 } ?? words.aPerson
        }
        return words.you
    }

    /// A place's avatar in Following: its bot's, task's or project's face,
    /// else its kind's glyph.
    public func cluster(_ cluster: FeedCluster) -> FeedFace {
        if let id = cluster.placeId {
            switch cluster.kind {
            case "bot", "task":
                if let mark = marks["\(cluster.kind):\(id)"], mark != .none { return .mark(mark, round: false) }
                return .mark(.placeholder(seed: id), round: false)
            case "project":
                if let mark = marks["project:\(id)"], mark != .none { return .mark(mark, round: false) }
            default:
                break
            }
        }
        return .clusterTile(cluster.kind)
    }
}

/// The Feed's words in one language, read from its catalog's own keys
/// (`TranslationCatalog.nativeSources`), so work off the main thread says
/// them in the language its input carries, never the screens' current one.
public struct FeedWords: Equatable, Sendable {
    public let language: String
    /// Nil while that is English.
    private let catalog: TranslationCatalog?

    /// A catalog already decoded, such as the screens' own
    /// (`AppLocalization.screens`); nil or English's is English.
    public init(catalog: TranslationCatalog?) {
        self.init(reading: catalog?.language == "en" ? nil : catalog)
    }

    /// Reads `catalog` even when it is English's, so the tests can hold
    /// the English written here to it.
    init(reading catalog: TranslationCatalog?) {
        self.catalog = catalog
        language = catalog?.language ?? "en"
    }

    public static let english = FeedWords(catalog: nil)

    /// The catalogs are compiled in, so a language always has the same words.
    public static func == (lhs: FeedWords, rhs: FeedWords) -> Bool { lhs.language == rhs.language }

    private func word(_ key: String, _ english: String) -> String {
        catalog.map { $0("native.feed.\(key)") } ?? english
    }

    private func word(_ key: String, _ values: [String: TranslationValue], _ english: String) -> String {
        catalog.map { $0("native.feed.\(key)", values) } ?? english
    }

    /// `count` with its noun, in the form the language puts after it.
    private func counted(_ key: String, _ count: Int, one: String, other: String) -> String {
        let category = Self.pluralCategory(language: language, count: count)
        return word("\(key).\(category)", ["count": .number(count)], count == 1 ? "\(count) \(one)" : "\(count) \(other)")
    }

    /// The plural forms the native keys carry: `one`/`other`, and
    /// `few`/`many` where Russian and Polish have them; Chinese and
    /// Japanese say one form.
    static func pluralCategory(language: String, count: Int) -> String {
        switch language {
        case "ru": TranslationCatalog.PluralRule.russian.category(count)
        case "pl": TranslationCatalog.PluralRule.polish.category(count)
        case "ja", "zh-Hans", "zh-Hant": "other"
        default: TranslationCatalog.PluralRule.oneOther.category(count)
        }
    }

    public var activity: String { word("activity", "Activity") }
    public var following: String { word("following", "Following") }
    public var markAllRead: String { word("markAllRead", "Mark All Read") }
    public var open: String { word("open", "Open") }
    public var peek: String { word("peek", "Peek") }
    public var empty: String { word("empty", "Nothing has happened yet. New tasks, bots, documents, todo lists and artifacts show up here, with every change to them.") }
    public var loading: String { word("loading", "Loading the feed…") }
    public var unavailable: String { word("unavailable", "The feed couldn’t be loaded. Check that your computer is on.") }
    public var unsupported: String { word("unsupported", "This Happy Agent doesn’t keep a feed. Updating it adds one.") }
    public var everywhere: String { word("everywhere", "Everywhere") }
    public var places: String { word("places", "Places") }
    public var noClusters: String { word("noClusters", "Nothing to follow yet. Tasks, bots, documents and todo lists show up here once something happens in them.") }
    public var loadingClusters: String { word("loadingClusters", "Loading…") }
    public var clustersUnavailable: String { word("clustersUnavailable", "These couldn’t be loaded. Check that your computer is on.") }
    public var peekEmpty: String { word("peekEmpty", "Nothing has happened here in the last 30 days.") }
    public var unreadMark: String { word("unreadMark", "Unread") }
    public var you: String { word("you", "You") }
    public var anAgent: String { word("anAgent", "An agent") }
    public var aPerson: String { word("aPerson", "A person") }
    public var untitled: String { word("untitled", "Untitled") }
    public var muted: String { word("muted", "Muted") }

    public func follow(_ name: String) -> String { word("follow", ["name": .text(name)], "Follow \(name)") }
    public func mute(_ name: String) -> String { word("mute", ["name": .text(name)], "Mute \(name)") }
    public func followFailed(_ reason: String) -> String { word("followFailed", ["reason": .text(reason)], "Couldn’t change what you follow. \(reason)") }
    public func unread(_ count: Int) -> String { counted("unread", count, one: "unread", other: "unread") }

    /// What happened, as the folded changes add up: made, changed some
    /// number of times, or both. A todo list's changes are its new todos,
    /// a document's its edits, an artifact's its new versions.
    public func activity(created: Bool, updates: Int, kind: FeedSubjectKind) -> String {
        var changes = ""
        if updates > 0 {
            switch kind {
            case .todoList: changes = counted("newTodos", updates, one: "new todo", other: "new todos")
            case .document: changes = counted("edits", updates, one: "edit", other: "edits")
            case .artifact: changes = counted("versions", updates, one: "new version", other: "new versions")
            default: changes = counted("updates", updates, one: "update", other: "updates")
            }
        }
        if created && !changes.isEmpty { return word("createdWith", ["changes": .text(changes)], "Created · \(changes)") }
        if created { return word("created", "Created") }
        return changes.isEmpty ? word("changed", "Changed") : changes
    }

    /// An entry's second line: the newest change's own words where it has
    /// them (a new todo's text), else what happened.
    public func summary(_ item: FeedItem) -> String {
        if let detail = item.snapshot.detail?.trimmingCharacters(in: .whitespacesAndNewlines), !detail.isEmpty {
            return detail.replacingOccurrences(of: "\n", with: " ")
        }
        return activity(created: item.created, updates: item.updates, kind: FeedSubjectKind(item))
    }

    /// Who acted, for VoiceOver: one or two names in full, then how many more.
    public func actors(_ names: [String], count: Int) -> String {
        let total = max(count, names.count)
        guard let first = names.first else { return "" }
        if total == 1 { return first }
        if total == 2, names.count >= 2 { return word("two", ["first": .text(first), "second": .text(names[1])], "\(first) and \(names[1])") }
        let others = total - 1
        let category = Self.pluralCategory(language: language, count: others)
        return word("others.\(category)", ["name": .text(first), "count": .number(others)], "\(first) and \(others) \(others == 1 ? "other" : "others")")
    }
}
