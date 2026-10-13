import Foundation
import HappyCore

// Copied verbatim from packages/happy-app/sources/text/translations/en.ts.
extension Strings {
    public enum Home {
        /// `tabs.sessions`: the phone header's title.
        public static let sessionsTitle = "Sessions"

        /// `status.*`, the socket states HomeHeaderTitle.tsx names.
        public static func connectionStatus(_ status: RealtimeStatus) -> String {
            switch status {
            case .connected: "connected"
            case .connecting: "connecting"
            case .disconnected: "disconnected"
            case .error: "error"
            }
        }

        /// `sessionsFilter.title`: the filter menu's accessibility label.
        public static let filterTitle = "Filter"
        /// `sessionsFilter.appearanceSettings`.
        public static let appearanceSettings = "Appearance Settings"

        // The project list (ProjectHomeList.tsx).
        /// `sidebar.bots`.
        public static let bots = "Bots"
        /// `sidebar.projects`.
        public static let projects = "Projects"
        /// `sidebar.showAllWorkspaces`.
        public static func showAllWorkspaces(_ count: Int) -> String { "Show all \(count) workspaces" }
        /// `sidebar.showFewerWorkspaces`.
        public static let showFewerWorkspaces = "Show fewer"
        /// `status.unknown`, in `<unknown>` for a chat with no computer.
        public static let unknownMachine = "<unknown>"
        // Hard-coded in ProjectHomeList.tsx, not in en.ts.
        public static let createWorkspace = "Create workspace"
        public static func createWorkspaceIn(_ project: String) -> String { "Create workspace in \(project)" }

        // The "Session" alert (useSessionQuickActions.ts).
        /// `profile.details`.
        public static let details = "Details"
        /// `sessionInfo.resumeSession`.
        public static let resumeSession = "Resume Session"
        /// `session.forkAction`.
        public static let forkAction = "Fork session"
        /// `session.duplicateAction`.
        public static let duplicateAction = "Duplicate from message…"
        /// `sessionInfo.copyMetadata`.
        public static let copyMetadata = "Copy session metadata"
        /// `sessionInfo.copyMetadata` + ' & Client Logs'.
        public static let copyMetadataAndLogs = "Copy session metadata & Client Logs"
        /// `sessionInfo.metadataCopied`.
        public static let metadataCopied = "Session metadata copied to clipboard"
        /// `sessionInfo.failedToCopyMetadata`.
        public static let failedToCopyMetadata = "Failed to copy session metadata"
        public static let resumeSessionSameMachineOnly = "This session can only be resumed on the same machine it started on."
        public static let resumeSessionMachineOffline = "This machine is offline. Resume is only available while it is online."
        public static let resumeSessionMissingMachine = "This session is missing its machine metadata, so it cannot be resumed."
        public static let resumeSessionMissingBackendId = "This session does not have a resumable Claude or Codex identifier."
        public static let resumeSessionUnexpectedDirectoryPrompt = "Resume cannot create directories. Start the session manually from its original path."
        /// `session.forkErrorMissingMetadata`.
        public static let forkErrorMissingMetadata = "Missing session metadata required to fork."
        /// `session.forkErrorGeneric`.
        public static let forkErrorGeneric = "Failed to fork the session."
        // useHappyAction.ts's alert, hard-coded there.
        public static let actionError = "Error"
        public static let actionUnknownError = "Unknown error"

        // The update banner (UpdateBanner.tsx).
        /// `updateBanner.whatsNew`.
        public static let whatsNew = "What's new"
        /// `updateBanner.seeLatest`.
        public static let seeLatest = "See the latest updates and improvements"
    }
}
