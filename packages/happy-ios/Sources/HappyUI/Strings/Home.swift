import Foundation
import HappyCore

// Copied verbatim from packages/happy-app/sources/text/translations/en.ts.
extension Strings {
    public enum Home {
        /// `tabs.sessions`: the phone header's title.
        public static var sessionsTitle: String { localized("tabs.sessions", "Sessions") }

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
        public static var filterTitle: String { localized("sessionsFilter.title", "Filter") }
        /// `sessionsFilter.appearanceSettings`.
        public static var appearanceSettings: String { localized("sessionsFilter.appearanceSettings", "Appearance Settings") }

        // The project list (ProjectHomeList.tsx).
        /// `sidebar.bots`.
        public static var bots: String { localized("sidebar.bots", "Bots") }
        /// `sidebar.projects`.
        public static var projects: String { localized("sidebar.projects", "Projects") }
        /// `sidebar.showAllWorkspaces`.
        public static func showAllWorkspaces(_ count: Int) -> String { localized("sidebar.showAllWorkspaces", ["count": .number(count)], "Show all \(count) workspaces") }
        /// `sidebar.showFewerWorkspaces`.
        public static var showFewerWorkspaces: String { localized("sidebar.showFewerWorkspaces", "Show fewer") }
        /// `status.unknown`, in `<unknown>` for a chat with no computer.
        public static let unknownMachine = "<unknown>"
        // Hard-coded in ProjectHomeList.tsx, not in en.ts.
        public static let createWorkspace = "Create workspace"
        public static func createWorkspaceIn(_ project: String) -> String { "Create workspace in \(project)" }

        // The "Session" alert (useSessionQuickActions.ts).
        /// `profile.details`.
        public static var details: String { localized("profile.details", "Details") }
        /// `sessionInfo.resumeSession`.
        public static var resumeSession: String { localized("sessionInfo.resumeSession", "Resume Session") }
        /// `session.forkAction`.
        public static var forkAction: String { localized("session.forkAction", "Fork session") }
        /// `session.duplicateAction`.
        public static var duplicateAction: String { localized("session.duplicateAction", "Duplicate from message…") }
        /// `sessionInfo.copyMetadata`.
        public static var copyMetadata: String { localized("sessionInfo.copyMetadata", "Copy session metadata") }
        /// `sessionInfo.copyMetadata` + ' & Client Logs'.
        /// useSessionQuickActions.ts: `t('sessionInfo.copyMetadata') + ' & Client Logs'`.
        public static var copyMetadataAndLogs: String { "\(copyMetadata) & Client Logs" }
        /// `sessionInfo.metadataCopied`.
        public static var metadataCopied: String { localized("sessionInfo.metadataCopied", "Session metadata copied to clipboard") }
        /// `sessionInfo.failedToCopyMetadata`.
        public static var failedToCopyMetadata: String { localized("sessionInfo.failedToCopyMetadata", "Failed to copy session metadata") }
        public static var resumeSessionSameMachineOnly: String { localized("sessionInfo.resumeSessionSameMachineOnly", "This session can only be resumed on the same machine it started on.") }
        public static var resumeSessionMachineOffline: String { localized("sessionInfo.resumeSessionMachineOffline", "This machine is offline. Resume is only available while it is online.") }
        public static var resumeSessionMissingMachine: String { localized("sessionInfo.resumeSessionMissingMachine", "This session is missing its machine metadata, so it cannot be resumed.") }
        public static var resumeSessionMissingBackendId: String { localized("sessionInfo.resumeSessionMissingBackendId", "This session does not have a resumable Claude or Codex identifier.") }
        public static var resumeSessionUnexpectedDirectoryPrompt: String { localized("sessionInfo.resumeSessionUnexpectedDirectoryPrompt", "Resume cannot create directories. Start the session manually from its original path.") }
        /// `session.forkErrorMissingMetadata`.
        public static var forkErrorMissingMetadata: String { localized("session.forkErrorMissingMetadata", "Missing session metadata required to fork.") }
        /// `session.forkErrorGeneric`.
        public static var forkErrorGeneric: String { localized("session.forkErrorGeneric", "Failed to fork the session.") }
        // useHappyAction.ts's alert, hard-coded there.
        public static let actionError = "Error"
        public static let actionUnknownError = "Unknown error"

        // The update banner (UpdateBanner.tsx).
        /// `updateBanner.nativeUpdateAvailable`.
        public static var nativeUpdateAvailable: String { localized("updateBanner.nativeUpdateAvailable", "App Update Available") }
        /// `updateBanner.tapToUpdateAppStore`.
        public static var tapToUpdateAppStore: String { localized("updateBanner.tapToUpdateAppStore", "Tap to update in App Store") }
        /// `updateBanner.whatsNew`.
        public static var whatsNew: String { localized("updateBanner.whatsNew", "What's new") }
        /// `updateBanner.seeLatest`.
        public static var seeLatest: String { localized("updateBanner.seeLatest", "See the latest updates and improvements") }
    
        // The dock (HomeDock.tsx), whose copy is written there in English.
        public static let dockPlaceholder = "Plan, ask, build…"
        public static let selectMachine = "Select machine"
        public static let noProject = "~"
        public static let mainWorkspace = "Main"
        public static let noWorktree = "No worktree"
        public static let harnessHelp = "Help"
        public static let harnessHelpLabel = "Harness setup help"
        public static let harnessHelpURL = URL(string: "https://happy.engineering/docs/quick-start/")!
        // HomeDock.tsx's pickers spell these out in English (its sheet's
        // "Machine" and "Projects"), so they stay English here too.
        public static let machineTitle = "Machine"
        public static let projectTitle = "Project"
        public static let projectsSection = "Projects"
        public static let worktreeTitle = "Worktree"
        public static let workspaceTitle = "Workspace"
        public static let harnessTitle = "Harness"
        /// `machineLauncher.enterCustomPath`.
        public static var enterCustomPath: String { localized("machineLauncher.enterCustomPath", "Enter custom path") }
        public static let customPathPlaceholder = "~/path/to/project"
        public static let interruptHint = "To interrupt press stop"
        public static let addImage = "Add image"
        // useStartSessionFromDraft.ts's directory question.
        public static let createDirectoryTitle = "Create Directory?"
        public static func createDirectoryMessage(_ directory: String) -> String {
            "The directory '\(directory)' does not exist. Would you like to create it?"
        }
        /// `common.create`.
        public static var create: String { localized("common.create", "Create") }

        // Making a bot (HomeDock.tsx, BotFacePicker.tsx), in English there.
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
        public static var title: String { localized("newSession.title", "Start New Session") }
        /// EmptyMainScreen.tsx's button, written there in English.
        public static let startNewSession = "Start New Session"
        /// `newSession.machineOffline`.
        public static var machineOffline: String { localized("newSession.machineOffline", "Machine is offline") }
        /// `machine.offlineHelp`.
        public static var offlineHelp: String { localized("machine.offlineHelp", "• Run `happy daemon start` on your computer\n• Make sure your computer is online\n• Run `happy daemon status` to diagnose\n• Are you running the latest CLI version? Upgrade with `npm install -g happy@latest`") }
        public static let happyAgentOffline = "Happy Agent is offline on this computer"
        /// `newSession.switchMachinesHint`.
        public static var switchMachinesHint: String { localized("newSession.switchMachinesHint", "• Switch machines by clicking on the machine above") }
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
        public static var settings: String { localized("settings.title", "Settings") }
        public static let voiceInput = "Voice input"
        public static func agent(_ label: String) -> String { "Agent: \(label)" }
    }
}
