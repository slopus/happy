import Foundation
import HappyStore
import HappyWire

/// Everything app/(app)/session/[id]/info.tsx decides before drawing: which
/// rows show and what they say. HappyUI turns it into item groups.
public struct SessionInfoModel: Equatable, Sendable {
    public var sessionId: String
    /// sessionUtils.ts `getSessionName`; nil reads "New chat".
    public var title: String?
    public var isConnected: Bool
    public var isBot: Bool

    // Quick Actions
    public var git: SessionDetails.GitPresentation
    public var machineId: String?
    public var resume: SessionDetails.ResumeAvailability
    public var canFork: Bool
    public var forkSource: ForkSource?
    public var parentSessionId: String?

    /// The CLI predates `MINIMUM_CLI_VERSION`.
    public var cliOutdated: Bool

    // Session details
    public var sessionIdShort: String
    public var claudeSessionId: String?
    public var codexThreadId: String?
    /// Shown only while disconnected.
    public var resumeCommand: String?
    public var createdAt: Int64
    public var updatedAt: Int64
    public var seq: Int

    /// The Metadata group; nil without metadata.
    public var metadata: Metadata?
    /// The Agent State group; nil without agent state and for Happy Agent.
    public var agentState: AgentState?

    // Activity
    public var thinking: Bool
    public var thinkingAt: Int64
    public var activity: SessionDetails.Activity

    public struct Metadata: Equatable, Sendable {
        public var host: String?
        public var path: String
        public var cliVersion: String?
        public var operatingSystem: String?
        /// Happy Agent's client and version.
        public var client: String?
        public var aiProvider: String
        public var model: String?
        /// Not shown for Happy Agent.
        public var sandbox: String?
        public var dangerouslySkipPermissions: String?
        public var processId: String?
        public var happyHome: String?
    }

    public struct AgentState: Equatable, Sendable {
        public var controlledByUser: Bool
        /// Zero hides the row.
        public var pendingRequests: Int
    }

    /// `permissionMode` is the session's local pick (happy-app's
    /// `session.permissionMode`, here the composer's state), which the
    /// "Dangerously Skip Permissions" row reads.
    public init(session: SessionRecord, machine: MachineRecord?, settings: AccountSettings, gitStatus: GitStatus?, permissionMode: String?) {
        let metadata = session.metadata
        let string = { (key: String) in metadata?[key]?.stringValue }
        sessionId = session.id
        title = session.title
        isConnected = SessionState(session) != .disconnected
        isBot = session.isBot

        git = SessionDetails.gitPresentation(metadata, status: gitStatus)
        machineId = SessionDetails.truthy(metadata?["machineId"])
        resume = SessionDetails.resumeAvailability(session, machine: machine)
        canFork = SessionDetails.canFork(session, machine: machine, settings: settings)
        forkSource = SessionDetails.forkSource(session)
        parentSessionId = SessionDetails.truthy(metadata?["parentSessionId"])

        let version = SessionDetails.truthy(metadata?["version"])
        cliOutdated = version.map { !SessionDetails.isVersionSupported($0) } ?? false

        sessionIdShort = SessionDetails.shortId(session.id)
        claudeSessionId = SessionDetails.truthy(metadata?["claudeSessionId"])
        codexThreadId = SessionDetails.truthy(metadata?["codexThreadId"])
        resumeCommand = isConnected ? nil : SessionDetails.resumeCommand(metadata)
        createdAt = session.createdAt
        updatedAt = session.updatedAt
        seq = session.seq

        if let metadata, metadata != .null {
            let homeDir = string("homeDir")
            let identity = RigIdentity(metadata)
            let isRig = session.isRig
            var client: String?
            if isRig {
                let name = metadata["client"]?["name"]?.stringValue ?? "Rig"
                let version = SessionDetails.truthy(metadata["client"]?["version"])
                client = name + (version.map { " \($0)" } ?? "")
            }
            let pid = metadata["hostPid"]
            self.metadata = Metadata(
                host: string("host"),
                path: SessionDetails.pathRelativeToHome(string("path") ?? "", homeDir: homeDir),
                cliVersion: version,
                operatingSystem: SessionDetails.truthy(metadata["os"]).map(SessionDetails.osPlatform),
                client: client,
                aiProvider: SessionDetails.aiProvider(metadata),
                model: identity?.modelName,
                sandbox: isRig ? nil : SessionDetails.sandbox(metadata["sandbox"], homeDir: homeDir),
                dangerouslySkipPermissions: isRig ? nil : SessionDetails.dangerouslySkipPermissions(
                    metadata["dangerouslySkipPermissions"],
                    flavor: string("flavor"),
                    permissionMode: permissionMode,
                    sandbox: metadata["sandbox"]
                ),
                processId: pid?.numberValue.flatMap { $0 == 0 ? nil : SessionDetails.jsNumber($0) },
                happyHome: SessionDetails.truthy(metadata["happyHomeDir"]).map { SessionDetails.pathRelativeToHome($0, homeDir: homeDir) }
            )
        } else {
            self.metadata = nil
        }

        if let state = session.agentState, state != .null, !session.isRig {
            agentState = AgentState(
                controlledByUser: Self.truthy(state["controlledByUser"]),
                pendingRequests: state["requests"]?.objectValue?.count ?? 0
            )
        } else {
            agentState = nil
        }

        thinking = session.thinking
        thinkingAt = session.thinkingAt
        activity = SessionDetails.activity(metadata)
    }

