import Foundation
import HappyStore

/// One computer as the composer's computer picker lists it: whether it
/// answers, what its Happy Agent makes, and when it was last seen.
///
/// A bot or a task is made by Happy Agent (`NewSessionLaunch.resolve`), so
/// for those the picker lists only computers whose Happy Agent advertises
/// it (`capabilities.bots` / `capabilities.tasks`), and "online" means
/// that Happy Agent answers. A session can start on any computer.
public struct MachineTarget: Equatable, Sendable {
    /// The computer's id (`MachineChoice.id`).
    public var id: String
    public var name: String
    /// What runs on it, with versions (`MachineChoice.daemons`): one
    /// host's Happy CLI and Happy Agent share its name.
    public var daemons = ""
    /// Linked by an old Happy CLI (`MachineChoice.needsRelogin`): listed,
    /// never picked.
    public var needsRelogin = false
    /// Some daemon on it answers.
    public var online: Bool
    /// Its Happy Agent answers.
    public var happyAgentOnline: Bool
    public var makesBots: Bool
    public var makesTasks: Bool
    /// When something on it last answered, in milliseconds; 0 while it
    /// answers, so a heartbeat changes nothing the picker shows.
    public var lastSeenAt: Int64
    /// When its Happy Agent last answered; 0 while it does, or without one.
    public var happyAgentLastSeenAt: Int64 = 0
    /// What Happy Agent starts on here (`NewSessionChoices.defaults(for:)`),
    /// for a kind that moves the draft to this computer.
    var happyAgentDefaults: AgentDefaults.Config?

    public init(id: String, name: String, online: Bool, happyAgentOnline: Bool, makesBots: Bool, makesTasks: Bool, lastSeenAt: Int64) {
        self.id = id
        self.name = name
        self.online = online
        self.happyAgentOnline = happyAgentOnline
        self.makesBots = makesBots
        self.makesTasks = makesTasks
        self.lastSeenAt = lastSeenAt
    }

    init(_ choice: MachineChoice) {
        let rig = RigSessionCreation(metadata: choice.rigMachine?.metadata)
        self.init(
            id: choice.id,
            name: choice.name,
            online: choice.online,
            happyAgentOnline: choice.rigMachine?.active == true,
            makesBots: rig?.supportsBots == true,
            makesTasks: rig?.supportsTasks == true,
            lastSeenAt: choice.online ? 0 : choice.activeAt
        )
        daemons = choice.daemons
        needsRelogin = choice.needsRelogin
        if let agent = choice.rigMachine, !agent.active { happyAgentLastSeenAt = agent.activeAt }
        happyAgentDefaults = rig.map {
            AgentDefaults.Config(permissionMode: $0.defaultPermissionMode ?? "", modelMode: $0.defaultModelKey ?? "",
                                 effortLevel: $0.defaultEffort(forModel: $0.defaultModelKey))
        }
    }

    /// Whether this computer can make `kind`.
    public func makes(_ kind: HomeDockKind) -> Bool {
        switch kind {
        case .session: !needsRelogin
        case .bot: makesBots
        case .task: makesTasks
        }
    }

    /// Whether what `kind` needs here answers: any daemon for a session,
    /// Happy Agent for a bot or a task.
    public func isOnline(for kind: HomeDockKind) -> Bool {
        kind == .session ? online : happyAgentOnline
    }

    /// When what `kind` needs here last answered; nil while it answers.
    public func lastSeen(for kind: HomeDockKind) -> Int64? {
        guard !isOnline(for: kind) else { return nil }
        let at = kind == .session ? lastSeenAt : happyAgentLastSeenAt
        return at > 0 ? at : nil
    }

    /// The computers that can make `kind`, those that answer for it first,
    /// each group in `targets`' order.
    public static func eligible(_ targets: [MachineTarget], for kind: HomeDockKind) -> [MachineTarget] {
        let able = targets.filter { $0.makes(kind) }
        return able.filter { $0.isOnline(for: kind) } + able.filter { !$0.isOnline(for: kind) }
    }

    /// What the menu lists for `kind`: those that can make it, then, for
    /// a session, the computers an old Happy CLI linked, which say what
    /// they need and can't be picked.
    public static func listed(_ targets: [MachineTarget], for kind: HomeDockKind) -> [MachineTarget] {
        eligible(targets, for: kind) + (kind == .session ? targets.filter(\.needsRelogin) : [])
    }

    /// Where `kind` goes when it is picked: the computer already chosen if
    /// it makes `kind` and answers for it; else the first one that does;
    /// else, with all of them offline, the chosen one if it can make it,
    /// then the first that can. Nil when no computer can make `kind`.
    public static func preferred(_ targets: [MachineTarget], for kind: HomeDockKind, current: String?) -> MachineTarget? {
        let able = eligible(targets, for: kind)
        let chosen = able.first { $0.id == current }
        if let chosen, chosen.isOnline(for: kind) { return chosen }
        if let online = able.first(where: { $0.isOnline(for: kind) }) { return online }
        return chosen ?? able.first
    }
}

extension NewSessionChoices {
    /// Why the start can't reach the chosen computer now, shown under its
    /// row before anything is sent.
    public enum Offline: Equatable, Sendable {
        /// Nothing on the computer answers; it was last seen then (ms).
        case computer(lastSeenAt: Int64)
        /// The computer answers, but its Happy Agent, which a bot, a task or
        /// the Happy Agent harness needs, does not.
        case happyAgent
        /// The computer answers, but its Happy CLI, which the harness needs,
        /// does not.
        case happyCLI
    }
}
