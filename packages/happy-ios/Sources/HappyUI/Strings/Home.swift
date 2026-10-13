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
        /// `updateBanner.nativeUpdateAvailable`.
        public static let nativeUpdateAvailable = "App Update Available"
        /// `updateBanner.tapToUpdateAppStore`.
        public static let tapToUpdateAppStore = "Tap to update in App Store"
        /// `updateBanner.whatsNew`.
        public static let whatsNew = "What's new"
        /// `updateBanner.seeLatest`.
        public static let seeLatest = "See the latest updates and improvements"
    
        // The dock (HomeDock.tsx), whose copy is written there in English.
        public static let dockPlaceholder = "Plan, ask, build…"
        public static let selectMachine = "Select machine"
        public static let noProject = "~"
        public static let mainWorkspace = "Main"
        public static let noWorktree = "No worktree"
        public static let harnessHelp = "Help"
        public static let harnessHelpLabel = "Harness setup help"
        public static let harnessHelpURL = URL(string: "https://happy.engineering/docs/quick-start/")!
        public static let machineTitle = "Machine"
        public static let projectTitle = "Project"
        public static let projectsSection = "Projects"
        public static let worktreeTitle = "Worktree"
        public static let workspaceTitle = "Workspace"
        public static let harnessTitle = "Harness"
        /// `machineLauncher.enterCustomPath`.
        public static let enterCustomPath = "Enter custom path"
        public static let customPathPlaceholder = "~/path/to/project"
        public static let interruptHint = "To interrupt press stop"
        public static let addImage = "Add image"
        // useStartSessionFromDraft.ts's directory question.
        public static let createDirectoryTitle = "Create Directory?"
        public static func createDirectoryMessage(_ directory: String) -> String {
            "The directory '\(directory)' does not exist. Would you like to create it?"
        }
        /// `common.create`.
        public static let create = "Create"

        // Making a bot (HomeDock.tsx, BotFacePicker.tsx).
        public static let composerSession = "Session"
        public static let composerBot = "Bot"
        public static let composerKindLabel = "What to create"
        public static let botLede = "Bots are virtual colleagues great for recurring work like releases, competitor analysis, or to own a large feature across several projects and worktrees"
        public static let createBot = "Create bot"
        public static let botFaceHeading = "Avatar"
        public static func botFaceLabel(_ index: Int) -> String { "Face \(index + 1)" }
        public static let rollBotFaces = "Roll four new faces"
        public static let botFaceCreditLead = "Art by "
        // useStartSessionFromDraft.ts `offerBotFaceRetry`.
        public static let botFaceNotSet = "Picture not set"
        public static let botFaceNotNow = "Not now"
        public static let botFaceTryAgain = "Try again"
    }

    /// The new-session screen (app/(app)/new/index.tsx). Its picker copy
    /// is written there in English; the rest is `t()`.
    public enum NewSession {
        /// `newSession.title`.
        public static let title = "Start New Session"
        /// EmptyMainScreen.tsx's button, written there in English.
        public static let startNewSession = "Start New Session"
        /// `newSession.machineOffline`.
        public static let machineOffline = "Machine is offline"
        /// `machine.offlineHelp`.
        public static let offlineHelp = "• Run `happy daemon start` on your computer\n• Make sure your computer is online\n• Run `happy daemon status` to diagnose\n• Are you running the latest CLI version? Upgrade with `npm install -g happy@latest`"
        public static let happyAgentOffline = "Happy Agent is offline on this computer"
        /// `newSession.switchMachinesHint`.
        public static let switchMachinesHint = "• Switch machines by clicking on the machine above"
        public static let searchMachines = "search machines..."
        public static let searchWorktrees = "search worktrees..."
        public static let searchWorkspaces = "search workspaces..."
        public static let searchAgents = "search agents..."
        public static let noResults = "no results"
        public static let pathPlaceholder = "Enter project path"
        public static func usingProject(_ name: String) -> String { "using project \(name)" }
        public static let usingCustomPath = "using custom path above"
        public static let recent = "Recent"
        public static let noRecentProjects = "no recent projects yet"
        /// `settings.title`.
        public static let settings = "Settings"
        public static let voiceInput = "Voice input"
        public static func agent(_ label: String) -> String { "Agent: \(label)" }
    }
}