    /// JavaScript truthiness for a flag that may be missing or not a bool.
    static func truthy(_ value: JSONValue?) -> Bool {
        switch value {
        case .bool(let flag)?: flag
        case .number(let number)?: number != 0 && !number.isNaN
        case .string(let text)?: !text.isEmpty
        case .array?, .object?: true
        case .null?, nil: false
        }
    }
}

/// app/(app)/machine/[id].tsx's rows.
public struct MachineDetailsModel: Equatable, Sendable {
    public var machineId: String
    /// `displayName || host || 'unknown machine'`.
    public var name: String
    public var online: Bool
    /// The rename prompt's default and placeholder.
    public var displayName: String
    public var hostPlaceholder: String?

    /// Present when the daemon has reported its state.
    public var daemon: Daemon?
    public var daemonStateVersion: Int
    public var cliAvailability: CLIAvailability?
    /// The five most recently updated sessions on this machine.
    public var recentSessions: [RecentSession]

    public var host: String
    public var username: String?
    public var homeDirectory: String?
    public var platform: String?
    public var architecture: String?
    /// nil reads "Never".
    public var lastSeen: Int64?
    public var metadataVersion: Int

    public struct Daemon: Equatable, Sendable {
        public var pid: String?
        public var httpPort: String?
        public var startedAt: Int64?
        public var cliVersion: String?
    }

    public struct CLIAvailability: Equatable, Sendable {
        public var claude: Bool
        public var codex: Bool
        public var gemini: Bool
        public var openclaw: Bool
        /// Only daemons that know Happy Agent report it.
        public var rig: Bool?
        public var detectedAt: Int64
    }

    public struct RecentSession: Equatable, Sendable {
        public var id: String
        /// nil reads "New chat".
        public var title: String?
        /// `getSessionSubtitle`: the path from home, or nil for "unknown".
        public var subtitle: String?
    }

    public static let recentSessionLimit = 5

    public init(machine: MachineRecord, sessions: [SessionRecord]) {
        let metadata = machine.metadata
        let string = { (key: String) in SessionDetails.truthy(metadata?[key]) }
        machineId = machine.id
        name = string("displayName") ?? string("host") ?? "unknown machine"
        online = machine.active
        displayName = string("displayName") ?? ""
        hostPlaceholder = string("host")

        if let state = machine.daemonState, state != .null {
            func positive(_ key: String) -> Double? {
                guard let value = state[key]?.numberValue, value != 0, !value.isNaN else { return nil }
                return value
            }
            daemon = Daemon(
                pid: positive("pid").map(SessionDetails.jsNumber),
                httpPort: positive("httpPort").map(SessionDetails.jsNumber),
                startedAt: positive("startTime").map { Int64($0) },
                cliVersion: SessionDetails.truthy(state["startedWithCliVersion"])
            )
        } else {
            daemon = nil
        }
        daemonStateVersion = machine.daemonStateVersion

        if let cli = metadata?["cliAvailability"], case .object = cli {
            let rig = cli["rig"]
            cliAvailability = CLIAvailability(
                claude: SessionInfoModel.truthy(cli["claude"]),
                codex: SessionInfoModel.truthy(cli["codex"]),
                gemini: SessionInfoModel.truthy(cli["gemini"]),
                openclaw: SessionInfoModel.truthy(cli["openclaw"]),
                rig: rig == nil ? nil : SessionInfoModel.truthy(rig),
                detectedAt: Int64(cli["detectedAt"]?.numberValue ?? 0)
            )
        } else {
            cliAvailability = nil
        }

        // storage.ts sessionsData: every session but side chats, newest
        // update first (the sort is stable, as JavaScript's is).
        recentSessions = sessions.enumerated()
            .filter { $0.element.metadata?["machineId"]?.stringValue == machine.id && $0.element.metadata?["isSideChat"]?.boolValue != true }
            .sorted { $0.element.updatedAt != $1.element.updatedAt ? $0.element.updatedAt > $1.element.updatedAt : $0.offset < $1.offset }
            .prefix(Self.recentSessionLimit)
            .map { _, session in
                RecentSession(
                    id: session.id,
                    title: session.title,
                    subtitle: session.metadata.map {
                        SessionDetails.pathRelativeToHome($0["path"]?.stringValue ?? "", homeDir: $0["homeDir"]?.stringValue)
                    }
                )
            }

        host = string("host") ?? machine.id
        username = string("username")
        homeDirectory = string("homeDir")
        platform = string("platform")
        architecture = string("arch")
        lastSeen = machine.activeAt == 0 ? nil : machine.activeAt
        metadataVersion = machine.metadataVersion
    }

