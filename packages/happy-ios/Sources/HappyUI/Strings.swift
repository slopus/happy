import Foundation
import HappyCore

/// English copy, taken verbatim from packages/happy-app/sources/text/translations/en.ts
/// so both apps say the same thing. A string happy-app reads with `t(key)`
/// is a getter for that key in the screens' language (`localized`), with
/// the English kept beside it; one happy-app spells out in a component stays
/// English, as it does there, with the component and line that spell it out
/// beside it. Keys follow en.ts's grouping.
public enum Strings {
    public enum Common {
        public static var cancel: String { localized("common.cancel", "Cancel") }
        public static var error: String { localized("common.error", "Error") }
        public static var success: String { localized("common.success", "Success") }
        public static var save: String { localized("common.save", "Save") }
        public static var continueAction: String { localized("common.continue", "Continue") }
        public static var reset: String { localized("common.reset", "Reset") }
        public static var logout: String { localized("common.logout", "Logout") }
        public static var version: String { localized("common.version", "Version") }
        public static var urlPlaceholder: String { localized("common.urlPlaceholder", "https://example.com") }
        public static var ok: String { localized("common.ok", "OK") }
        public static var back: String { localized("common.back", "Back") }
        public static var authenticate: String { localized("common.authenticate", "Authenticate") }
        public static var copied: String { localized("common.copied", "Copied") }
        public static var delete: String { localized("common.delete", "Delete") }
        public static var scanning: String { localized("common.scanning", "Scanning...") }
    }

    public enum Status {
        public static var online: String { localized("status.online", "online") }
        public static var offline: String { localized("status.offline", "offline") }
        public static var permissionRequired: String { localized("status.permissionRequired", "permission required") }
        public static var inputRequired: String { localized("status.inputRequired", "waiting for your answer") }
        public static var unread: String { localized("status.unread", "new results") }
    }

    public enum Items {
        public static func copiedToClipboard(label: String) -> String { localized("items.copiedToClipboard", ["label": .text(label)], "\(label) copied to clipboard") }
    }

