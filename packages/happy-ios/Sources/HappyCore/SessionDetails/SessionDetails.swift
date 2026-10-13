import Foundation
import HappyStore
import HappyWire

// What the session info and machine screens say about a session, after
// happy-app's utils/sessionUtils.ts, utils/resumeCommand.ts,
// utils/sessionFork.ts, utils/versionUtils.ts, sync/rig.ts and
// utils/sessionGitPresentation.ts. Copy that happy-app hard-codes (not in
// en.ts) is kept here verbatim; translated copy stays in HappyUI.

public enum SessionDetails {
    /// versionUtils.ts `MINIMUM_CLI_VERSION`.
    public static let minimumCLIVersion = "0.10.0"

    /// sessionUtils.ts `formatPathRelativeToHome`: the home directory as `~`.
    public static func pathRelativeToHome(_ path: String, homeDir: String?) -> String {
        guard let homeDir, !homeDir.isEmpty else { return path }
        let home = homeDir.hasSuffix("/") ? String(homeDir.dropLast()) : homeDir
        guard path.hasPrefix(home) else { return path }
        let relative = String(path.dropFirst(home.count))
        if relative.hasPrefix("/") { return "~" + relative }
        if relative.isEmpty { return "~" }
        return "~/" + relative
    }

    /// sessionUtils.ts `formatOSPlatform`.
    public static func osPlatform(_ platform: String?) -> String {
        guard let platform, !platform.isEmpty else { return "" }
        let names = [
            "darwin": "macOS", "win32": "Windows", "linux": "Linux", "android": "Android", "ios": "iOS",
            "aix": "AIX", "freebsd": "FreeBSD", "openbsd": "OpenBSD", "sunos": "SunOS",
        ]
        return names[platform.lowercased()] ?? platform
    }

    /// versionUtils.ts `compareVersions`: -1, 0 or 1. A prerelease suffix is
    /// dropped and missing parts count as zero; a part that isn't a number
    /// compares as NaN does in JavaScript (never less, never greater).
    public static func compareVersions(_ left: String, _ right: String) -> Int {
        func parts(_ version: String) -> [Double] {
            let core = version.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? version
            return core.split(separator: ".", omittingEmptySubsequences: false).map { Double($0) ?? .nan }
        }
        let a = parts(left)
        let b = parts(right)
        for index in 0..<max(a.count, b.count) {
            let x = index < a.count ? a[index] : 0
            let y = index < b.count ? b[index] : 0
            if x > y { return 1 }
            if x < y { return -1 }
        }
        return 0
    }

    /// versionUtils.ts `isVersionSupported`.
    public static func isVersionSupported(_ version: String?, minimum: String = minimumCLIVersion) -> Bool {
        guard let version, !version.isEmpty else { return false }
        return compareVersions(version, minimum) >= 0
    }

    /// info.tsx: `${id.substring(0, 8)}...${id.substring(id.length - 8)}`,
    /// counted in UTF-16 units as JavaScript counts them.
    public static func shortId(_ id: String) -> String {
        let units = Array(id.utf16)
        let head = String(decoding: units.prefix(8), as: UTF16.self)
        let tail = String(decoding: units[max(0, units.count - 8)...], as: UTF16.self)
        return "\(head)...\(tail)"
    }

    // MARK: Resume command (resumeCommand.ts)

    public static func resumeCommand(_ metadata: JSONValue?) -> String? {
        guard let lines = resumeCommandLines(metadata) else { return nil }
        return lines.joined(separator: isWindows(metadata) ? "; " : " && ")
    }

    static func resumeCommandLines(_ metadata: JSONValue?) -> [String]? {
        guard let invocation = resumeInvocation(metadata) else { return nil }
        if let cd = changeDirectoryCommand(metadata) { return [cd, invocation] }
        return [invocation]
    }

    private static func isWindows(_ metadata: JSONValue?) -> Bool {
        metadata?["os"]?.stringValue?.lowercased() == "win32"
    }

    private static func resumeInvocation(_ metadata: JSONValue?) -> String? {
        if metadata?["client"]?["id"]?.stringValue == "rig" || metadata?["capabilities"]?["resume"]?.boolValue == false {
            return nil
        }
        let flavor = metadata?["flavor"]?.stringValue
        if flavor == "codex" || flavor == "openai" || flavor == "gpt", let thread = truthy(metadata?["codexThreadId"]) {
            return "happy codex --resume \(thread)"
        }
        if let claude = truthy(metadata?["claudeSessionId"]) {
            return "happy claude --resume \(claude)"
        }
        return nil
    }

