import Foundation
import HappyStore
import HappyWire

/// The goal the agent is working towards, as AgentGoalBar shows it
/// (agentGoalStatus.ts `resolveVisibleAgentGoalStatus`): only an active
/// goal, only while the session is online, and only when it was reported
/// by the very Claude session or Codex thread this session runs, so a goal
/// left over from another run never shows.
public struct VisibleAgentGoal: Equatable, Sendable {
    public var text: String
    /// The buttons, in AgentGoalBar's order (edit, stop, clear), for the
    /// capabilities the agent reported.
    public var actions: [SessionGoalAction]

    public init?(_ session: SessionRecord) {
        guard session.active, let goal = session.agentState?["agentGoalStatus"], goal["status"]?.stringValue == "active" else { return nil }
        guard let text = Self.trimmed(goal["text"]), let source = goal["sourceSessionId"].flatMap(Self.trimmed) else { return nil }
        let expected: String?
        switch goal["source"]?.stringValue {
        case "claude": expected = session.metadata?["claudeSessionId"]?.stringValue
        case "codex": expected = session.metadata?["codexThreadId"]?.stringValue
        default: expected = nil
        }
        guard let expected, source == expected else { return nil }
        self.text = text
        let capabilities = goal["capabilities"]
        actions = [SessionGoalAction.edit, .stop, .clear].filter { capabilities?[$0.rawValue]?.boolValue == true }
    }

    /// zod's `.trim().min(1)`.
    private static func trimmed(_ value: JSONValue?) -> String? {
        guard let value = value?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    /// agentGoalActionHandler.ts: what a tapped button sends, if anything.
    /// Stop sends nothing yet; Edit sends only a new, different objective
    /// (`edited` is what the prompt returned, nil when cancelled).
    public static func dispatch(_ action: SessionGoalAction, current: String, edited: String?) -> (action: SessionGoalAction, objective: String?)? {
        switch action {
        case .stop:
            return nil
        case .clear:
            return (.clear, nil)
        case .edit:
            guard let goal = edited?.trimmingCharacters(in: .whitespacesAndNewlines), !goal.isEmpty,
                  goal != current.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
            return (.edit, goal)
        }
    }
}

/// RigActivityBar: what a Happy Agent session has running besides the
/// conversation (rig.ts `getRigActivityIndicators`).
public struct RigActivityIndicator: Equatable, Sendable {
    public enum Kind: String, Sendable {
        case subagents, workflows, processes, tasks
    }

    public var kind: Kind
    public var count: Int
    /// Shown as "+N queued" when there are any.
    public var queued: Int

    public init(kind: Kind, count: Int, queued: Int = 0) {
        self.kind = kind
        self.count = count
        self.queued = queued
    }

    public static func indicators(_ metadata: JSONValue?) -> [RigActivityIndicator] {
        guard metadata?["client"]?["id"]?.stringValue == "rig", let activity = metadata?["activity"], activity.objectValue != nil else { return [] }
        func count(_ group: String, _ key: String) -> Int {
            Int(activity[group]?[key]?.numberValue ?? 0)
        }
        var indicators: [RigActivityIndicator] = []
        if count("subagents", "running") > 0 || count("subagents", "queued") > 0 {
            indicators.append(RigActivityIndicator(kind: .subagents, count: count("subagents", "running"), queued: count("subagents", "queued")))
        }
        if count("workflows", "running") > 0 {
            indicators.append(RigActivityIndicator(kind: .workflows, count: count("workflows", "running")))
        }
        if count("processes", "running") > 0 {
            indicators.append(RigActivityIndicator(kind: .processes, count: count("processes", "running")))
        }
        if count("tasks", "pending") + count("tasks", "inProgress") > 0 {
            indicators.append(RigActivityIndicator(kind: .tasks, count: count("tasks", "inProgress"), queued: count("tasks", "pending")))
        }
        return indicators
    }
}

/// SessionView's InactiveArchivedHint, above the composer of a session
/// that has lost its agent (archived, or its CLI stopped): "This session is
/// inactive.", then Resume when it can be resumed from here, or else the
/// commands that resume it from a terminal. Not for Happy Agent, nor for a
/// chat that hasn't been created yet.
public struct InactiveSessionHint: Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        case resume
        /// resumeCommand.ts's block, one command a line.
        case command(lines: [String])
        /// Neither: the notice alone.
        case noticeOnly
    }

    public var action: Action

    public init?(session: SessionRecord?, machine: MachineRecord?) {
        guard let session, SessionState(session) == .disconnected, !session.isRig else { return nil }
        if SessionDetails.resumeAvailability(session, machine: machine).canResume {
            action = .resume
        } else if let lines = SessionDetails.resumeCommandLines(session.metadata) {
            action = .command(lines: lines)
        } else {
            action = .noticeOnly
        }
    }

    /// What the command block copies: its lines, one a line.
    public var copyText: String? {
        guard case .command(let lines) = action else { return nil }
        return lines.joined(separator: "\n")
    }
}