    public enum Onboarding {
        public static var headline: String { localized("onboarding.headline", "Claude, Codex, Grok\nin your pocket") }
        public static var propEncrypted: String { localized("onboarding.propEncrypted", "End-to-end encrypted") }
        public static var propNoPassword: String { localized("onboarding.propNoPassword", "No email, no password") }
        public static var propOpenSource: String { localized("onboarding.propOpenSource", "Open source, MIT license") }
        public static var createAccount: String { localized("onboarding.createAccount", "Create account") }
        public static var restoreExisting: String { localized("onboarding.restoreExisting", "Restore existing account") }
        public static var linkTitle: String { localized("onboarding.linkTitle", "Link Your Computer") }
        public static var installStep: String { localized("onboarding.installStep", "Install Happy on your computer") }
        public static var installBodyPrefix: String { localized("onboarding.installBodyPrefix", "Download Happy from ") }
        public static var installBodyLink: String { localized("onboarding.installBodyLink", "happy.engineering") }
        public static var installBodySuffix: String { localized("onboarding.installBodySuffix", ".") }
        public static var openStep: String { localized("onboarding.openStep", "Open Happy and choose Link\u{00A0}Mobile\u{00A0}App") }
        public static var openBody: String { localized("onboarding.openBody", "It’s the last step of setup on your computer. A QR code appears there.") }
        public static var scanButton: String { localized("onboarding.scanButton", "Scan QR code") }
        public static var pasteLink: String { localized("onboarding.pasteLink", "Can’t scan QR code? Paste link instead") }
        public static var pasteLinkTitle: String { localized("onboarding.pasteLinkTitle", "Paste link") }
        public static var pasteLinkMessage: String { localized("onboarding.pasteLinkMessage", "On your computer, choose Copy auth link, then paste it here.") }
        public static var pasteLinkConfirm: String { localized("onboarding.pasteLinkConfirm", "Link") }
        public static var linking: String { localized("onboarding.linking", "Linking…") }
        public static var linkFailed: String { localized("onboarding.linkFailed", "Couldn’t link. Scan the code again.") }
        public static var terminalInstall: String { localized("onboarding.terminalInstall", "npm install -g happy") }
        public static var terminalRun: String { localized("onboarding.terminalRun", "happy") }
        public static func offlineTitleOne(name: String) -> String { localized("onboarding.offlineTitleOne", ["name": .text(name)], "\(name) is offline") }
        public static var offlineTitleMany: String { localized("onboarding.offlineTitleMany", "Your computers are offline") }
        public static func offlineLinkedStep(name: String) -> String { localized("onboarding.offlineLinkedStep", ["name": .text(name)], "Linked \(name)") }
        public static func offlineLinkedStepMany(count: Int) -> String { localized("onboarding.offlineLinkedStepMany", ["count": .number(count)], "Linked \(count) computers") }
        public static var offlineOpenStep: String { localized("onboarding.offlineOpenStep", "Open Happy on your computer") }
        public static var offlineOpenBody: String { localized("onboarding.offlineOpenBody", "Open Happy Desktop, or run happy in a terminal. This screen updates as soon as it connects.") }
        public static var offlineTroubleshoot: String { localized("onboarding.offlineTroubleshoot", "Troubleshoot") }
        public static var linkAnother: String { localized("onboarding.linkAnother", "Link another computer") }
        public static var getHelp: String { localized("onboarding.getHelp", "Get help") }
        public static var helpMessage: String { localized("onboarding.helpMessage", "Stuck? Come ask us.") }
        public static var helpDiscord: String { localized("onboarding.helpDiscord", "Ask on Discord") }
        public static var helpBra1nDump: String { localized("onboarding.helpBra1nDump", "DM @bra1n_dump on X") }
        public static var helpEx3ndr: String { localized("onboarding.helpEx3ndr", "DM @Ex3NDR on X") }
        public static var helpIssues: String { localized("onboarding.helpIssues", "Browse known issues") }
        public static var settingsTitle: String { localized("onboarding.settingsTitle", "Settings") }
        public static var settingsServer: String { localized("onboarding.settingsServer", "Server") }
        public static var settingsServerDefault: String { localized("onboarding.settingsServerDefault", "Default") }
        public static var logoutStartOver: String { localized("onboarding.logoutStartOver", "Log out and start over") }
        public static var logoutFooter: String { localized("onboarding.logoutFooter", "This account has nothing in it yet, so nothing is lost.") }
        public static var logoutConfirmTitle: String { localized("onboarding.logoutConfirmTitle", "Log out and start over?") }
        public static var logoutConfirmBody: String { localized("onboarding.logoutConfirmBody", "You will go back to Create account. Nothing on your computer changes.") }
        public static var restoreTitle: String { localized("onboarding.restoreTitle", "Restore Account") }
        public static var restoreScan: String { localized("onboarding.restoreScan", "Scan this code with your other phone.") }
        public static var restoreScanPath: String { localized("onboarding.restoreScanPath", "Happy › Settings › Account › Link New Device") }
        public static var restoreUseKey: String { localized("onboarding.restoreUseKey", "Use a secret key instead") }
        public static var secretKeyTitle: String { localized("onboarding.secretKeyTitle", "Secret Key") }
        public static var secretKeyBody: String { localized("onboarding.secretKeyBody", "Paste your secret key. It is in Happy › Settings › Account on your other device.") }
        public static var restoreButton: String { localized("onboarding.restoreButton", "Restore") }
        public static let desktopURL = URL(string: "https://happy.engineering")!
    }

    /// The Get help sheet's destinations, in happy-app's order for iOS.
    public static let helpLinks: [(title: String, url: URL)] = [
        (Onboarding.helpDiscord, URL(string: "https://discord.gg/fX9WBAhyfD")!),
        (Onboarding.helpBra1nDump, URL(string: "https://x.com/bra1n_dump")!),
        (Onboarding.helpEx3ndr, URL(string: "https://x.com/Ex3NDR")!),
        (Onboarding.helpIssues, URL(string: "https://github.com/slopus/happy/issues")!),
    ]

