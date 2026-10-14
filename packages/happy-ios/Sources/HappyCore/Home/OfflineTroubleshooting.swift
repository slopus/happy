import Foundation
import HappyStore

/// The copyable AI prompt on the troubleshoot screen, from happy-app's
/// utils/offlineMachineTroubleshooting.ts. The newest session on a known
/// computer picks the computer and project, so the prompt points a coding
/// agent at that computer's Happy logs.
public struct OfflineTroubleshooting: Equatable, Sendable {
    public var machineName: String
    public var projectName: String
    public var happyHomeDir: String
    public var aiPrompt: String

    public init(choices: [MachineChoice], sessions: [SessionRecord]) {
        var choice = choices.max { $0.activeAt < $1.activeAt }
        var session: SessionRecord?
        // Newest first; a stable sort keeps the store's order on ties.
        let newest = sessions.enumerated().sorted {
            $0.element.updatedAt != $1.element.updatedAt ? $0.element.updatedAt > $1.element.updatedAt : $0.offset < $1.offset
        }.map(\.element)
        for candidate in newest {
            let machineId = candidate.metadata?["machineId"]?.stringValue ?? ""
            guard let owner = choices.first(where: { $0.machineIds.contains(machineId) }) else { continue }
            choice = owner
            session = candidate
            break
        }

        self.init(choice: choice, projectName: session?.metadata?["project"]?["name"]?.stringValue,
                  path: session?.metadata?["path"]?.stringValue, happyHomeDir: session?.metadata?["happyHomeDir"]?.stringValue)
    }

    public init(choices: [MachineChoice], recentSession: TroubleshootingSession?) {
        let choice = recentSession.flatMap { recent in choices.first { $0.machineIds.contains(recent.machineId) } }
            ?? choices.max { $0.activeAt < $1.activeAt }
        self.init(choice: choice, projectName: recentSession?.projectName, path: recentSession?.path, happyHomeDir: recentSession?.happyHomeDir)
    }

    private init(choice: MachineChoice?, projectName: String?, path: String?, happyHomeDir: String?) {
        machineName = Self.trimmed(choice?.name) ?? "this machine"
        self.projectName = Self.trimmed(projectName)
            ?? Self.projectName(fromPath: path)
            ?? "Happy"
        self.happyHomeDir = Self.trimmed(choice?.happyMachine?.metadata?["happyHomeDir"]?.stringValue)
            ?? Self.trimmed(choice?.rigMachine?.metadata?["happyHomeDir"]?.stringValue)
            ?? Self.trimmed(happyHomeDir)
            ?? "~/.happy"
        aiPrompt = "In \(self.happyHomeDir), diagnose why Happy cannot reach \"\(machineName)\" for project \"\(self.projectName)\"."
    }

    /// The last path component, ignoring trailing separators.
    static func projectName(fromPath path: String?) -> String? {
        guard var normalized = trimmed(path) else { return nil }
        while let last = normalized.last, last == "/" || last == "\\" {
            normalized.removeLast()
        }
        let name = normalized.split(omittingEmptySubsequences: false) { $0 == "/" || $0 == "\\" }.last.map(String.init)
        return name?.isEmpty == false ? name : nil
    }

    private static func trimmed(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
}
