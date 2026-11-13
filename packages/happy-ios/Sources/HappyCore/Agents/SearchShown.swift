import Foundation

/// How search's results read and where each goes, as desktop's ⌘K palette
/// draws them (happy-desktop `commandPaletteResults.ts`: `remoteRow`,
/// `foundRows`, `surfaceRows`, `artifactRows`): one list of at most
/// `foundLimit` things found, each a title and the quiet line desktop
/// calls its meta, which a content match's words take over. English
/// only, as desktop is.
extension Search {
    /// How many found things the list shows, and how many of its own the
    /// phone offers to the fusion: desktop's `FOUND_LIMIT`.
    public static let foundLimit = 12

    /// Where a result goes.
    public enum Opens: Equatable, Sendable {
        case conversation(agentId: String, title: String)
        case surface(id: String, type: String, name: String)
        case artifact(id: String, type: String, title: String)
        case vaultItem(surfaceId: String, itemId: String, folder: Bool, vaultName: String?)
    }

    /// One result of the computer's as its row shows it.
    public struct Shown: Equatable, Sendable {
        public var title: String
        /// The line under the title: what it is and where, or, for a
        /// content match, the words it was found in.
        public var detail: String?
        public var glyph: String
        public var opens: Opens
        /// The words a content match was found in, which a row the phone
        /// holds shows under its title too.
        public var snippet: String?
    }

    /// What the phone holds to name a result the computer names only by ID.
    public struct Names: Sendable {
        public var surfaces: [String: AgentWire.Surface]
        /// Conversations' titles as home shows them, by agent ID.
        public var conversations: [String: String]
        public var timeZone: TimeZone
        public var locale: Locale

        public init(surfaces: [String: AgentWire.Surface] = [:], conversations: [String: String] = [:], timeZone: TimeZone = .current, locale: Locale = .current) {
            self.surfaces = surfaces
            self.conversations = conversations
            self.timeZone = timeZone
            self.locale = locale
        }
    }

    /// A Surface kind's name (desktop's `surfaceTypeLabel`).
    public static func surfaceTypeLabel(_ type: String?) -> String {
        switch type {
        case "todo": "Todo list"
        case "document": "Document"
        case "calendar": "Calendar"
        case "vault": "Vault"
        case "system_monitor": "System Monitor"
        case "chat": "Chat"
        case "artifact": "Artifact"
        case "bot": "Bot"
        case "task": "Task"
        default: "Shared"
        }
    }

    /// An artifact type's name (desktop's `happyAgentArtifactTypeLabel`).
    public static func artifactTypeLabel(_ type: String?) -> String {
        switch type {
        case "markdown": "Markdown"
        case "html": "Web page"
        case "image": "Image"
        case "image_series": "Image series"
        case "video": "Video"
        case "document": "Document"
        case "gen_ui": "Gen UI"
        default: "Artifact"
        }
    }

    /// An artifact type's glyph, as the phone draws artifacts.
    public static func artifactGlyph(_ type: String?) -> String {
        switch type {
        case "html": "globe-outline"
        case "image", "image_series": "image-outline"
        case "gen_ui": "apps-outline"
        default: "doc"
        }
    }

    /// A conversation kind's name (desktop's `AGENT_KIND_LABEL`).
    static func agentKindLabel(_ kind: String?) -> String {
        switch kind {
        case "task": "Task"
        case "subtask": "Subtask"
        case "bot": "Bot"
        default: "Chat"
        }
    }

