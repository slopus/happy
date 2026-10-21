import Foundation
import HappyWire

// PermissionFooter.tsx without the views: which buttons a permission
// request offers, which one was used once it is answered, and what each
// one sends.

public struct PermissionButton: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// common.yes
        case allow
        /// claude.permissions.yesAllowAllEdits
        case allowAllEdits
        /// claude.permissions.yesAllowEverything
        case allowEverything
        /// claude.permissions.yesForTool
        case allowForTool
        /// claude.permissions.noTellClaude
        case deny
        /// common.yes, for Codex
        case codexAllow
        /// codex.permissions.yesForSession
        case codexAllowForSession
        /// codex.permissions.stopAndExplain
        case codexAbort
    }

    public var kind: Kind
    /// The button that answered the request.
    public var selected: Bool
    /// Another button answered it.
    public var inactive: Bool
    /// "Yes" keeps to one line; the longer labels wrap to two.
    public var maxLines: Int
}

/// What a button sends: `sessionAllow` or `sessionDeny`, then the
/// session's permission mode, when the choice changes it.
public struct PermissionReply: Equatable, Sendable {
    public var allow: Bool
    public var mode: String?
    public var allowedTools: [String]?
    public var decision: ToolPermission.Decision?
    /// `sessionSetAgentModes({ permissionMode })` after the reply.
    public var permissionMode: String?

    public init(allow: Bool, mode: String? = nil, allowedTools: [String]? = nil, decision: ToolPermission.Decision? = nil, permissionMode: String? = nil) {
        self.allow = allow
        self.mode = mode
        self.allowedTools = allowedTools
        self.decision = decision
        self.permissionMode = permissionMode
    }
}

public enum ChatPermissionButtons {
    static let editNames: Set<String> = ["Edit", "MultiEdit", "Write", "NotebookEdit", "exit_plan_mode", "ExitPlanMode"]
    static let planNames: Set<String> = ["exit_plan_mode", "ExitPlanMode"]

    /// A Codex session, or a Codex tool in any session.
    public static func isCodex(toolName: String, flavor: String?) -> Bool {
        flavor == "codex" || toolName.hasPrefix("Codex")
    }

    public static func buttons(_ permission: ToolPermission, toolName: String, toolInput: JSONValue, flavor: String?) -> [PermissionButton] {
        let approved = permission.status == .approved
        let denied = permission.status == .denied

        if isCodex(toolName: toolName, flavor: flavor) {
            let allowed = approved && (permission.decision == .approved || permission.decision == nil)
            let forSession = approved && permission.decision == .approvedForSession
            let aborted = denied && permission.decision == .abort
            return [
                PermissionButton(kind: .codexAllow, selected: allowed, inactive: aborted || forSession, maxLines: 1),
                PermissionButton(kind: .codexAllowForSession, selected: forSession, inactive: aborted || allowed, maxLines: 2),
                PermissionButton(kind: .codexAbort, selected: aborted, inactive: allowed || forSession, maxLines: 2),
            ]
        }

        let forTool = approved && isToolAllowed(toolName, input: toolInput, allowedTools: permission.allowedTools)
        let allEdits = approved && permission.mode == "acceptEdits"
        let everything = approved && permission.mode == "bypassPermissions"
        let plain = approved && !allEdits && !everything && !forTool
        var buttons = [PermissionButton(kind: .allow, selected: plain, inactive: denied || allEdits || everything || forTool, maxLines: 1)]
        if editNames.contains(toolName) {
            buttons.append(PermissionButton(kind: .allowAllEdits, selected: allEdits, inactive: denied || plain || everything || forTool, maxLines: 2))
        }
        if planNames.contains(toolName) {
            buttons.append(PermissionButton(kind: .allowEverything, selected: everything, inactive: denied || plain || allEdits || forTool, maxLines: 2))
        }
        if !toolName.isEmpty && !editNames.contains(toolName) {
            buttons.append(PermissionButton(kind: .allowForTool, selected: forTool, inactive: denied || plain || allEdits || everything, maxLines: 2))
        }
        buttons.append(PermissionButton(kind: .deny, selected: denied, inactive: approved, maxLines: 2))
        return buttons
    }

    public static func reply(_ kind: PermissionButton.Kind, toolName: String, toolInput: JSONValue) -> PermissionReply {
        switch kind {
        case .allow:
            return PermissionReply(allow: true, permissionMode: planNames.contains(toolName) ? "default" : nil)
        case .allowAllEdits:
            return PermissionReply(allow: true, mode: "acceptEdits", permissionMode: "acceptEdits")
        case .allowEverything:
            return PermissionReply(allow: true, mode: "bypassPermissions", permissionMode: "bypassPermissions")
        case .allowForTool:
            var identifier = toolName
            if toolName == "Bash", let command = commandText(toolInput) { identifier = "Bash(\(command))" }
            return PermissionReply(allow: true, allowedTools: [identifier])
        case .deny:
            return PermissionReply(allow: false)
        case .codexAllow:
            return PermissionReply(allow: true, decision: .approved)
        case .codexAllowForSession:
            return PermissionReply(allow: true, decision: .approvedForSession)
        case .codexAbort:
            return PermissionReply(allow: false, decision: .abort)
        }
    }

    static func isToolAllowed(_ toolName: String, input: JSONValue, allowedTools: [String]?) -> Bool {
        guard let allowedTools else { return false }
        if allowedTools.contains(toolName) { return true }
        if toolName == "Bash", let command = commandText(input) { return allowedTools.contains("Bash(\(command))") }
        return false
    }

    /// `toolInput.command` as a template string renders it.
    static func commandText(_ input: JSONValue) -> String? {
        switch input["command"] {
        case .string(let command)?: command.isEmpty ? nil : command
        case .array(let parts)?: parts.compactMap(\.stringValue).joined(separator: ",")
        case .number(let number)?: ChatToolDisplay.formatNumber(number)
        default: nil
        }
    }
}
