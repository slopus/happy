import Foundation
import HappyCore

// Copied verbatim from packages/happy-app/sources/text/translations/en.ts.
// A string happy-app spells out in a component stays English here, with the
// component and line that spell it out beside it.
extension Strings {
    public enum Home {
        /// `tabs.sessions`: the phone header's title.
        public static var sessionsTitle: String { localized("tabs.sessions", "Sessions") }

        /// `status.*`, the socket states HomeHeaderTitle.tsx names.
        public static func connectionStatus(_ status: RealtimeStatus) -> String {
            switch status {
            case .connected: localized("status.connected", "connected")
            case .connecting: localized("status.connecting", "connecting")
            case .disconnected: localized("status.disconnected", "disconnected")
            case .error: localized("status.error", "error")
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
        /// `t('status.unknown')`, the word ProjectHomeList.tsx:128 passes as `unknownMachineText` for a chat with no
        /// computer; `ProjectHomeData` and `TabletGroupedList` wrap it in `<…>`, as projectHomeList.ts:368 does.
        public static var unknownMachine: String { localized("status.unknown", "unknown") }
        public static let createWorkspace = "Create workspace"  // ProjectHomeList.tsx:466, spelled out
        public static func createWorkspaceIn(_ project: String) -> String { "Create workspace in \(project)" }  // ProjectHomeList.tsx:520, spelled out

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
        public static let actionUnknownError = "Unknown error"  // useHappyAction.ts:33, spelled out

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
        public static let dockPlaceholder = "Plan, ask, build…"  // HomeDock.tsx:1793, spelled out
        public static let selectMachine = "Select machine"  // HomeDock.tsx:1298, spelled out
        public static let noProject = "~"  // HomeDock.tsx:1303, spelled out
        public static let mainWorkspace = "Main"  // HomeDock.tsx:923, spelled out
        public static let noWorktree = "No worktree"  // HomeDock.tsx:923, spelled out
        public static let harnessHelp = "Help"  // HomeDock.tsx:1315, spelled out
        public static let harnessHelpLabel = "Harness setup help"  // HomeDock.tsx:1563, spelled out
        public static let harnessHelpURL = URL(string: "https://happy.engineering/docs/quick-start/")!
        // HomeDock.tsx's pickers spell these out in English (its sheet's
        // "Machine" and "Projects"), so they stay English here too.
        public static let machineTitle = "Machine"
        public static let projectTitle = "Project"  // HomeDock.tsx:1395, spelled out
        public static let projectsSection = "Projects"
        public static let worktreeTitle = "Worktree"  // HomeDock.tsx:1427, spelled out
        public static let workspaceTitle = "Workspace"  // HomeDock.tsx:1427, spelled out
        public static let harnessTitle = "Harness"  // HomeDock.tsx:1442, spelled out
        /// `machineLauncher.enterCustomPath`.
        public static var enterCustomPath: String { localized("machineLauncher.enterCustomPath", "Enter custom path") }
        public static let customPathPlaceholder = "~/path/to/project"  // HomeDock.tsx:1369, spelled out
        public static let interruptHint = "To interrupt press stop"  // HomeDock.tsx:2190, spelled out
        public static let addImage = "Add image"  // HomeDock.tsx:1931, spelled out
        // useStartSessionFromDraft.ts's directory question.
        public static let createDirectoryTitle = "Create Directory?"  // useStartSessionFromDraft.ts:644, spelled out
        public static func createDirectoryMessage(_ directory: String) -> String {  // useStartSessionFromDraft.ts:645, spelled out
            "The directory '\(directory)' does not exist. Would you like to create it?"
        }
        /// `common.create`.
        public static var create: String { localized("common.create", "Create") }

        // Making a bot (HomeDock.tsx, BotFacePicker.tsx), in English there.
        public static let composerSession = "Session"
        public static let composerBot = "Bot"  // HomeDock.tsx:117, spelled out
        public static let composerKindLabel = "What to create"  // HomeDock.tsx:2148, spelled out
        public static let botLede = "Bots are virtual colleagues great for recurring work like releases, competitor analysis, or to own a large feature across several projects and worktrees"  // HomeDock.tsx:121, spelled out
        public static let createBot = "Create bot"  // HomeDock.tsx:2033, spelled out
        public static let botFaceHeading = "Avatar"  // BotFacePicker.tsx:101, spelled out
        public static func botFaceLabel(_ index: Int) -> String { "Face \(index + 1)" }  // BotFacePicker.tsx:112, spelled out
        public static let rollBotFaces = "Roll four new faces"  // BotFacePicker.tsx:124, spelled out
        public static let botFaceCreditLead = "Art by "  // BotFacePicker.tsx:130, spelled out
        // useStartSessionFromDraft.ts `offerBotFaceRetry`.
        public static let botFaceNotSet = "Picture not set"  // useStartSessionFromDraft.ts:208, spelled out
        public static let botFaceNotNow = "Not now"  // useStartSessionFromDraft.ts:213, spelled out
        public static let botFaceTryAgain = "Try again"  // useStartSessionFromDraft.ts:215, spelled out
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
        public static let happyAgentOffline = "Happy Agent is offline on this computer"  // new/index.tsx:1258, spelled out
        /// `newSession.switchMachinesHint`.
        public static var switchMachinesHint: String { localized("newSession.switchMachinesHint", "• Switch machines by clicking on the machine above") }
        public static let searchMachines = "search machines..."  // new/index.tsx:1324, spelled out
        public static let searchWorktrees = "search worktrees..."  // new/index.tsx:1326, spelled out
        public static let searchWorkspaces = "search workspaces..."  // new/index.tsx:1326, spelled out
        public static let searchAgents = "search agents..."  // new/index.tsx:1328, spelled out
        public static let noResults = "no results"  // new/index.tsx:411, spelled out
        public static let pathPlaceholder = "Enter project path"  // new/index.tsx:656, spelled out
        public static func usingProject(_ name: String) -> String { "using project \(name)" }  // new/index.tsx:675, spelled out
        public static let usingCustomPath = "using custom path above"  // new/index.tsx:679, spelled out
        public static let recent = "Recent"  // new/index.tsx:684, spelled out
        public static let noRecentProjects = "no recent projects yet"  // new/index.tsx:731, spelled out
        /// `settings.title`.
        public static var settings: String { localized("settings.title", "Settings") }
        public static let voiceInput = "Voice input"  // new/index.tsx:2331, spelled out
        public static func agent(_ label: String) -> String { "Agent: \(label)" }  // new/index.tsx:2286, spelled out
    }
}