    public enum Troubleshoot {
        public static var title: String { localized("troubleshoot.title", "Troubleshoot") }
        public static var heading: String { localized("troubleshoot.heading", "Happy is not running on your computer") }
        public static var intro: String { localized("troubleshoot.intro", "Your phone talks to Happy on your computer. When nothing is running there, everything here is offline.") }
        public static var awakeStep: String { localized("troubleshoot.awakeStep", "Is the computer awake and online?") }
        public static var awakeBody: String { localized("troubleshoot.awakeBody", "Sleep and a dropped connection are the usual causes.") }
        public static var desktopStep: String { localized("troubleshoot.desktopStep", "Is Happy Desktop open?") }
        public static var desktopBodyPrefix: String { localized("troubleshoot.desktopBodyPrefix", "Open it, or download it from ") }
        public static var desktopBodyLink: String { localized("troubleshoot.desktopBodyLink", "happy.engineering") }
        public static var desktopBodySuffix: String { localized("troubleshoot.desktopBodySuffix", ". We recommend it.") }
        public static var terminalStep: String { localized("troubleshoot.terminalStep", "Using the terminal?") }
        public static var terminalBody: String { localized("troubleshoot.terminalBody", "Run happy again. The computer comes back online as soon as it starts.") }
        public static var terminalComment: String { localized("troubleshoot.terminalComment", "# Not using Happy Desktop?") }
        public static var machines: String { localized("troubleshoot.machines", "Machines") }
        public static var machineOffline: String { localized("troubleshoot.machineOffline", "Offline") }
        public static func bannerTitleOne(name: String) -> String { localized("troubleshoot.bannerTitleOne", ["name": .text(name)], "\(name) is offline") }
        public static var bannerTitleMany: String { localized("troubleshoot.bannerTitleMany", "All machines offline") }
        public static var bannerSubtitle: String { localized("troubleshoot.bannerSubtitle", "Troubleshoot") }
        public static var copyAiPrompt: String { localized("troubleshoot.copyAiPrompt", "Copy AI prompt") }
        public static var copyAiPromptHint: String { localized("troubleshoot.copyAiPromptHint", "Paste it into Claude Code or Codex on your computer to diagnose from the logs.") }
        public static var copied: String { localized("troubleshoot.copied", "Copied") }
        public static var copyFailed: String { localized("troubleshoot.copyFailed", "Could not copy the AI prompt.") }
    }

    public enum Sidebar {
        public static var sessionsTitle: String { localized("sidebar.sessionsTitle", "Happy") }
        public static var showArchived: String { localized("sidebar.showArchived", "Show archived") }
        public static var hideArchived: String { localized("sidebar.hideArchived", "Hide archived") }
    }

    public enum SessionHistory {
        public static var today: String { localized("sessionHistory.today", "Today") }
        public static var yesterday: String { localized("sessionHistory.yesterday", "Yesterday") }
        public static func daysAgo(_ count: Int) -> String { localized("sessionHistory.daysAgo", ["count": .number(count)], "\(count) \(count == 1 ? "day" : "days") ago") }
    }

    public enum Session {
        public static var newChat: String { localized("session.newChat", "New chat") }
        public static var archiveAction: String { localized("session.archiveAction", "Archive") }
        public static var actionsTitle: String { localized("session.actionsTitle", "Session") }
    }

    public enum SessionInfo {
        public static var archiveSession: String { localized("sessionInfo.archiveSession", "Archive Session") }
        public static var failedToArchiveSession: String { localized("sessionInfo.failedToArchiveSession", "Failed to archive session") }
        public static let botNeedsMachine = "Connect to the bot’s machine to archive it."  // useSessionQuickActions.ts:265, spelled out
    }

    public enum EmptyMain {
        public static let noSessionsTitle = "No sessions yet"  // EmptyMainScreen.tsx:192, spelled out
        public static let noSessionsDescription = "Start one on a connected machine."  // EmptyMainScreen.tsx:193, spelled out
    }

