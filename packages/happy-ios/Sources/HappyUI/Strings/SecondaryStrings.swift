import Foundation

// Copy for session info, the machine screen, the file viewer and changes,
// verbatim from packages/happy-app/sources/text/translations/en.ts. Strings
// those screens hard-code in English are marked as such.

extension Strings {
    /// sessionInfo.* and the session.* keys info.tsx reads.
    public enum SessionDetail {
        public static var quickActions: String { localized("sessionInfo.quickActions", "Quick Actions") }
        public static var viewMachine: String { localized("sessionInfo.viewMachine", "View Machine") }
        public static var viewMachineSubtitle: String { localized("sessionInfo.viewMachineSubtitle", "View machine details and sessions") }
        public static var resumeSession: String { localized("sessionInfo.resumeSession", "Resume Session") }
        public static var resumeSessionSubtitle: String { localized("sessionInfo.resumeSessionSubtitle", "Resume this session on the same machine") }
        public static var resumeSessionSameMachineOnly: String { localized("sessionInfo.resumeSessionSameMachineOnly", "This session can only be resumed on the same machine it started on.") }
        public static var resumeSessionMachineOffline: String { localized("sessionInfo.resumeSessionMachineOffline", "This machine is offline. Resume is only available while it is online.") }
        public static var resumeSessionMissingMachine: String { localized("sessionInfo.resumeSessionMissingMachine", "This session is missing its machine metadata, so it cannot be resumed.") }
        public static var resumeSessionMissingBackendId: String { localized("sessionInfo.resumeSessionMissingBackendId", "This session does not have a resumable Claude or Codex identifier.") }
        public static var resumeSessionUnexpectedDirectoryPrompt: String { localized("sessionInfo.resumeSessionUnexpectedDirectoryPrompt", "Resume cannot create directories. Start the session manually from its original path.") }
        public static var forkAction: String { localized("session.forkAction", "Fork session") }
        public static var forkSubtitle: String { localized("session.forkSubtitle", "Continue in a new session with the same context") }
        public static var duplicateAction: String { localized("session.duplicateAction", "Duplicate from message…") }
        public static var duplicateSubtitle: String { localized("session.duplicateSubtitle", "Rewind to a chosen point and try again") }
        public static var forkedFromLabel: String { localized("session.forkedFromLabel", "Forked from") }
        public static var forkedFromSubtitle: String { localized("session.forkedFromSubtitle", "Open the session this fork was branched from") }
        public static var forkErrorMissingMetadata: String { localized("session.forkErrorMissingMetadata", "Missing session metadata required to fork.") }
        public static var forkErrorGeneric: String { localized("session.forkErrorGeneric", "Failed to fork the session.") }
        public static var archiveSession: String { localized("sessionInfo.archiveSession", "Archive Session") }
        public static var archiveSessionSubtitle: String { localized("sessionInfo.archiveSessionSubtitle", "Archive this session and stop it") }
        public static var deleteSession: String { localized("sessionInfo.deleteSession", "Delete Session") }
        public static var deleteSessionSubtitle: String { localized("sessionInfo.deleteSessionSubtitle", "Permanently remove this session") }
        public static var deleteSessionWarning: String { localized("sessionInfo.deleteSessionWarning", "This action cannot be undone. All messages and data associated with this session will be permanently deleted.") }
        public static var cliVersionOutdated: String { localized("sessionInfo.cliVersionOutdated", "CLI Update Required") }
        public static var updateCliInstructions: String { localized("sessionInfo.updateCliInstructions", "Please run npm install -g happy@latest") }
        public static var happySessionId: String { localized("sessionInfo.happySessionId", "Happy Session ID") }
        public static var happySessionIdCopied: String { localized("sessionInfo.happySessionIdCopied", "Happy Session ID copied to clipboard") }
        public static var failedToCopySessionId: String { localized("sessionInfo.failedToCopySessionId", "Failed to copy Happy Session ID") }
        public static var claudeCodeSessionId: String { localized("sessionInfo.claudeCodeSessionId", "Claude Code Session ID") }
        public static var claudeCodeSessionIdCopied: String { localized("sessionInfo.claudeCodeSessionIdCopied", "Claude Code Session ID copied to clipboard") }
        public static var failedToCopyClaudeCodeSessionId: String { localized("sessionInfo.failedToCopyClaudeCodeSessionId", "Failed to copy Claude Code Session ID") }
        public static var codexThreadId: String { localized("sessionInfo.codexThreadId", "Codex Thread ID") }
        public static var codexThreadIdCopied: String { localized("sessionInfo.codexThreadIdCopied", "Codex Thread ID copied to clipboard") }
        public static var failedToCopyCodexThreadId: String { localized("sessionInfo.failedToCopyCodexThreadId", "Failed to copy Codex Thread ID") }
        public static var connectionStatus: String { localized("sessionInfo.connectionStatus", "Connection Status") }
        public static var created: String { localized("sessionInfo.created", "Created") }
        public static var lastUpdated: String { localized("sessionInfo.lastUpdated", "Last Updated") }
        public static var sequence: String { localized("sessionInfo.sequence", "Sequence") }
        public static var metadata: String { localized("sessionInfo.metadata", "Metadata") }
        public static var host: String { localized("sessionInfo.host", "Host") }
        public static var path: String { localized("sessionInfo.path", "Path") }
        public static var cliVersion: String { localized("sessionInfo.cliVersion", "CLI Version") }
        public static var operatingSystem: String { localized("sessionInfo.operatingSystem", "Operating System") }
        public static var aiProvider: String { localized("sessionInfo.aiProvider", "AI Provider") }
        public static var processId: String { localized("sessionInfo.processId", "Process ID") }
        public static var happyHome: String { localized("sessionInfo.happyHome", "Happy Home") }
        public static var copyMetadata: String { localized("sessionInfo.copyMetadata", "Copy session metadata") }
        public static var metadataCopied: String { localized("sessionInfo.metadataCopied", "Session metadata copied to clipboard") }
        public static var failedToCopyMetadata: String { localized("sessionInfo.failedToCopyMetadata", "Failed to copy session metadata") }
        public static var agentState: String { localized("sessionInfo.agentState", "Agent State") }
        public static var controlledByUser: String { localized("sessionInfo.controlledByUser", "Controlled by User") }
        public static var pendingRequests: String { localized("sessionInfo.pendingRequests", "Pending Requests") }
        public static var activity: String { localized("sessionInfo.activity", "Activity") }
        public static var thinking: String { localized("sessionInfo.thinking", "Thinking") }
        public static var thinkingSince: String { localized("sessionInfo.thinkingSince", "Thinking Since") }
        public static var worktreeCleanupTitle: String { localized("sessionInfo.worktreeCleanupTitle", "Delete Worktree?") }
        public static var worktreeCleanupMessage: String { localized("sessionInfo.worktreeCleanupMessage", "The worktree has no uncommitted changes. Would you like to delete the worktree files?") }
        public static var worktreeCleanupDelete: String { localized("sessionInfo.worktreeCleanupDelete", "Delete Worktree") }
        public static var worktreeCleanupKeep: String { localized("sessionInfo.worktreeCleanupKeep", "Keep Files") }
        /// errors.sessionDeleted / sessionDeletedDescription.
        public static var sessionDeleted: String { localized("errors.sessionDeleted", "Session has been deleted") }
        public static var sessionDeletedDescription: String { localized("errors.sessionDeletedDescription", "This session has been permanently removed") }
        public static var loading: String { localized("common.loading", "Loading...") }
        public static var yes: String { localized("common.yes", "Yes") }
        public static var no: String { localized("common.no", "No") }