    private static func changeDirectoryCommand(_ metadata: JSONValue?) -> String? {
        guard let path = metadata?["path"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty else {
            return nil
        }
        if isWindows(metadata) {
            return "Set-Location -LiteralPath '\(path.replacingOccurrences(of: "'", with: "''"))'"
        }
        return "cd '\(path.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    // MARK: Metadata rows (info.tsx)

    /// info.tsx `formatSandboxMetadata`.
    public static func sandbox(_ sandbox: JSONValue?, homeDir: String?) -> String {
        guard let sandbox, sandbox != .null else { return "Disabled" }
        switch sandbox {
        case .string(let value): return value
        case .bool(let value): return value ? "true" : "false"
        case .number(let value): return jsNumber(value)
        case .null: return "Disabled"
        // An array is an object to JavaScript, with no fields set.
        case .array: return "Enabled"
        case .object(let value):
            if value["enabled"] == .bool(false) { return "Disabled" }
            var parts = ["Enabled"]
            if let isolation = value["sessionIsolation"]?.stringValue { parts.append("isolation=\(isolation)") }
            if let network = value["networkMode"]?.stringValue { parts.append("network=\(network)") }
            if let root = value["workspaceRoot"]?.stringValue {
                parts.append("workspace=\(pathRelativeToHome(root, homeDir: homeDir))")
            }
            return parts.joined(separator: " | ")
        }
    }

    /// info.tsx `formatDangerouslySkipPermissionsMetadata`.
    public static func dangerouslySkipPermissions(_ value: JSONValue?, flavor: String?, permissionMode: String?, sandbox: JSONValue?) -> String {
        if case .bool(let enabled)? = value { return enabled ? "Enabled" : "Disabled" }
        if permissionMode == "bypassPermissions" || permissionMode == "yolo" { return "Enabled" }
        if flavor == "claude", case .object(let object)? = sandbox, object["enabled"] == .bool(true) { return "Enabled" }
        return "Unknown"
    }

    /// info.tsx's AI Provider row: Happy Agent's provider, else the flavor.
    public static func aiProvider(_ metadata: JSONValue?) -> String {
        if let identity = RigIdentity(metadata) { return identity.providerName }
        let flavor = truthy(metadata?["flavor"]) ?? "claude"
        switch flavor {
        case "claude": return "Claude"
        case "gpt", "openai": return "Codex"
        case "gemini": return "Gemini"
        case "openclaw": return "OpenClaw"
        default: return flavor
        }
    }

    /// The Activity group's counters (`metadata.activity`), hard-coded
    /// English in info.tsx. Nil when the row is hidden.
    public static func activity(_ metadata: JSONValue?) -> Activity {
        let activity = metadata?["activity"]
        func count(_ group: String, _ key: String) -> Int {
            Int(activity?[group]?[key]?.numberValue ?? 0)
        }
        let subagentsRunning = count("subagents", "running")
        let subagentsQueued = count("subagents", "queued")
        let workflows = count("workflows", "running")
        let processes = count("processes", "running")
        let tasksPending = count("tasks", "pending")
        let tasksInProgress = count("tasks", "inProgress")
        return Activity(
            subagents: subagentsRunning + subagentsQueued > 0 ? "\(subagentsRunning) running · \(subagentsQueued) queued" : nil,
            workflows: workflows > 0 ? "\(workflows) running" : nil,
            processes: processes > 0 ? "\(processes) running" : nil,
            tasks: tasksPending + tasksInProgress > 0 ? "\(tasksInProgress) in progress · \(tasksPending) pending" : nil
        )
    }

    public struct Activity: Equatable, Sendable {
        public var subagents: String?
        public var workflows: String?
        public var processes: String?
        public var tasks: String?
    }

    // MARK: Fork and resume (sessionFork.ts, useSessionQuickActions.ts)

    /// sessionFork.ts `getSessionForkSource`.
    public static func forkSource(_ session: SessionRecord) -> ForkSource? {
        let metadata = session.metadata
        guard let machineId = nonBlank(metadata?["machineId"]), let directory = nonBlank(metadata?["path"]) else { return nil }
        if metadata?["flavor"]?.stringValue == "codex" {
            guard let thread = nonBlank(metadata?["codexThreadId"]) else { return nil }
            return .codex(sessionId: session.id, options: CodexForkThreadOptions(machineId: machineId, directory: directory, codexThreadId: thread))
        }
        guard let claude = nonBlank(metadata?["claudeSessionId"]) else { return nil }
        return .claude(sessionId: session.id, options: ClaudeForkSessionOptions(machineId: machineId, directory: directory, claudeSessionId: claude))
    }

    /// Why Resume can or can't run, with the message happy-app shows.
    public enum ResumeAvailability: Equatable, Sendable {
        /// The row is not shown at all.
        case hidden
        case missingMachine
        case missingBackendId
        case sameMachineOnly
        case machineOffline
        case available

        public var canResume: Bool { self == .available }
        public var showsRow: Bool { self != .hidden }
    }

    /// useSessionQuickActions.ts `getResumeAvailability`.
    public static func resumeAvailability(_ session: SessionRecord, machine: MachineRecord?) -> ResumeAvailability {
        let metadata = session.metadata
        if session.isRig || metadata?["capabilities"]?["resume"]?.boolValue == false { return .hidden }
        if SessionState(session) != .disconnected { return .hidden }
        guard truthy(metadata?["machineId"]) != nil else { return .missingMachine }
        guard truthy(metadata?["claudeSessionId"]) != nil || truthy(metadata?["codexThreadId"]) != nil else {
            return .missingBackendId
        }
        guard let machine else { return .sameMachineOnly }
        guard machine.active else { return .machineOffline }
        // Older daemons don't publish resumeSupport and can't run the RPC.
        guard machine.metadata?["resumeSupport"]?["rpcAvailable"] == .bool(true) else { return .hidden }
        return .available
    }

    /// useSessionQuickActions.ts `canFork`: the continuation experiment, not
    /// Happy Agent, a fork source and an online machine.
    public static func canFork(_ session: SessionRecord, machine: MachineRecord?, settings: AccountSettings) -> Bool {
        settings.bool("expResumeSession") && !session.isRig && forkSource(session) != nil && machine?.active == true
    }

    // MARK: Git (sessionGitPresentation.ts, rigGitLineChanges.ts)

    public struct LineChanges: Equatable, Sendable {
        public var insertions: Int
        public var deletions: Int
        /// Drawn with a leading ≈.
        public var approximate: Bool

        public init(insertions: Int, deletions: Int, approximate: Bool) {
            self.insertions = insertions
            self.deletions = deletions
            self.approximate = approximate
        }
    }

    public struct GitPresentation: Equatable, Sendable {
        public var changedFileCount: Int?
        public var changes: LineChanges?

        /// The Changes row draws its own right element when either is known.
        public var hasAccessory: Bool { changedFileCount != nil || changes != nil }
    }

    /// sessionGitPresentation.ts `resolveSessionGitPresentation`, without the
    /// subtitle the info screen doesn't use. Happy Agent's published
    /// comparison wins over the working-tree status.
    public static func gitPresentation(_ metadata: JSONValue?, status: GitStatus?) -> GitPresentation {
        if metadata?["client"]?["id"]?.stringValue == "rig", let git = metadata?["git"], git != .null {
            let insertions = Int(git["insertions"]?.numberValue ?? 0)
            let deletions = Int(git["deletions"]?.numberValue ?? 0)
            return GitPresentation(
                changedFileCount: git["changedFiles"]?.numberValue.map { Int($0) },
                changes: insertions == 0 && deletions == 0
                    ? nil
                    : LineChanges(insertions: insertions, deletions: deletions, approximate: git["countsExact"]?.boolValue != true)
            )
        }
        guard let status else { return GitPresentation(changedFileCount: nil, changes: nil) }
        // The files and the live status are one fetch here, so both of
        // happy-app's sources agree.
        let paths = Set((status.stagedFiles + status.unstagedFiles).map(\.fullPath))
        let insertions = status.linesAdded
        let deletions = status.linesRemoved
        return GitPresentation(
            changedFileCount: paths.count,
            changes: insertions > 0 || deletions > 0 ? LineChanges(insertions: insertions, deletions: deletions, approximate: false) : nil
        )
    }

    /// rigGitLineChanges.ts `compactCount`: 999, 1.2k, 12k.
    public static func compactCount(_ value: Int) -> String {
        let count = max(0, value)
        if count < 1_000 { return String(count) }
        if count < 5_000 {
            let thousands = (Double(count) / 100).rounded(.toNearestOrAwayFromZero) / 10
            return jsNumber(thousands) + "k"
        }
        return String(Int((Double(count) / 1_000).rounded(.toNearestOrAwayFromZero))) + "k"
    }

    // MARK: Worktrees (worktreePaths.ts)

    /// Happy creates worktrees under this marker.
    public static let worktreeMarker = "/.dev/worktree/"

    public static func isWorktreePath(_ path: String?) -> Bool {
        path?.contains(worktreeMarker) == true
    }

    /// worktree.ts `removeWorktree`'s command and working directory.
    public static func removeWorktreeCommand(_ path: String) -> (command: String, cwd: String)? {
        guard let marker = path.range(of: worktreeMarker) else { return nil }
        return ("git worktree remove \(path) --force", String(path[..<marker.lowerBound]))
    }

    // MARK: Values

    /// A string that JavaScript treats as truthy (present and not empty).
    static func truthy(_ value: JSONValue?) -> String? {
        guard let string = value?.stringValue, !string.isEmpty else { return nil }
        return string
    }

    /// sessionFork.ts `nonEmpty`: a string with something besides spaces.
    static func nonBlank(_ value: JSONValue?) -> String? {
        guard let string = value?.stringValue, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return string
    }

    /// A number the way JavaScript's String(n) writes it, for the values
    /// these screens show (counts, versions, ports): no trailing `.0`.
    public static func jsNumber(_ value: Double) -> String {
        guard value.isFinite else { return value.isNaN ? "NaN" : (value > 0 ? "Infinity" : "-Infinity") }
        if value == value.rounded(), abs(value) < 1e21 {
            return String(Int64(value))
        }
        return String(value)
    }
}

/// sync/rig.ts `getRigIdentity`: what a Happy Agent session runs.
public struct RigIdentity: Equatable, Sendable {
    public var clientName: String
    public var clientVersion: String?
    public var providerName: String
    /// The glyph ProviderIcon.tsx draws for it.
    public var providerKind: ProviderIconKind
    public var modelName: String?

    public init?(_ metadata: JSONValue?) {
        guard let metadata, metadata["client"]?["id"]?.stringValue == "rig" else { return nil }
        func nonEmpty(_ value: JSONValue?) -> String? { SessionDetails.nonBlank(value) }
        let current = Self.currentModel(metadata)
        clientName = nonEmpty(metadata["client"]?["name"]) ?? "Rig"
        clientVersion = nonEmpty(metadata["client"]?["version"])
        providerName = nonEmpty(metadata["provider"]?["name"])
            ?? current?.providerName
            ?? nonEmpty(metadata["flavor"])
            ?? "Provider"
        // `metadata.provider.kind ?? currentModel.providerKind`: only a
        // missing kind falls through, not an empty one.
        providerKind = ProviderIconKind(metadata["provider"]?["kind"]?.stringValue ?? current?.providerKind)
        modelName = current?.name ?? nonEmpty(metadata["currentModelCode"])
    }

    /// rig.ts `getRigCurrentModel`, reduced to what is shown: the two
    /// names and the provider's kind.
    static func currentModel(_ metadata: JSONValue) -> (name: String, providerName: String?, providerKind: String?)? {
        func nonEmpty(_ value: JSONValue?) -> String? { SessionDetails.nonBlank(value) }
        let isV1 = SessionMetadata.isRigV1(metadata)
        let mode: JSONValue? = isV1 ? [metadata["draft"], metadata["lastMode"]].compactMap { $0 }.first { $0 != .null } : nil
        guard let providerId = nonEmpty(mode?["providerId"]) ?? nonEmpty(metadata["currentModelProviderId"]) ?? nonEmpty(metadata["model"]?["providerId"]),
              let id = nonEmpty(mode?["modelId"]) ?? nonEmpty(metadata["currentModelCode"]) ?? nonEmpty(metadata["model"]?["id"])
        else { return nil }
        for model in metadata["models"]?.arrayValue ?? [] {
            guard let modelProvider = nonEmpty(model["provider"]?["id"]) ?? nonEmpty(model["providerId"]),
                  let modelId = nonEmpty(model["id"]) ?? nonEmpty(model["code"]),
                  modelProvider == providerId, modelId == id
            else { continue }
            return (
                nonEmpty(model["name"]) ?? nonEmpty(model["value"]) ?? modelId,
                nonEmpty(model["provider"]?["name"]) ?? nonEmpty(model["providerName"]) ?? modelProvider,
                nonEmpty(model["provider"]?["kind"]) ?? nonEmpty(model["providerKind"]) ?? "custom"
            )
        }
        let providerName: String?
        let providerKind: String?
        if metadata["provider"]?["id"]?.stringValue == providerId {
            providerName = nonEmpty(metadata["provider"]?["name"])
            providerKind = metadata["provider"]?["kind"]?.stringValue
        } else {
            let provider = metadata["providers"]?.arrayValue?.first { $0["id"]?.stringValue == providerId }
            providerName = provider?["name"]?.stringValue ?? providerId
            providerKind = provider?["kind"]?.stringValue ?? "custom"
        }
        return (id, providerName, providerKind)
    }
}

/// rig.ts `getProviderIconKind`: which glyph ProviderIcon.tsx draws.
public enum ProviderIconKind: Equatable, Sendable {
    /// The GPT mark, tinted the secondary text colour.
    case codex
    /// The Claude mark, in its own colours.
    case claude
    /// Ionicons flash-outline.
    case grok
    /// Ionicons moon-outline.
    case kimi
    /// Ionicons sparkles-outline.
    case generic

    public init(_ kind: String?) {
        switch kind?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "codex": self = .codex
        case "claude": self = .claude
        case "grok": self = .grok
        case "kimi": self = .kimi
        default: self = .generic
        }
    }
}