    public enum Connect {
        public static var enterSecretKey: String { localized("connect.enterSecretKey", "Please enter a secret key") }
        public static var invalidSecretKey: String { localized("connect.invalidSecretKey", "Invalid secret key. Please check and try again.") }
        public static var enterUrlManually: String { localized("connect.enterUrlManually", "Enter URL manually") }
    }

    public enum Settings {
        public static var title: String { localized("settings.title", "Settings") }
        public static var connectedAccounts: String { localized("settings.connectedAccounts", "Connected Accounts") }
        public static var connectAccount: String { localized("settings.connectAccount", "Connect account") }
        public static var github: String { localized("settings.github", "GitHub") }
        public static var features: String { localized("settings.features", "Features") }
        public static var scanQrCodeToAuthenticate: String { localized("settings.scanQrCodeToAuthenticate", "Scan QR code to authenticate") }
        public static var account: String { localized("settings.account", "Account") }
        public static var accountSubtitle: String { localized("settings.accountSubtitle", "Manage your account details") }
        public static var appearance: String { localized("settings.appearance", "Appearance") }
        public static var appearanceSubtitle: String { localized("settings.appearanceSubtitle", "Customize how the app looks") }
        public static var about: String { localized("settings.about", "About") }
        public static var aboutFooter: String { localized("settings.aboutFooter", "Happy Coder is a Codex and Claude Code mobile client. It's fully end-to-end encrypted and your account is stored only on your device. Not affiliated with Anthropic.") }
        public static var whatsNew: String { localized("settings.whatsNew", "What's New") }
        public static var whatsNewSubtitle: String { localized("settings.whatsNewSubtitle", "See the latest updates and improvements") }
        public static var reportIssue: String { localized("settings.reportIssue", "Report an Issue") }
        public static var privacyPolicy: String { localized("settings.privacyPolicy", "Privacy Policy") }
        public static var termsOfService: String { localized("settings.termsOfService", "Terms of Service") }
        public static var eula: String { localized("settings.eula", "EULA") }
        public static func githubConnected(login: String) -> String { localized("settings.githubConnected", ["login": .text(login)], "Connected as @\(login)") }
        public static var connectGithubAccount: String { localized("settings.connectGithubAccount", "Connect your GitHub account") }
        public static let agents = "Agents"  // SettingsView.tsx:341, spelled out
        public static let agentsSubtitle = "Connected machines and agent defaults"  // SettingsView.tsx:342, spelled out
        public static let claudeCode = "Claude Code"  // SettingsView.tsx:275, spelled out
    }

    /// Where the About rows lead (SettingsView.tsx).
    public enum Links {
        public static let github = URL(string: "https://github.com/slopus/happy")!
        public static let githubDetail = "slopus/happy"  // SettingsView.tsx:381, spelled out
        public static let issues = URL(string: "https://github.com/slopus/happy/issues")!
        public static let privacy = URL(string: "https://happy.engineering/privacy/")!
        public static let terms = URL(string: "https://happy.engineering/terms/")!
        public static let eula = URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!
    }