        // Hard-coded in info.tsx.
        public static let resumeCommand = "Resume Command"
        public static let client = "Client"
        public static let model = "Model"
        public static let sandbox = "Sandbox"
        public static let dangerouslySkipPermissions = "Dangerously Skip Permissions"
        /// info.tsx 488: `t('sessionInfo.copyMetadata') + '\n& Client Logs'`.
        public static var copyMetadataAndLogs: String { copyMetadata + "\n& Client Logs" }
        public static let subagents = "Subagents"
        public static let workflows = "Workflows"
        public static let backgroundProcesses = "Background processes"
        public static let tasks = "Tasks"
        public static let updateCommand = "npm install -g happy@latest"
        public static let rawJSON = "Raw JSON (Dev Mode)"
        public static let rawAgentState = "Agent State"
        public static let rawMetadata = "Metadata"
        public static let rawSession = "Full Session Object"

        // useHappyAction's alert.
        public static let actionError = "Error"
        public static let unknownError = "Unknown error"

        // DuplicateSheet.tsx.
        public static var duplicateSheetTitle: String { localized("session.duplicateSheetTitle", "Choose a rewind point") }
        public static var duplicateSheetSubtitle: String { localized("session.duplicateSheetSubtitle", "The new session keeps the chosen turn complete (your message and the agent’s response) and drops every prompt after it.") }
        public static var duplicateSheetConfirm: String { localized("session.duplicateSheetConfirm", "Duplicate") }
        public static var duplicateSheetEmpty: String { localized("session.duplicateSheetEmpty", "No messages eligible for rewind in this session yet.") }
        public static var duplicateRowDisabled: String { localized("session.duplicateRowDisabled", "This message can't be used as a rewind point.") }
        /// time.*, the rewind points' ages.
        public static var justNow: String { localized("time.justNow", "just now") }
        public static func minutesAgo(_ count: Int) -> String { localized("time.minutesAgo", ["count": .number(count)], "\(count) minute\(count != 1 ? "s" : "") ago") }
        public static func hoursAgo(_ count: Int) -> String { localized("time.hoursAgo", ["count": .number(count)], "\(count) hour\(count != 1 ? "s" : "") ago") }
        public static func daysAgo(_ count: Int) -> String { localized("time.daysAgo", ["count": .number(count)], "\(count) day\(count != 1 ? "s" : "") ago") }
    }

