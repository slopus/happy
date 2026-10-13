import Foundation
import HappyStore
import HappyWire

/// The "Session" alert a long press on a home row opens
/// (hooks/useSessionQuickActions.ts). Which items it offers is decided here;
/// running them goes through `HomeOps`.
public struct SessionQuickActions: Equatable, Sendable {
    public enum Item: String, Equatable, Sendable {
        case details
        case resume
        case fork
        case duplicate
        case copyMetadata = "copy-metadata"
        case copyMetadataAndLogs = "copy-metadata-and-logs"
        case archive
    }

    /// `getResumeAvailability`.
    public struct Resume: Equatable, Sendable {
        public enum Blocker: Equatable, Sendable {
            case missingMachine
            case missingBackendId
            case sameMachineOnly
            case machineOffline
        }

        public var canResume: Bool
        public var canShowResume: Bool
        /// Why resume can't run, shown when it is pressed anyway.
        public var blocker: Blocker?

        static let hidden = Resume(canResume: false, canShowResume: false, blocker: nil)

        public init(canResume: Bool, canShowResume: Bool, blocker: Blocker?) {
            self.canResume = canResume
            self.canShowResume = canShowResume
            self.blocker = blocker
        }

        public init(session: SessionRecord, machine: MachineRecord?) {
            let metadata = session.metadata
            if session.isRig || metadata?["capabilities"]?["resume"]?.boolValue == false {
                self = .hidden
                return
            }
            // useSessionStatus' `isConnected`: anything but disconnected.
            if SessionState(session) != .disconnected {
                self = .hidden
                return
            }
            guard metadata?["machineId"]?.stringValue != nil else {
                self.init(canResume: false, canShowResume: true, blocker: .missingMachine)
                return
            }
            let backendId = [metadata?["claudeSessionId"]?.stringValue, metadata?["codexThreadId"]?.stringValue]
                .contains { !($0 ?? "").isEmpty }
            guard backendId else {
                self.init(canResume: false, canShowResume: true, blocker: .missingBackendId)
                return
            }
            guard let machine else {
                self.init(canResume: false, canShowResume: true, blocker: .sameMachineOnly)
                return
            }
            guard machine.active else {
                self.init(canResume: false, canShowResume: true, blocker: .machineOffline)
                return
            }
            // Older daemons neither publish resumeSupport nor implement the
            // RPC, so the item is hidden rather than offered.
            guard machine.metadata?["resumeSupport"]?["rpcAvailable"]?.boolValue == true else {
                self = .hidden
                return
            }
            self.init(canResume: true, canShowResume: true, blocker: nil)
        }
    }

    public var items: [Item]
    public var resume: Resume
    /// utils/sessionFork.ts `getSessionForkSource`.
    public var forkSource: ForkSource?
    public var canFork: Bool

    public init(session: SessionRecord, machine: MachineRecord?, settings: AccountSettings, devModeEnabled: Bool) {
        resume = Resume(session: session, machine: machine)
        forkSource = Self.forkSource(session)
        canFork = settings.bool("expResumeSession")
            && !session.isRig
            && forkSource != nil
            && machine?.active == true
        var items: [Item] = [.details]
        if resume.canShowResume { items.append(.resume) }
        if canFork { items.append(contentsOf: [.fork, .duplicate]) }
        if devModeEnabled { items.append(contentsOf: [.copyMetadata, .copyMetadataAndLogs]) }
        items.append(.archive)
        self.items = items
    }

    /// The Claude session or Codex thread a fork copies, on the session's
    /// machine and directory.
    public static func forkSource(_ session: SessionRecord) -> ForkSource? {
        let metadata = session.metadata
        func nonEmpty(_ value: String?) -> String? {
            guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return value
        }
        guard let machineId = nonEmpty(metadata?["machineId"]?.stringValue),
              let directory = nonEmpty(metadata?["path"]?.stringValue) else { return nil }
        if metadata?["flavor"]?.stringValue == "codex" {
            guard let thread = nonEmpty(metadata?["codexThreadId"]?.stringValue) else { return nil }
            return .codex(sessionId: session.id, options: CodexForkThreadOptions(machineId: machineId, directory: directory, codexThreadId: thread))
        }
        guard let claude = nonEmpty(metadata?["claudeSessionId"]?.stringValue) else { return nil }
        return .claude(sessionId: session.id, options: ClaudeForkSessionOptions(machineId: machineId, directory: directory, claudeSessionId: claude))
    }

    /// What resume sends the machine (sync/messageMeta.ts
    /// `resolveMessageModeMeta`): the session's model and permission mode.
    /// Throws for a mode its CLI can't parse, which resume refuses rather
    /// than substitute.
    public static func resumeModes(session: SessionRecord, composer: JSONValue, settings: AccountSettings) throws -> (model: String?, permissionMode: String?) {
        let meta = try UserMessageEncoder.modeMeta(
            metadata: session.metadata ?? .object([:]),
            composer: composer,
            settings: .object(settings.values)
        )
        return (meta["model"]?.stringValue, meta["permissionMode"]?.stringValue)
    }

    /// The session's metadata as `JSON.stringify(metadata, null, 2)` writes
    /// it, for "Copy Metadata".
    public static func metadataText(_ session: SessionRecord) -> String? {
        guard let metadata = session.metadata else { return nil }
        return metadata.prettyJSON(indent: 2)
    }

    /// `copySessionMetadataAndLogsToClipboard`. This app keeps no client log,
    /// so the logs section is left out as happy-app leaves out an empty one.
    public static func metadataAndLogsText(_ session: SessionRecord, logs: [String] = []) -> String? {
        guard let metadata = metadataText(session) else { return nil }
        var sections = ["=== Session Metadata ===", metadata]
        if !logs.isEmpty {
            sections.append(contentsOf: ["", "=== Client Logs (\(logs.count) entries) ===", logs.joined(separator: "\n")])
        }
        return sections.joined(separator: "\n")
    }
}

extension JSONValue {
    /// `JSON.stringify(value, null, indent)`: keys in insertion order are
    /// not kept by `JSONValue`, so objects come out sorted.
    func prettyJSON(indent: Int, level: Int = 0) -> String {
        let pad = String(repeating: " ", count: indent * (level + 1))
        let closing = String(repeating: " ", count: indent * level)
        switch self {
        case .object(let object):
            guard !object.isEmpty else { return "{}" }
            let body = object.keys.sorted().map { key in
                "\(pad)\(Self.quote(key)): \(object[key]!.prettyJSON(indent: indent, level: level + 1))"
            }
            return "{\n" + body.joined(separator: ",\n") + "\n\(closing)}"
        case .array(let array):
            guard !array.isEmpty else { return "[]" }
            let body = array.map { "\(pad)\($0.prettyJSON(indent: indent, level: level + 1))" }
            return "[\n" + body.joined(separator: ",\n") + "\n\(closing)]"
        case .string(let string):
            return Self.quote(string)
        case .number(let number):
            if number.isFinite, number == number.rounded(), abs(number) < 1e15 {
                return String(Int64(number))
            }
            return String(number)
        case .bool(let bool):
            return bool ? "true" : "false"
        case .null:
            return "null"
        }
    }

    private static func quote(_ string: String) -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let data = (try? encoder.encode(string)) ?? Data("\"\"".utf8)
        return String(decoding: data, as: UTF8.self)
    }
}
