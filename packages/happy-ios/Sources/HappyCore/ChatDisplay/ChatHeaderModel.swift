import Foundation
import HappyStore
import HappyWire

/// What ChatHeaderView shows for a session (SessionView.tsx's header
/// props): the name, then the workspace or branch under it with the line
/// changes beside that.
public struct ChatHeaderModel: Equatable, Sendable {
    /// Where the title comes from; HappyUI turns it into copy.
    public var title: Title
    public var subtitle: String?
    public var changes: SessionDetails.LineChanges?
    /// The avatar is in colour only while the session is online.
    public var connected: Bool

    public enum Title: Equatable, Sendable {
        /// `getSessionName`: the bot, the summary, else "New chat".
        case name(String?)
        /// errors.sessionDeleted.
        case deleted
        /// Nothing until sessions have been fetched.
        case loading
    }

    /// `pending`: the chat is still on its way to a machine (a
    /// `pending-chat:` route), which has no name yet and is not deleted.
    public init(session: SessionRecord?, dataReady: Bool, gitStatus: GitStatus?, pending: Bool = false) {
        guard dataReady else {
            self.init(title: .loading)
            return
        }
        if pending {
            self.init(title: .name(nil))
            return
        }
        guard let session else {
            self.init(title: .deleted)
            return
        }
        let git = SessionDetails.gitPresentation(session.metadata, status: gitStatus)
        self.init(
            title: .name(session.title),
            subtitle: Self.subtitle(session.metadata, gitStatus: gitStatus),
            changes: git.changes,
            connected: session.active
        )
    }

    init(title: Title, subtitle: String? = nil, changes: SessionDetails.LineChanges? = nil, connected: Bool = false) {
        self.title = title
        self.subtitle = subtitle
        self.changes = changes
        self.connected = connected
    }

    /// sessionGitPresentation.ts's subtitle: the workspace's name, else the
    /// live branch, else the branch the session started on.
    public static func subtitle(_ metadata: JSONValue?, gitStatus: GitStatus?) -> String? {
        func trimmed(_ value: String?) -> String? {
            guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
            return value
        }
        return trimmed(metadata?["workspace"]?["name"]?.stringValue)
            ?? trimmed(gitStatus?.branch)
            ?? trimmed(metadata?["gitBranch"]?.stringValue)
    }
}

/// EmptyMessages.tsx: an empty chat names the machine and folder it runs
/// in and when it was created.
public struct ChatEmptyState: Equatable, Sendable {
    /// An Ionicons name for the machine's OS.
    public var osIcon: String
    public var host: String?
    /// The folder, with the home directory as `~`.
    public var path: String?
    public var created: DuplicateSheetModel.Age

    public init(metadata: JSONValue?, createdAt: Int64, now: Int64) {
        osIcon = Self.osIcon(metadata?["os"]?.stringValue)
        host = metadata?["host"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        path = metadata?["path"]?.stringValue.flatMap { path in
            path.isEmpty ? nil : SessionDetails.pathRelativeToHome(path, homeDir: metadata?["homeDir"]?.stringValue)
        }
        created = DuplicateSheetModel.age(of: Double(createdAt), now: Double(now))
    }

    /// `getOSIcon`.
    public static func osIcon(_ os: String?) -> String {
        guard let os, !os.isEmpty else { return "hardware-chip-outline" }
        let lower = os.lowercased()
        if lower.contains("darwin") || lower.contains("mac") { return "laptop-outline" }
        if lower.contains("win") { return "desktop-outline" }
        if lower.contains("linux") { return "terminal-outline" }
        return "hardware-chip-outline"
    }
}

/// SessionView's CLI version warning, the pill under the header: the
/// session's CLI predates `MINIMUM_CLI_VERSION`, and the warning for that
/// version on its machine hasn't been dismissed.
public struct CliVersionWarning: Equatable, Sendable {
    /// Where a dismissal is kept; without one a tap does nothing.
    public var machineId: String?
    public var version: String

    public init?(metadata: JSONValue?, acknowledged: [String: String]) {
        guard let version = metadata?["version"]?.stringValue, !version.isEmpty,
              !SessionDetails.isVersionSupported(version) else { return nil }
        let machineId = metadata?["machineId"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        if let machineId, acknowledged[machineId] == version { return nil }
        self.machineId = machineId
        self.version = version
    }

    /// `acknowledged` with this warning dismissed, or nil if it can't be.
    public func dismissed(in acknowledged: [String: String]) -> [String: String]? {
        guard let machineId else { return nil }
        var acknowledged = acknowledged
        acknowledged[machineId] = version
        return acknowledged
    }
}

/// PendingChatPlaceholder.tsx, for a chat no machine has agreed to run yet:
/// under "Starting a new chat…", what was sent before it existed, or else
/// the folder of the chat it was started beside, which is where it will run.
public struct PendingChatPlaceholderModel: Equatable, Sendable {
    public enum Detail: Equatable, Sendable {
        /// The queued messages, a blank line between them.
        case queued(String)
        /// The anchor's folder, with the home directory as `~`.
        case path(String)
    }

    public var detail: Detail?

    public init(queued: [String], anchorMetadata: JSONValue?) {
        if !queued.isEmpty {
            detail = .queued(queued.joined(separator: "\n\n"))
        } else if let path = anchorMetadata?["path"]?.stringValue, !path.isEmpty {
            detail = .path(SessionDetails.pathRelativeToHome(path, homeDir: anchorMetadata?["homeDir"]?.stringValue))
        } else {
            detail = nil
        }
    }
}