    /// The words a match in the content was found in, on one line; nil for
    /// any other match.
    private static func snippet(_ result: Result) -> String? {
        guard result.match == "content" || result.type == "message" else { return nil }
        let line = (result.snippet ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return line.isEmpty ? nil : line
    }

    /// A day as a row's line says it: "Nov 8", or with its time.
    static func day(_ ms: Double, time: Bool, timeZone: TimeZone, locale: Locale) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate(time ? "MMMdjmm" : "MMMd")
        return formatter.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    /// One thing the computer found, as the row that opens it here (desktop's
    /// `remoteRow`); nil for what the phone has nowhere to open: a skill, a
    /// project or a workspace, which have no screen on the phone, anything
    /// archived, and a conversation, or a message of one, in no workspace.
    /// A person isn't one of these either: they are listed apart, under
    /// People (`people`).
    public static func shown(_ result: Result, names: Names) -> Shown? {
        let joined = { (parts: [String?]) -> String? in
            let line = parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            return line.isEmpty ? nil : line
        }
        let surfaceName = result.surfaceId.flatMap { names.surfaces[$0]?.name }
        var shown: Shown
        switch result.type {
        case "vault_file", "vault_folder":
            let folder = result.type == "vault_folder"
            guard let surfaceId = result.surfaceId, let itemId = folder ? result.folderId : result.fileId else { return nil }
            let path = (result.path ?? "").split(separator: "/", omittingEmptySubsequences: false).map { VaultEntry.shownName(String($0)) }.joined(separator: "/")
            shown = Shown(title: VaultEntry.shownName(result.name ?? ""), detail: joined([surfaceName, path]),
                          glyph: folder ? "folder-outline" : result.kind == "artifact" ? "globe-outline" : "doc",
                          opens: .vaultItem(surfaceId: surfaceId, itemId: itemId, folder: folder, vaultName: surfaceName))
            if !folder { shown.snippet = snippet(result) }
        case "document":
            guard let surfaceId = result.surfaceId else { return nil }
            let name = result.name ?? ""
            shown = Shown(title: name, detail: surfaceTypeLabel("document"), glyph: Rows.surfaceGlyph("document"),
                          opens: .surface(id: surfaceId, type: "document", name: name))
            shown.snippet = snippet(result)
        case "todo":
            guard let surfaceId = result.surfaceId else { return nil }
            shown = Shown(title: result.text ?? "", detail: joined([result.status == "completed" ? "Done" : nil, surfaceName]), glyph: "tasks",
                          opens: .surface(id: surfaceId, type: "todo", name: surfaceName ?? ""))
        case "calendar_event":
            guard let surfaceId = result.surfaceId else { return nil }
            let allDay = result.allDay == true
            // An all-day event is a date, the same wherever the phone is.
            let when = result.start.map { day($0, time: !allDay, timeZone: allDay ? TimeZone(identifier: "UTC")! : names.timeZone, locale: names.locale) }
            shown = Shown(title: result.title ?? "", detail: joined([surfaceName, when]), glyph: "calendar",
                          opens: .surface(id: surfaceId, type: "calendar", name: surfaceName ?? ""))
            shown.snippet = snippet(result)
        case "message":
            // A message opens its conversation, where the conversation is known.
            guard let agentId = result.agentId, result.workspaceId != nil else { return nil }
            let conversation = names.conversations[agentId]
            let when = result.createdAt.map { day($0, time: false, timeZone: names.timeZone, locale: names.locale) }
            shown = Shown(title: snippet(result) ?? "", detail: joined([conversation ?? "Chat", result.role == "agent" ? "Agent" : nil, when]),
                          glyph: "chatbubbles-outline", opens: .conversation(agentId: agentId, title: conversation ?? ""))
        case "artifact":
            guard let artifactId = result.artifactId else { return nil }
            let title = result.title ?? ""
            shown = Shown(title: title, detail: artifactTypeLabel(result.artifactType), glyph: artifactGlyph(result.artifactType),
                          opens: .artifact(id: artifactId, type: result.artifactType ?? "", title: title))
            shown.snippet = snippet(result)
        case "surface":
            guard let surfaceId = result.surfaceId else { return nil }
            let name = result.name ?? ""
            let surface = names.surfaces[surfaceId]
            let type = surface?.type ?? result.surfaceType
            shown = Shown(title: name, detail: surfaceTypeLabel(type), glyph: Rows.surfaceGlyph(type, access: surface?.access, policyVault: surface?.policyVault),
                          opens: .surface(id: surfaceId, type: type ?? "", name: name))
        case "agent":
            guard let agentId = result.agentId, result.archived != true, result.workspaceId != nil else { return nil }
            let title = result.title ?? ""
            shown = Shown(title: title, detail: agentKindLabel(result.kind),
                          glyph: result.kind == "task" || result.kind == "bot" ? "agents" : "chatbubbles-outline",
                          opens: .conversation(agentId: agentId, title: title))
        default:
            return nil
        }
        if let snippet = shown.snippet { shown.detail = snippet }
        return shown
    }

    /// One row of the list of what was found: the phone's own result at
    /// `local`, the computer's at `remote`, or both, a thing both found
    /// showing the phone's row with the computer's words under it.
    public struct Placed: Equatable, Sendable {
        public var key: String
        public var local: Int?
        public var remote: Int?
    }

    /// What was found, as desktop's palette lists it (`foundRows`): the
    /// phone's best `foundLimit`, fused with what the computer found that
    /// the phone can open, at most `foundLimit` in all.
    public static func found(local: [String], remote: [(key: String, rank: Int)]) -> [Placed] {
        fuse(remote: remote, local: Array(local.prefix(foundLimit))).prefix(foundLimit).map { Placed(key: $0.key, local: $0.local, remote: $0.remote) }
    }

    /// Where the found things stand among the quick actions and settings,
    /// lower first, as desktop orders its palette's sections by their best
    /// answer: first once the computer has answered with anything, since
    /// nothing has been chosen yet; until then, at the phone's best match.
    public static func foundBest(localRanks: [Int], answered: Bool) -> Int {
        answered ? .min : localRanks.min() ?? .max
    }
}