    /// machine.* and the copy machine/[id].tsx hard-codes.
    public enum MachineDetail {
        public static var status: String { localized("machine.status", "Status") }
        public static var stopDaemon: String { localized("machine.stopDaemon", "Stop Daemon") }
        public static var lastKnownPid: String { localized("machine.lastKnownPid", "Last Known PID") }
        public static var lastKnownHttpPort: String { localized("machine.lastKnownHttpPort", "Last Known HTTP Port") }
        public static var startedAt: String { localized("machine.startedAt", "Started At") }
        public static var cliVersion: String { localized("machine.cliVersion", "CLI Version") }
        public static var daemonStateVersion: String { localized("machine.daemonStateVersion", "Daemon State Version") }
        public static var cliAvailability: String { localized("machine.cliAvailability", "CLI Availability") }
        public static var cliInstalled: String { localized("machine.cliInstalled", "Installed") }
        public static var cliNotFound: String { localized("machine.cliNotFound", "Not found") }
        public static var lastDetected: String { localized("machine.lastDetected", "Last Detected") }
        public static var sessions: String { localized("tabs.sessions", "Sessions") }
        public static var machineGroup: String { localized("machine.machineGroup", "Machine") }
        public static var host: String { localized("machine.host", "Host") }
        public static var machineId: String { localized("machine.machineId", "Machine ID") }
        public static var username: String { localized("machine.username", "Username") }
        public static var homeDirectory: String { localized("machine.homeDirectory", "Home Directory") }
        public static var platform: String { localized("machine.platform", "Platform") }
        public static var architecture: String { localized("machine.architecture", "Architecture") }
        public static var lastSeen: String { localized("machine.lastSeen", "Last Seen") }
        public static var never: String { localized("machine.never", "Never") }
        public static var metadataVersion: String { localized("machine.metadataVersion", "Metadata Version") }
        public static var back: String { localized("machine.back", "Back") }
        public static var dangerZone: String { localized("machine.dangerZone", "Danger Zone") }
        public static var delete: String { localized("machine.delete", "Delete Machine") }
        public static var deleteFooter: String { localized("machine.deleteFooter", "Remove this machine from your account. Session history will be preserved, but you will not be able to start new sessions on this machine.") }
        public static var deleteConfirmTitle: String { localized("machine.deleteConfirmTitle", "Delete this machine?") }
        public static var deleteConfirmMessage: String { localized("machine.deleteConfirmMessage", "The machine will be removed from your account. Session history will be preserved, but you will not be able to start new sessions until you reconnect the daemon.") }
        public static var deleteFailed: String { localized("machine.deleteFailed", "Failed to delete machine.") }
        /// status.unknown, getSessionSubtitle's fallback.
        public static var unknown: String { localized("status.unknown", "unknown") }
        public static var rename: String { localized("common.rename", "Rename") }