    public enum SettingsAppearance {
        public static var theme: String { localized("settingsAppearance.theme", "Theme") }
        public static var themeDescription: String { localized("settingsAppearance.themeDescription", "Choose your preferred color scheme") }
        public static var themeAdaptive: String { localized("settingsAppearance.themeOptions.adaptive", "Adaptive") }
        public static var themeLight: String { localized("settingsAppearance.themeOptions.light", "Light") }
        public static var themeDark: String { localized("settingsAppearance.themeOptions.dark", "Dark") }
        public static var themeAdaptiveDescription: String { localized("settingsAppearance.themeDescriptions.adaptive", "Match system settings") }
        public static var themeLightDescription: String { localized("settingsAppearance.themeDescriptions.light", "Always use light theme") }
        public static var themeDarkDescription: String { localized("settingsAppearance.themeDescriptions.dark", "Always use dark theme") }
        public static var chat: String { localized("settingsAppearance.chat", "Chat") }
        public static var chatDescription: String { localized("settingsAppearance.chatDescription", "Customize chat message appearance") }
        public static var usageLimitShowRemaining: String { localized("settingsAppearance.usageLimitShowRemaining", "Show Quota Remaining") }
        public static var usageLimitShowRemainingDescription: String { localized("settingsAppearance.usageLimitShowRemainingDescription", "Count plan limits down from full instead of up from empty") }
        public static var userMessageBubbleColor: String { localized("settingsAppearance.userMessageBubbleColor", "User Bubble Color") }
        public static var userMessageBubbleColorDescription: String { localized("settingsAppearance.userMessageBubbleColorDescription", "Make your messages easier to spot in long chats") }
        public static func bubbleColorName(_ color: String) -> String {
            switch color {
            case "blue": localized("settingsAppearance.userMessageBubbleColorOptions.blue", "Blue")
            case "green": localized("settingsAppearance.userMessageBubbleColorOptions.green", "Green")
            case "purple": localized("settingsAppearance.userMessageBubbleColorOptions.purple", "Purple")
            case "rose": localized("settingsAppearance.userMessageBubbleColorOptions.rose", "Rose")
            case "sand": localized("settingsAppearance.userMessageBubbleColorOptions.sand", "Sand")
            default: localized("settingsAppearance.userMessageBubbleColorOptions.gray", "Gray")
            }
        }
        public static var display: String { localized("settingsAppearance.display", "Display") }
        public static var displayDescription: String { localized("settingsAppearance.displayDescription", "Control layout and spacing") }
        public static var compactToolCalls: String { localized("settingsAppearance.compactToolCalls", "Compact Tool Calls") }
        public static var compactToolCallsDescription: String { localized("settingsAppearance.compactToolCallsDescription", "Show non-interactive tool calls as one-line rows; open a row for details") }
        public static var showLineNumbersInToolViews: String { localized("settingsAppearance.showLineNumbersInToolViews", "Show Line Numbers in Tool Views") }
        public static var showLineNumbersInToolViewsDescription: String { localized("settingsAppearance.showLineNumbersInToolViewsDescription", "Display line numbers in tool view diffs") }
        public static var alwaysShowContextSize: String { localized("settingsAppearance.alwaysShowContextSize", "Show Usage Status") }
        public static var alwaysShowContextSizeDescription: String { localized("settingsAppearance.alwaysShowContextSizeDescription", "Context and plan usage below the input. Near-limit warnings always show.") }
        public static var input: String { localized("settingsAppearance.input", "Input") }
        public static var inputDescription: String { localized("settingsAppearance.inputDescription", "Configure the message input") }
        public static var showHarnessIconInSessionHeader: String { localized("settingsAppearance.showHarnessIconInSessionHeader", "Show Harness Icon in Session Header") }
        public static var showHarnessIconInSessionHeaderDescription: String { localized("settingsAppearance.showHarnessIconInSessionHeaderDescription", "Display the harness icon in the session header") }
        public static var showHarnessIconsInSessionList: String { localized("settingsAppearance.showHarnessIconsInSessionList", "Show Harness Icons in Session List") }
        public static var showHarnessIconsInSessionListDescription: String { localized("settingsAppearance.showHarnessIconsInSessionListDescription", "Display harness icons on session-list avatars") }
        public static var avatars: String { localized("settingsAppearance.avatars", "Avatars") }
        public static var avatarsDescription: String { localized("settingsAppearance.avatarsDescription", "Choose how generated session avatars look") }
        public static var avatarStyle: String { localized("settingsAppearance.avatarStyle", "Avatar Style") }
        public static func avatarStyleName(_ style: String) -> String {
            switch style {
            case "pixelated": localized("settingsAppearance.avatarStyleOptions.pixelated", "Pixelated")
            case "gradient": localized("settingsAppearance.avatarStyleOptions.gradient", "Gradient")
            default: localized("settingsAppearance.avatarStyleOptions.brutalist", "Brutalist")
            }
        }
        public static var avatarMonochrome: String { localized("settingsAppearance.avatarMonochrome", "Black & White Avatars") }
        public static var avatarMonochromeDescription: String { localized("settingsAppearance.avatarMonochromeDescription", "Render avatars without color") }
        public static let fileDiffsSidebar = "File Diffs Sidebar"  // appearance.tsx:494, spelled out
        public static let fileDiffsSidebarDescription = "Show git changes next to the chat on desktop"  // appearance.tsx:495, spelled out
    }

