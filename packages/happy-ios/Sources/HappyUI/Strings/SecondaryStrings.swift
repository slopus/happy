import Foundation

// Copy for session info, the machine screen, the file viewer and changes,
// verbatim from packages/happy-app/sources/text/translations/en.ts. Strings
// those screens hard-code in English are marked as such.

extension Strings {
    /// sessionInfo.* and the session.* keys info.tsx reads.
    public enum SessionDetail {
        public static let quickActions = "Quick Actions"
        public static let viewMachine = "View Machine"
        public static let viewMachineSubtitle = "View machine details and sessions"
        public static let resumeSession = "Resume Session"
        public static let resumeSessionSubtitle = "Resume this session on the same machine"
        public static let resumeSessionSameMachineOnly = "This session can only be resumed on the same machine it started on."
        public static let resumeSessionMachineOffline = "This machine is offline. Resume is only available while it is online."
        public static let resumeSessionMissingMachine = "This session is missing its machine metadata, so it cannot be resumed."
        public static let resumeSessionMissingBackendId = "This session does not have a resumable Claude or Codex identifier."
        public static let resumeSessionUnexpectedDirectoryPrompt = "Resume cannot create directories. Start the session manually from its original path."
        public static let forkAction = "Fork session"
        public static let forkSubtitle = "Continue in a new session with the same context"
        public static let duplicateAction = "Duplicate from message…"
        public static let duplicateSubtitle = "Rewind to a chosen point and try again"
        public static let forkedFromLabel = "Forked from"
        public static let forkedFromSubtitle = "Open the session this fork was branched from"
        public static let forkErrorMissingMetadata = "Missing session metadata required to fork."
        public static let forkErrorGeneric = "Failed to fork the session."
        public static let archiveSession = "Archive Session"
        public static let archiveSessionSubtitle = "Archive this session and stop it"
        public static let deleteSession = "Delete Session"
        public static let deleteSessionSubtitle = "Permanently remove this session"
        public static let deleteSessionWarning = "This action cannot be undone. All messages and data associated with this session will be permanently deleted."
        public static let cliVersionOutdated = "CLI Update Required"
        public static let updateCliInstructions = "Please run npm install -g happy@latest"
        public static let happySessionId = "Happy Session ID"
        public static let happySessionIdCopied = "Happy Session ID copied to clipboard"
        public static let failedToCopySessionId = "Failed to copy Happy Session ID"
        public static let claudeCodeSessionId = "Claude Code Session ID"
        public static let claudeCodeSessionIdCopied = "Claude Code Session ID copied to clipboard"
        public static let failedToCopyClaudeCodeSessionId = "Failed to copy Claude Code Session ID"
        public static let codexThreadId = "Codex Thread ID"
        public static let codexThreadIdCopied = "Codex Thread ID copied to clipboard"
        public static let failedToCopyCodexThreadId = "Failed to copy Codex Thread ID"
        public static let connectionStatus = "Connection Status"
        public static let created = "Created"
        public static let lastUpdated = "Last Updated"
        public static let sequence = "Sequence"
        public static let metadata = "Metadata"
        public static let host = "Host"
        public static let path = "Path"
        public static let cliVersion = "CLI Version"
        public static let operatingSystem = "Operating System"
        public static let aiProvider = "AI Provider"
        public static let processId = "Process ID"
        public static let happyHome = "Happy Home"
        public static let copyMetadata = "Copy session metadata"
        public static let metadataCopied = "Session metadata copied to clipboard"
        public static let failedToCopyMetadata = "Failed to copy session metadata"
        public static let agentState = "Agent State"
        public static let controlledByUser = "Controlled by User"
        public static let pendingRequests = "Pending Requests"
        public static let activity = "Activity"
        public static let thinking = "Thinking"
        public static let thinkingSince = "Thinking Since"
        public static let worktreeCleanupTitle = "Delete Worktree?"
        public static let worktreeCleanupMessage = "The worktree has no uncommitted changes. Would you like to delete the worktree files?"
        public static let worktreeCleanupDelete = "Delete Worktree"
        public static let worktreeCleanupKeep = "Keep Files"
        /// errors.sessionDeleted / sessionDeletedDescription.
        public static let sessionDeleted = "Session has been deleted"
        public static let sessionDeletedDescription = "This session has been permanently removed"
        public static let loading = "Loading..."
        public static let yes = "Yes"
        public static let no = "No"