        // Hard-coded in machine/[id].tsx.
        public static let notFound = "Machine not found"
        public static let stopDaemonTitle = "Stop Daemon?"
        public static let stopDaemonMessage = "You will not be able to spawn new sessions on this machine until you restart the daemon on your computer again. Your current sessions will stay alive."
        /// The stop alert's buttons (machine/[id].tsx 56, 60), written there
        /// in English, unlike the row's `machine.stopDaemon` and
        /// `common.cancel` elsewhere.
        public static let stopDaemonCancel = "Cancel"
        public static let stopDaemonConfirm = "Stop Daemon"
        /// A failed rename's alert title (machine/[id].tsx 144), in English
        /// there, where the screen's other failures say `common.error`.
        public static let renameErrorTitle = "Error"
        public static let daemonStopped = "Daemon Stopped"
        public static let stopDaemonFailed = "Failed to stop daemon. It may not be running."
        public static let renameTitle = "Rename Machine"
        public static let renameMessage = "Give this machine a custom name. Leave empty to use the default hostname."
        public static let renamePlaceholder = "Enter machine name"
        public static let renamed = "Machine renamed successfully"
        public static let renameFailed = "Failed to rename machine"
    }

    /// files.* and diff.*.
    public enum FilesDetail {
        public static var changes: String { localized("files.changes", "Changes") }
        public static func changedFiles(_ count: Int) -> String { localized("files.changedFiles", ["count": .number(count)], "\(count) changed \(count == 1 ? "file" : "files")") }
        public static func loadingFile(_ fileName: String) -> String { localized("files.loadingFile", ["fileName": .text(fileName)], "Loading \(fileName)...") }
        public static var binaryFile: String { localized("files.binaryFile", "Binary File") }
        public static var cannotDisplayBinary: String { localized("files.cannotDisplayBinary", "Cannot display binary file content") }
        public static var diff: String { localized("files.diff", "Diff") }
        public static var file: String { localized("files.file", "File") }
        public static var fileEmpty: String { localized("files.fileEmpty", "File is empty") }
        public static var noChanges: String { localized("files.noChanges", "No changes to display") }
        public static var retry: String { localized("common.retry", "Retry") }

        // Hard-coded in file.tsx.
        public static let failedToRead = "Failed to read file"
        public static let failedToLoad = "Failed to load file"
    }

    /// common.fileViewer: file.tsx's title. Its back title, common.files,
    /// never shows: iOS draws the back button minimal.
    public enum FileViewerDetail {
        public static var title: String { localized("common.fileViewer", "File Viewer") }
    }

    /// changes.tsx's title (sessionInfo.viewChanges) and the copy
    /// HappyAgentDiffView.tsx and useHappyAgentGitFiles.ts hard-code.
    public enum ChangesDetail {
        public static var title: String { localized("sessionInfo.viewChanges", "View changes") }

        // Hard-coded in HappyAgentDiffView.tsx.
        public static let updateHappyAgent = "Update Happy Agent on your computer to view changes in this session."
        public static let comparisonUnavailable = "A comparison with origin/main is not available for this workspace."
        public static let noFileDetails = "No file details are available for this comparison."
        public static let contentsMatch = "File contents match the comparison base."
        public static let loadFailed = "Could not load changes from Happy Agent."
        // Hard-coded in useHappyAgentGitFiles.ts.
        public static let fileLoadFailed = "Could not load this file. Reload changes to try again."
    }

    public enum DiffDetail {
        /// `diff.showMoreLines` (DiffFileView.tsx 185), read on the main
        /// thread only (DiffFileView.apply).
        public static func showMoreLines(_ count: Int) -> String { localized("diff.showMoreLines", ["count": .number(count)], "Show \(count) more lines") }
        // Read on the main thread only: the changes list's section plans,
        // made off it, take theirs in their input (`DiffSectionWords`,
        // `sizeHint`); a diff's rows read theirs when they are configured.
        public static func tapToExpand(_ count: Int) -> String { localized("diff.tapToExpand", ["count": .number(count)], "\(count) changed lines — tap to expand") }
        public static var imageBefore: String { localized("diff.imageBefore", "Before") }
        public static var imageAfter: String { localized("diff.imageAfter", "After") }
        public static func unchangedLines(_ count: Int) -> String { localized("diff.unchangedLines", ["count": .number(count)], "\(count) unchanged") }
        public static var noChanges: String { localized("diff.noChanges", "No changes") }
        public static var binaryFile: String { localized("diff.binaryFile", "Binary file not shown") }

        // Hard-coded in DiffFileHeader.tsx (drawn uppercase).
        public static let badgeNew = "new"
        public static let badgeDeleted = "deleted"
        public static let badgeRenamed = "renamed"
    }
}