    public enum SessionsFilter {
        public static var groupingTitle: String { localized("sessionsFilter.groupingTitle", "Grouping") }
        public static var flatList: String { localized("sessionsFilter.flatList", "Flat List") }
        public static var groupByProject: String { localized("sessionsFilter.groupByProject", "Group by Project") }
    }

    public enum SettingsFeatures {
        public static var groupToolCalls: String { localized("settingsFeatures.groupToolCalls", "Group Tool Calls") }
        public static var groupToolCallsSubtitle: String { localized("settingsFeatures.groupToolCallsSubtitle", "Collapse consecutive tool calls into one container") }
    }

    public enum SettingsLanguage {
        public static var title: String { localized("settingsLanguage.title", "Language") }
        public static var description: String { localized("settingsLanguage.description", "Choose your preferred language for the app interface. This will sync across all your devices.") }
        public static var currentLanguage: String { localized("settingsLanguage.currentLanguage", "Current Language") }
        public static var automatic: String { localized("settingsLanguage.automatic", "Automatic") }
        public static var automaticSubtitle: String { localized("settingsLanguage.automaticSubtitle", "Detect from device settings") }
        public static var needsRestart: String { localized("settingsLanguage.needsRestart", "Language Changed") }
        public static var needsRestartMessage: String { localized("settingsLanguage.needsRestartMessage", "The app needs to restart to apply the new language setting.") }
    }

    public enum SettingsAccount {
        public static var accountInformation: String { localized("settingsAccount.accountInformation", "Account Information") }
        public static var status: String { localized("settingsAccount.status", "Status") }
        public static var statusActive: String { localized("settingsAccount.statusActive", "Active") }
        public static var anonymousId: String { localized("settingsAccount.anonymousId", "Analytics ID") }
        public static var publicId: String { localized("settingsAccount.publicId", "Public ID") }
        public static var notAvailable: String { localized("settingsAccount.notAvailable", "Not available") }
        public static var linkNewDevice: String { localized("settingsAccount.linkNewDevice", "Link New Device") }
        public static var linkNewDeviceSubtitle: String { localized("settingsAccount.linkNewDeviceSubtitle", "Scan QR code to link device") }
        public static var profile: String { localized("settingsAccount.profile", "Profile") }
        public static var name: String { localized("settingsAccount.name", "Name") }
        public static var github: String { localized("settingsAccount.github", "GitHub") }
        public static var tapToDisconnect: String { localized("settingsAccount.tapToDisconnect", "Tap to disconnect") }
        public static var privacy: String { localized("settingsAccount.privacy", "Privacy") }
        public static var privacyDescription: String { localized("settingsAccount.privacyDescription", "Shares usage data, like which features you use and your device type, to help us improve Happy. Never your messages or code.") }
        public static var analytics: String { localized("settingsAccount.analytics", "Analytics") }
        public static var analyticsDisabled: String { localized("settingsAccount.analyticsDisabled", "No data is shared") }
        public static var analyticsEnabled: String { localized("settingsAccount.analyticsEnabled", "Usage data is shared") }
        public static var dangerZone: String { localized("settingsAccount.dangerZone", "Danger Zone") }
        public static var backup: String { localized("settingsAccount.backup", "Backup") }
        public static var backupDescription: String { localized("settingsAccount.backupDescription", "Your secret key is the only way to recover your account. Save it in a secure place like a password manager.") }
        public static var secretKey: String { localized("settingsAccount.secretKey", "Secret Key") }
        public static var tapToReveal: String { localized("settingsAccount.tapToReveal", "Tap to reveal") }
        public static var tapToHide: String { localized("settingsAccount.tapToHide", "Tap to hide") }
        public static var secretKeyLabel: String { localized("settingsAccount.secretKeyLabel", "SECRET KEY (TAP TO COPY)") }
        public static var secretKeyCopied: String { localized("settingsAccount.secretKeyCopied", "Secret key copied to clipboard. Store it in a safe place!") }
        public static var logout: String { localized("settingsAccount.logout", "Logout") }
        public static var logoutSubtitle: String { localized("settingsAccount.logoutSubtitle", "Sign out and clear local data") }
        public static var logoutConfirm: String { localized("settingsAccount.logoutConfirm", "Are you sure you want to logout? Make sure you have backed up your secret key!") }
    }