        // Hard-coded in info.tsx.
        public static let resumeCommand = "Resume Command"
        public static let client = "Client"
        public static let model = "Model"
        public static let sandbox = "Sandbox"
        public static let dangerouslySkipPermissions = "Dangerously Skip Permissions"
        public static let copyMetadataAndLogs = copyMetadata + "\n& Client Logs"
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
        public static let duplicateSheetTitle = "Choose a rewind point"
        public static let duplicateSheetSubtitle = "The new session keeps the chosen turn complete (your message and the agent’s response) and drops every prompt after it."
        public static let duplicateSheetConfirm = "Duplicate"
        public static let duplicateSheetEmpty = "No messages eligible for rewind in this session yet."
        public static let duplicateRowDisabled = "This message can't be used as a rewind point."
        /// time.*, the rewind points' ages.
        public static let justNow = "just now"
        public static func minutesAgo(_ count: Int) -> String { "\(count) minute\(count != 1 ? "s" : "") ago" }
        public static func hoursAgo(_ count: Int) -> String { "\(count) hour\(count != 1 ? "s" : "") ago" }
        public static func daysAgo(_ count: Int) -> String { "\(count) day\(count != 1 ? "s" : "") ago" }
    }

    /// machine.* and the copy machine/[id].tsx hard-codes.
    public enum MachineDetail {
        public static let status = "Status"
        public static let stopDaemon = "Stop Daemon"
        public static let lastKnownPid = "Last Known PID"
        public static let lastKnownHttpPort = "Last Known HTTP Port"
        public static let startedAt = "Started At"
        public static let cliVersion = "CLI Version"
        public static let daemonStateVersion = "Daemon State Version"
        public static let cliAvailability = "CLI Availability"
        public static let cliInstalled = "Installed"
        public static let cliNotFound = "Not found"
        public static let lastDetected = "Last Detected"
        public static let sessions = "Sessions"
        public static let machineGroup = "Machine"
        public static let host = "Host"
        public static let machineId = "Machine ID"
        public static let username = "Username"
        public static let homeDirectory = "Home Directory"
        public static let platform = "Platform"
        public static let architecture = "Architecture"
        public static let lastSeen = "Last Seen"
        public static let never = "Never"
        public static let metadataVersion = "Metadata Version"
        public static let back = "Back"
        public static let dangerZone = "Danger Zone"
        public static let delete = "Delete Machine"
        public static let deleteFooter = "Removes this machine from your account. Session history is preserved, but you will no longer be able to launch new sessions on it."
        public static let deleteConfirmTitle = "Delete this machine?"
        public static let deleteConfirmMessage = "This removes the machine from your account. Session history is preserved, but you can no longer launch new sessions on it until you reconnect the daemon."
        public static let deleteFailed = "Failed to delete machine."
        /// status.unknown, getSessionSubtitle's fallback.
        public static let unknown = "unknown"
        public static let rename = "Rename"

        // Hard-coded in machine/[id].tsx.
        public static let notFound = "Machine not found"
        public static let stopDaemonTitle = "Stop Daemon?"
        public static let stopDaemonMessage = "You will not be able to spawn new sessions on this machine until you restart the daemon on your computer again. Your current sessions will stay alive."
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
        public static let changes = "Changes"
        public static func changedFiles(_ count: Int) -> String { "\(count) changed \(count == 1 ? "file" : "files")" }
        public static func loadingFile(_ fileName: String) -> String { "Loading \(fileName)..." }
        public static let binaryFile = "Binary File"
        public static let cannotDisplayBinary = "Cannot display binary file content"
        public static let diff = "Diff"
        public static let file = "File"
        public static let fileEmpty = "File is empty"
        public static let noChanges = "No changes to display"
        public static let retry = "Retry"

        // Hard-coded in file.tsx.
        public static let failedToRead = "Failed to read file"
        public static let failedToLoad = "Failed to load file"
    }

    /// common.fileViewer: file.tsx's title. Its back title, common.files,
    /// never shows: iOS draws the back button minimal.
    public enum FileViewerDetail {
        public static let title = "File Viewer"
    }

    /// changes.tsx's title (sessionInfo.viewChanges) and the copy
    /// HappyAgentDiffView.tsx and useHappyAgentGitFiles.ts hard-code.
    public enum ChangesDetail {
        public static let title = "View changes"

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
        public static func showMoreLines(_ count: Int) -> String { "Show \(count) more lines" }
        public static func tapToExpand(_ count: Int) -> String { "\(count) changed lines — tap to expand" }
        public static let imageBefore = "Before"
        public static let imageAfter = "After"
        public static func unchangedLines(_ count: Int) -> String { "\(count) unchanged" }
        public static let noChanges = "No changes"
        public static let binaryFile = "Binary file not shown"

        // Hard-coded in DiffFileHeader.tsx (drawn uppercase).
        public static let badgeNew = "new"
        public static let badgeDeleted = "deleted"
        public static let badgeRenamed = "renamed"
    }
}
