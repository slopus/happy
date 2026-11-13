import Foundation

/// `GET /v0/permissions` on a Happy Cloud server: what the person's role
/// lets them do. Only `granted` decides anything; the role's name is shown
/// at most. A role changed at the accounts service lands with the next
/// server token (within 15 minutes), so it is read again on every
/// reconnect as well as on `role.*`.
public struct Permissions: Decodable, Equatable, Sendable {
    public var role: String?
    public var granted: Set<String>

    public init(role: String? = nil, granted: Set<String>) {
        self.role = role
        self.granted = granted
    }

    enum CodingKeys: String, CodingKey { case role, granted }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = try? container.decodeIfPresent(String.self, forKey: .role)
        granted = Set(try container.decode([String].self, forKey: .granted))
    }

    public func allows(_ permission: Permission) -> Bool { granted.contains(permission.rawValue) }

    /// The ones the phone has a control for.
    public enum Permission: String, Sendable {
        /// Surfaces, vault files, artifacts, bots, tasks, messages to agents.
        case contentWrite = "content.write"
        case projectsManage = "projects.manage"
        /// Admin bots, the Chief of Staff among them, and input to them.
        case botsManage = "bots.manage"
        /// The server's own settings, its name among them.
        case configManage = "config.manage"
        /// The team's inference providers; the person's own take `providers.own`.
        case providersManage = "providers.manage"
        case providersOwn = "providers.own"
        /// Reading and joining machines, and adding a private one of one's own.
        case computeUse = "compute.use"
        /// Adding a machine in any mode, freeing a held one, and its host facts.
        case poolsManage = "pools.manage"
        /// The server's instructions and security policy (`PolicyDocument`).
        case policyEdit = "policy.edit"
    }

    public static let refreshEvents = ["role.", "member.updated", "member.removed"]
}

/// What a connection lets the person do. A computer, or a server that is
/// not Happy Cloud, gates nothing, as before roles. A cloud server gates
/// everything until its permissions are read, and keeps it gated if the
/// read fails: a control is never shown only to be refused.
public enum RoleGate: Equatable, Sendable {
    case open
    case cloud(Permissions?)

    public func allows(_ permission: Permissions.Permission) -> Bool {
        switch self {
        case .open: true
        case .cloud(let permissions): permissions?.allows(permission) ?? false
        }
    }

    /// Writing in a conversation: `content.write`, and for the Chief of
    /// Staff, an admin bot, `bots.manage` too.
    public func allowsSending(toChiefOfStaff: Bool) -> Bool {
        allows(.contentWrite) && (!toChiefOfStaff || allows(.botsManage))
    }
}

extension AgentClient {
    public func permissions() async throws -> Permissions {
        try await decode(Permissions.self, "GET", "/v0/permissions")
    }
}

extension AgentClientError {
    /// A route a Happy Cloud server's role table refuses: `403`, code
    /// `forbidden`, "This needs the <id> permission." A computer's own
    /// `403 forbidden` ("Only the owner can archive this task.") says
    /// something worth reading, so it isn't one.
    public var isForbidden: Bool {
        guard case .status(403, "forbidden", let message?) = self else { return false }
        return message.hasPrefix("This needs the ") && message.hasSuffix(" permission.")
    }
}

/// What the person may do in one vault on a Happy Cloud server, as its
/// Surface says (`access`, and `policyVault` on a server from before the
/// documents moved to its settings: `PolicyDocument.served`). A server that doesn't say, an
/// older one or a computer, leaves it writable. The access rules
/// themselves (`accessPolicy`) are not read: the phone doesn't edit them.
public struct VaultAccess: Equatable, Sendable {
    public enum Level: String, Sendable { case none, read, write }
    public var level: Level
    public var policyVault: Bool

    public init(level: Level = .write, policyVault: Bool = false) {
        self.level = level
        self.policyVault = policyVault
    }

    public init(access: String?, policyVault: Bool?) {
        self.init(level: access.flatMap(Level.init(rawValue:)) ?? .write, policyVault: policyVault ?? false)
    }

    /// Listed but closed to the person: its name only, and a lock.
    public var isLocked: Bool { level == .none }

    /// Files can be added, changed, moved and restored: write access, and
    /// a role that may write content.
    public func canWrite(_ gate: RoleGate) -> Bool { level == .write && gate.allows(.contentWrite) }

    /// The retention edit: never on the Policy vault, whose retention is fixed.
    public func canEditSettings(_ gate: RoleGate) -> Bool { canWrite(gate) && !policyVault }

    /// The Policy vault's two folders at its root and the document in each,
    /// which the server never lets be moved, renamed or deleted. Known by
    /// name and place: they have no other mark. `parent` is the folder
    /// holding `entry`, nil at the root; where that isn't known (a file
    /// opened from search), a document of either name is taken as one.
    public func isProtected(_ entry: VaultEntry, in parent: VaultEntry?, parentKnown: Bool = true) -> Bool {
        guard policyVault else { return false }
        if entry.isFolder { return entry.parentId == nil && Self.protectedFiles[entry.name] != nil }
        guard parentKnown else { return Self.protectedFiles.values.contains(entry.name) }
        guard let parent, parent.parentId == nil, parent.id == entry.parentId else { return false }
        return Self.protectedFiles[parent.name] == entry.name
    }

    static let protectedFiles = ["Global": "AGENTS.md", "Security": "SECURITY.md"]
}