    /// settings/account.tsx's push section, which en.ts does not cover.
    public enum Push {
        public static let title = "Push Notifications"  // account.tsx:506, spelled out
        public static let footer = "Shows every push token registered on your account. Tap an old token to delete it."  // account.tsx:507, spelled out
        public static let permission = "Permission"  // account.tsx:510, spelled out
        public static let requestAgain = "Request Permission Again"  // account.tsx:518, spelled out
        public static let enabled = "Push notifications are enabled for this device."  // account.tsx:239, spelled out
        public static let openSettingsTitle = "Open Settings"  // account.tsx:246, spelled out
        public static let openedSettings = "The system will not show the permission prompt again, so Happy opened Settings instead."  // account.tsx:246, spelled out
        public static let notGranted = "Push notification permission was not granted."  // account.tsx:250, spelled out
        public static let requestFailed = "Failed to request push notification permission."  // account.tsx:253, spelled out
        public static func registeredTokens(_ count: Int) -> String { "Registered Tokens (\(count))" }  // account.tsx:544, spelled out
        public static let tokensFooter = "Current-device metadata comes from this phone. Older tokens use their token fingerprint plus server timestamps."  // account.tsx:545, spelled out
        public static let noTokens = "No registered push tokens"  // account.tsx:549, spelled out
        public static let noTokensSubtitle = "Once this device is registered, it will appear here."  // account.tsx:550, spelled out
        public static let deleteTitle = "Delete Push Token"  // account.tsx:290, spelled out
        public static func deleteMessage(_ fingerprint: String) -> String { "Remove \(fingerprint) from your account?" }  // account.tsx:291, spelled out
        public static let deleteFailed = "Failed to delete push token."  // account.tsx:305, spelled out
        public static let loadFailed = "Failed to load push notification settings."  // account.tsx:149, spelled out
    }

    /// app/(app)/settings/agents.tsx, which en.ts does not cover.
    public enum Agents {
        public static let machines = "Machines"
        public static let noMachines = "No connected machines"  // agents.tsx:188, spelled out
        public static let noMachinesSubtitle = "Run Happy on a computer to connect it"  // agents.tsx:189, spelled out
        public static let defaults = "Defaults"  // agents.tsx:228, spelled out
        public static let clearOverrides = "Clear Overrides"  // agents.tsx:231, spelled out
        public static let clearOverridesSubtitle = "Return every agent to code defaults"  // agents.tsx:232, spelled out
        public static let useCodeDefault = "Use code default"  // agents.tsx:153, spelled out
        public static let customModel = "Custom model…"  // agents.tsx:168, spelled out
        public static let customModelSubtitle = "Enter an exact model ID"  // agents.tsx:169, spelled out
        public static let customModelTitle = "Custom Codex model"  // agents.tsx:91, spelled out
        public static let customModelMessage = "Enter an exact model ID. Availability depends on your Codex account or API configuration."  // agents.tsx:92, spelled out
        public static let customModelPlaceholder = "model-id"  // agents.tsx:95, spelled out
    }

    public enum Changelog {
        public static var noEntriesAvailable: String { localized("changelog.noEntriesAvailable", "No changelog entries available.") }
    }

    /// settings/connect/claude.tsx `OAuthViewUnsupported`.
    public enum ConnectClaude {
        public static let title = "Connect Claude"  // OAuthView.tsx:363 "Connect ", spelled out
        public static let instruction = "Run the following command in your terminal:"  // OAuthView.tsx:364, spelled out
        public static let command = "happy connect claude"  // connect/claude.tsx:54, spelled out
    }