    /// The metadata a rename writes: everything as it was, with the new
    /// display name, or without one when the field was left empty.
    public static func renamedMetadata(_ metadata: JSONValue?, displayName: String) -> JSONValue {
        var object = metadata?.objectValue ?? [:]
        let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        object["displayName"] = trimmed.isEmpty ? nil : .string(trimmed)
        return .object(object)
    }
}

extension SessionDetails {
    /// `new Date(ms).toLocaleString()`: "10/13/2026, 3:04:05 PM" in en-US.
    public static func localeDateTime(_ milliseconds: Int64, locale: Locale = .autoupdatingCurrent, timeZone: TimeZone = .autoupdatingCurrent) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateFormat = DateFormatter.dateFormat(fromTemplate: "yMdjmmss", options: 0, locale: locale) ?? "M/d/y, h:mm:ss a"
        return formatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1000))
    }

    /// `JSON.stringify(value, null, 2)`. Keys come out sorted: JSONValue
    /// doesn't keep the order they arrived in.
    public static func prettyJSON(_ value: JSONValue) -> String {
        var out = ""
        write(value, indent: 0, into: &out)
        return out
    }

    private static func write(_ value: JSONValue, indent: Int, into out: inout String) {
        let pad = String(repeating: " ", count: indent + 2)
        let close = String(repeating: " ", count: indent)
        switch value {
        case .null: out += "null"
        case .bool(let flag): out += flag ? "true" : "false"
        case .number(let number): out += number.isFinite ? jsNumber(number) : "null"
        case .string(let text): out += jsonString(text)
        case .array(let items):
            if items.isEmpty { out += "[]"; return }
            out += "[\n"
            for (index, item) in items.enumerated() {
                out += pad
                write(item, indent: indent + 2, into: &out)
                out += index < items.count - 1 ? ",\n" : "\n"
            }
            out += close + "]"
        case .object(let object):
            if object.isEmpty { out += "{}"; return }
            out += "{\n"
            let keys = object.keys.sorted()
            for (index, key) in keys.enumerated() {
                out += pad + jsonString(key) + ": "
                write(object[key]!, indent: indent + 2, into: &out)
                out += index < keys.count - 1 ? ",\n" : "\n"
            }
            out += close + "}"
        }
    }

    /// A JSON string literal escaped as JSON.stringify escapes it.
    static func jsonString(_ text: String) -> String {
        var out = "\""
        for unit in text.unicodeScalars {
            switch unit {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            default:
                if unit.value < 0x20 {
                    out += String(format: "\\u%04x", unit.value)
                } else {
                    out.unicodeScalars.append(unit)
                }
            }
        }
        return out + "\""
    }

    /// copySessionMetadataToClipboard.ts: the metadata as pretty JSON.
    /// happy-app appends its in-memory client log; this app keeps none, so
    /// the "& Client Logs" copy is the metadata under its heading, as
    /// happy-app writes it when the log is empty.
    public static func metadataClipboard(_ metadata: JSONValue, withLogs: Bool) -> String {
        let json = prettyJSON(metadata)
        return withLogs ? ["=== Session Metadata ===", json].joined(separator: "\n") : json
    }
}
