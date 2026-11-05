import Foundation
import HappyWire

/// What a Feed entry is about, as far as its glyph and its changes' noun
/// go (desktop's `feedSubjectKind`): its subject's type and, for a
/// Surface, the type the directory says it is.
public enum FeedSubjectKind: String, Equatable, Hashable, Sendable {
    case task, bot, artifact, document, todoList, calendar, surface, unknown

    public init(subject: String, surfaceType: String? = nil) {
        switch subject {
        case "task": self = .task
        case "bot": self = .bot
        case "artifact": self = .artifact
        case "surface":
            switch surfaceType {
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
    public var loading: String { word("loading", "Loading activity…") }
    public var unavailable: String { word("unavailable", "Activity couldn’t be loaded. Check that your computer is on.") }
    public var unsupported: String { word("unsupported", "This Happy Agent doesn’t track activity yet. Update it to see activity here.") }
    public var everywhere: String { word("everywhere", "Everywhere") }
    public var places: String { word("places", "Places") }
    public var noClusters: String { word("noClusters", "Nothing to follow yet. Tasks, bots, documents and todo lists show up here once something happens in them.") }
    public var loadingClusters: String { word("loadingClusters", "Loading…") }
    public var clustersUnavailable: String { word("clustersUnavailable", "These couldn’t be loaded. Check that your computer is on.") }
    public var peekEmpty: String { word("peekEmpty", "Nothing has happened here in the last 30 days.") }
    public var unreadMark: String { word("unreadMark", "Unread") }
    public var you: String { word("you", "You") }
    /// The places that are no one thing: everything, and the team.
    public var everything: String { word("everything", "Everything") }
    public var team: String { word("team", "Team") }
    public var muted: String { word("muted", "Muted") }

    /// What a place in Following is called.
    public func name(_ name: FeedPlace.Name) -> String {
        switch name {
        case .everything: everything
        case .team: team
        case .named(let name): name
        }
    }

    public func name(_ name: FeedActorName) -> String {
        switch name {
        case .you: you
        case .named(let name): name
        }
    }

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

    /// A row's second line: the newest change's own words where it has
    /// them (a new todo's text, as the todo reads now), else what happened.
    public func summary(_ row: FeedRow) -> String {
        row.detail ?? activity(created: row.created, updates: row.updates, kind: row.kind)
    }

    /// Who acted, for VoiceOver: one or two names in full, then how many
    /// more, counting those not known by name yet.
    public func actors(named names: [FeedActorName], count: Int) -> String {
        actors(names.map(name), count: count)
    }

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