    public enum Server {
        public static var title: String { localized("server.title", "Server") }
        public static var serverUrlLabel: String { localized("server.serverUrlLabel", "Server URL") }
        public static var selfHostFooter: String { localized("server.selfHostFooter", "For self-hosted servers. Sign out and back in after changing it.") }
        public static var enterServerUrl: String { localized("server.enterServerUrl", "Please enter a server URL") }
        public static var notValidHappyServer: String { localized("server.notValidHappyServer", "Not a valid Happy Server") }
        public static var changeServer: String { localized("server.changeServer", "Change Server") }
        public static var continueWithServer: String { localized("server.continueWithServer", "Continue with this server?") }
        public static var resetToDefault: String { localized("server.resetToDefault", "Reset to Default") }
        public static var resetServerDefault: String { localized("server.resetServerDefault", "Reset server to default?") }
        public static var validating: String { localized("server.validating", "Validating...") }
        public static var validatingServer: String { localized("server.validatingServer", "Validating server...") }
        public static var serverReturnedError: String { localized("server.serverReturnedError", "Server returned an error") }
        public static var failedToConnectToServer: String { localized("server.failedToConnectToServer", "Failed to connect to server") }
        public static var currentlyUsingCustomServer: String { localized("server.currentlyUsingCustomServer", "Currently using custom server") }
        public static var invalidFormat: String { localized("errors.invalidFormat", "Invalid format") }
    }

    public enum Modals {
        public static var authenticateTerminal: String { localized("modals.authenticateTerminal", "Authenticate Terminal") }
        public static var pasteUrlFromTerminal: String { localized("modals.pasteUrlFromTerminal", "Paste the authentication URL from your terminal") }
        public static var invalidAuthUrl: String { localized("modals.invalidAuthUrl", "Invalid authentication URL") }
        public static var failedToConnectTerminal: String { localized("modals.failedToConnectTerminal", "Failed to connect terminal") }
        public static var deviceLinkedSuccessfully: String { localized("modals.deviceLinkedSuccessfully", "Device linked successfully") }
        public static var failedToLinkDevice: String { localized("modals.failedToLinkDevice", "Failed to link device") }
        public static var cameraPermissionsRequiredToScanQr: String { localized("modals.cameraPermissionsRequiredToScanQr", "Camera permissions are required to scan QR codes") }
        public static var developerMode: String { localized("modals.developerMode", "Developer Mode") }
        public static var developerModeEnabled: String { localized("modals.developerModeEnabled", "Developer mode enabled") }
        public static var developerModeDisabled: String { localized("modals.developerModeDisabled", "Developer mode disabled") }
        public static var disconnectGithub: String { localized("modals.disconnectGithub", "Disconnect GitHub") }
        public static var disconnectGithubConfirm: String { localized("modals.disconnectGithubConfirm", "Are you sure you want to disconnect your GitHub account?") }
        public static func disconnectService(_ service: String) -> String { localized("modals.disconnectService", ["service": .text(service)], "Disconnect \(service)") }
        public static func disconnectServiceConfirm(_ service: String) -> String {
            localized("modals.disconnectServiceConfirm", ["service": .text(service)], "Are you sure you want to disconnect \(service) from your account?")
        }
        public static var disconnect: String { localized("modals.disconnect", "Disconnect") }
        // Not in happy-app, which still accepts v1 terminals.
        public static let terminalNeedsUpdate = "This terminal runs an old version of Happy. Update Happy on your computer, then scan again."
    }

    // happy-app uses the system scanner, so this copy is new.
    public enum Scanner {
        public static let hint = "Scan the QR code"
        public static let openSettings = "Open Settings"
        public static let unavailable = "This device has no camera that can scan QR codes."
        public static let close = "Close"
    }

    public enum Errors {
        public static var authenticationFailed: String { localized("errors.authenticationFailed", "Authentication failed") }
        public static func disconnectServiceFailed(_ service: String) -> String { localized("errors.disconnectServiceFailed", ["service": .text(service)], "Failed to disconnect \(service)") }
    }
}
