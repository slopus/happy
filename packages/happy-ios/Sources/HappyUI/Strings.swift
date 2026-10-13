import Foundation

/// English copy, taken verbatim from packages/happy-app/sources/text/translations/en.ts
/// so both apps say the same thing. Other languages come later through a
/// string catalog; keeping the keys grouped like en.ts makes that a lookup.
public enum Strings {
    public enum Common {
        public static let cancel = "Cancel"
        public static let error = "Error"
        public static let success = "Success"
        public static let save = "Save"
        public static let continueAction = "Continue"
        public static let reset = "Reset"
        public static let logout = "Logout"
        public static let version = "Version"
        public static let urlPlaceholder = "https://example.com"
        public static let ok = "OK"
        public static let back = "Back"
        public static let authenticate = "Authenticate"
        public static let copied = "Copied"
        public static let delete = "Delete"
        public static let scanning = "Scanning..."
    }

    public enum Status {
        public static let online = "online"
        public static let offline = "offline"
        public static let permissionRequired = "permission required"
        public static let inputRequired = "waiting for your answer"
        public static let unread = "new results"
    }

    public enum Items {
        public static func copiedToClipboard(label: String) -> String { "\(label) copied to clipboard" }
    }

    public enum Onboarding {
        public static let headline = "Claude, Codex, Grok\nin your pocket"
        public static let propEncrypted = "End-to-end encrypted"
        public static let propNoPassword = "No email, no password"
        public static let propOpenSource = "Open source, MIT license"
        public static let createAccount = "Create account"
        public static let restoreExisting = "Restore existing account"
        public static let linkTitle = "Link Your Computer"
        public static let installStep = "Install Happy on your computer"
        public static let installBodyPrefix = "Download Happy from "
        public static let installBodyLink = "happy.engineering"
        public static let installBodySuffix = "."
        public static let openStep = "Open Happy and choose Link\u{00A0}Mobile\u{00A0}App"
        public static let openBody = "It’s the last step of setup on your computer. A QR code appears there."
        public static let scanButton = "Scan QR code"
        public static let pasteLink = "Can’t scan QR code? Paste link instead"
        public static let pasteLinkTitle = "Paste link"
        public static let pasteLinkMessage = "On your computer, choose Copy auth link, then paste it here."
        public static let pasteLinkConfirm = "Link"
        public static let linking = "Linking…"
        public static let linkFailed = "Couldn’t link. Scan the code again."
        public static let terminalComment = "# Prefer the terminal?"
        public static let terminalInstall = "npm install -g happy"
        public static let terminalRun = "happy"
        public static func offlineTitleOne(name: String) -> String { "\(name) is offline" }
        public static let offlineTitleMany = "Your computers are offline"
        public static func offlineLinkedStep(name: String) -> String { "Linked \(name)" }
        public static func offlineLinkedStepMany(count: Int) -> String { "Linked \(count) computers" }
        public static let offlineOpenStep = "Open Happy on your computer"
        public static let offlineOpenBody = "Open Happy Desktop, or run happy in a terminal. This screen updates as soon as it connects."
        public static let offlineTroubleshoot = "Troubleshoot"
        public static let linkAnother = "Link another computer"
        public static let getHelp = "Get help"
        public static let helpMessage = "Stuck? Come ask us."
        public static let helpDiscord = "Ask on Discord"
        public static let helpBra1nDump = "DM @bra1n_dump on X"
        public static let helpEx3ndr = "DM @Ex3NDR on X"
        public static let helpIssues = "Browse known issues"
        public static let settingsTitle = "Settings"
        public static let settingsServer = "Server"
        public static let settingsServerDefault = "Default"
        public static let logoutStartOver = "Log out and start over"
        public static let logoutFooter = "This account has nothing in it yet, so nothing is lost."
        public static let logoutConfirmTitle = "Log out and start over?"
        public static let logoutConfirmBody = "You will go back to Create account. Nothing on your computer changes."
        public static let restoreTitle = "Restore Account"
        public static let restoreScan = "Scan this code with your other phone."
        public static let restoreScanPath = "Happy › Settings › Account › Link New Device"
        public static let restoreUseKey = "Use a secret key instead"
        public static let secretKeyTitle = "Secret Key"
        public static let secretKeyBody = "Paste your secret key. It is in Happy › Settings › Account on your other device."
        public static let restoreButton = "Restore"
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
        public static let title = "Troubleshoot"
        public static let heading = "Happy is not running on your computer"
        public static let intro = "Your phone talks to Happy on your computer. When nothing is running there, everything here is offline."
        public static let awakeStep = "Is the computer awake and online?"
        public static let awakeBody = "Sleep and a dropped connection are the usual causes."
        public static let desktopStep = "Is Happy Desktop open?"
        public static let desktopBodyPrefix = "Open it, or download it from "
        public static let desktopBodyLink = "happy.engineering"
        public static let desktopBodySuffix = ". We recommend it."
        public static let terminalStep = "Using the terminal?"
        public static let terminalBody = "Run happy again. The computer comes back online as soon as it starts."
        public static let terminalComment = "# Not using Happy Desktop?"
        public static let machines = "Machines"
        public static let machineOffline = "Offline"
        public static func bannerTitleOne(name: String) -> String { "\(name) is offline" }
        public static let bannerTitleMany = "All machines offline"
        public static let bannerSubtitle = "Troubleshoot"
        public static let copyAiPrompt = "Copy AI prompt"
        public static let copyAiPromptHint = "Paste it into Claude Code or Codex on your computer to diagnose from the logs."
        public static let copied = "Copied"
        public static let copyFailed = "Could not copy the AI prompt."
    }

    public enum Sidebar {
        public static let sessionsTitle = "Happy"
        public static let showArchived = "Show archived"
        public static let hideArchived = "Hide archived"
    }

    public enum SessionHistory {
        public static let today = "Today"
        public static let yesterday = "Yesterday"
        public static func daysAgo(_ count: Int) -> String { "\(count) \(count == 1 ? "day" : "days") ago" }
    }

    public enum Session {
        public static let newChat = "New chat"
        public static let archiveAction = "Archive"
        public static let actionsTitle = "Session"
    }

    public enum SessionInfo {
        public static let archiveSession = "Archive Session"
        public static let failedToArchiveSession = "Failed to archive session"
        // useSessionQuickActions.ts, not in en.ts.
        public static let botNeedsMachine = "Connect to the bot’s machine to archive it."
    }

    // components/EmptyMainScreen.tsx, not in en.ts.
    public enum EmptyMain {
        public static let noSessionsTitle = "No sessions yet"
        public static let noSessionsDescription = "Start one on a connected machine."
    }

    public enum Connect {
        public static let enterSecretKey = "Please enter a secret key"
        public static let invalidSecretKey = "Invalid secret key. Please check and try again."
        public static let enterUrlManually = "Enter URL manually"
    }

    public enum Settings {
        public static let title = "Settings"
        public static let connectedAccounts = "Connected Accounts"
        public static let connectAccount = "Connect account"
        public static let github = "GitHub"
        public static let features = "Features"
        public static let scanQrCodeToAuthenticate = "Scan QR code to authenticate"
        public static let account = "Account"
        public static let accountSubtitle = "Manage your account details"
        public static let appearance = "Appearance"
        public static let appearanceSubtitle = "Customize how the app looks"
        public static let developer = "Developer"
        public static let developerTools = "Developer Tools"
        public static let about = "About"
        public static let aboutFooter = "Happy Coder is a Codex and Claude Code mobile client. It's fully end-to-end encrypted and your account is stored only on your device. Not affiliated with Anthropic."
        public static let whatsNew = "What's New"
        public static let whatsNewSubtitle = "See the latest updates and improvements"
        public static let reportIssue = "Report an Issue"
        public static let privacyPolicy = "Privacy Policy"
        public static let termsOfService = "Terms of Service"
        public static let eula = "EULA"
        public static func githubConnected(login: String) -> String { "Connected as @\(login)" }
        public static let connectGithubAccount = "Connect your GitHub account"
        public static let usage = "Usage"
        public static let usageSubtitle = "View your API usage and costs"
        // SettingsView.tsx, not in en.ts.
        public static let agents = "Agents"
        public static let agentsSubtitle = "Connected machines and agent defaults"
        public static let claudeCode = "Claude Code"
    }

    /// Where the About rows lead (SettingsView.tsx).
    public enum Links {
        public static let github = URL(string: "https://github.com/slopus/happy")!
        public static let githubDetail = "slopus/happy"
        public static let issues = URL(string: "https://github.com/slopus/happy/issues")!
        public static let privacy = URL(string: "https://happy.engineering/privacy/")!
        public static let terms = URL(string: "https://happy.engineering/terms/")!
        public static let eula = URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!
    }

    public enum SettingsAppearance {
        public static let theme = "Theme"
        public static let themeDescription = "Choose your preferred color scheme"
        public static let themeAdaptive = "Adaptive"
        public static let themeLight = "Light"
        public static let themeDark = "Dark"
        public static let themeAdaptiveDescription = "Match system settings"
        public static let themeLightDescription = "Always use light theme"
        public static let themeDarkDescription = "Always use dark theme"
        public static let chat = "Chat"
        public static let chatDescription = "Customize chat message appearance"
        public static let usageLimitShowRemaining = "Show Quota Remaining"
        public static let usageLimitShowRemainingDescription = "Count plan limits down from full instead of up from empty"
        public static let userMessageBubbleColor = "User Bubble Color"
        public static let userMessageBubbleColorDescription = "Make your messages easier to spot in long chats"
        public static func bubbleColorName(_ color: String) -> String {
            switch color {
            case "blue": "Blue"
            case "green": "Green"
            case "purple": "Purple"
            case "rose": "Rose"
            case "sand": "Sand"
            default: "Gray"
            }
        }
        public static let display = "Display"
        public static let displayDescription = "Control layout and spacing"
        public static let compactToolCalls = "Compact Tool Calls"
        public static let compactToolCallsDescription = "Show non-interactive tool calls as one-line rows; open a row for details"
        public static let showLineNumbersInToolViews = "Show Line Numbers in Tool Views"
        public static let showLineNumbersInToolViewsDescription = "Display line numbers in tool view diffs"
        public static let alwaysShowContextSize = "Show Usage Status"
        public static let alwaysShowContextSizeDescription = "Context and plan usage below the input. Near-limit warnings always show."
        public static let input = "Input"
        public static let inputDescription = "Configure the message input"
        public static let showHarnessIconInSessionHeader = "Show Harness Icon in Session Header"
        public static let showHarnessIconInSessionHeaderDescription = "Display the harness icon in the session header"
        public static let showHarnessIconsInSessionList = "Show Harness Icons in Session List"
        public static let showHarnessIconsInSessionListDescription = "Display harness icons on session-list avatars"
        public static let avatars = "Avatars"
        public static let avatarsDescription = "Choose how generated session avatars look"
        public static let avatarStyle = "Avatar Style"
        public static func avatarStyleName(_ style: String) -> String {
            switch style {
            case "pixelated": "Pixelated"
            case "gradient": "Gradient"
            default: "Brutalist"
            }
        }
        public static let avatarMonochrome = "Black & White Avatars"
        public static let avatarMonochromeDescription = "Render avatars without color"
        // appearance.tsx, not in en.ts.
        public static let fileDiffsSidebar = "File Diffs Sidebar"
        public static let fileDiffsSidebarDescription = "Show git changes next to the chat on desktop"
    }

    public enum SessionsFilter {
        public static let groupingTitle = "Grouping"
        public static let flatList = "Flat List"
        public static let groupByProject = "Group by Project"
    }

    public enum SettingsFeatures {
        public static let experiments = "Experimental"
        public static let experimentsDescription = "Enable experimental features that are still in development. These features may be unstable or change without notice."
        public static let experimentalFeatures = "Experimental Features"
        public static let groupToolCalls = "Group Tool Calls"
        public static let groupToolCallsSubtitle = "Collapse consecutive tool calls into one container"
        // dev/index.tsx, not in en.ts.
        public static let experimentalFeaturesSubtitle = "Rig file browser and Usage page"
    }

    public enum SettingsLanguage {
        public static let title = "Language"
        public static let description = "Choose your preferred language for the app interface. This will sync across all your devices."
        public static let currentLanguage = "Current Language"
        public static let automatic = "Automatic"
        public static let automaticSubtitle = "Detect from device settings"
        public static let needsRestart = "Language Changed"
        public static let needsRestartMessage = "The app needs to restart to apply the new language setting."
    }

    public enum SettingsAccount {
        public static let accountInformation = "Account Information"
        public static let status = "Status"
        public static let statusActive = "Active"
        public static let anonymousId = "Analytics ID"
        public static let publicId = "Public ID"
        public static let notAvailable = "Not available"
        public static let linkNewDevice = "Link New Device"
        public static let linkNewDeviceSubtitle = "Scan QR code to link device"
        public static let profile = "Profile"
        public static let name = "Name"
        public static let github = "GitHub"
        public static let tapToDisconnect = "Tap to disconnect"
        public static let privacy = "Privacy"
        public static let privacyDescription = "Shares usage data, like which features you use and your device type, to help us improve Happy. Never your messages or code."
        public static let analytics = "Analytics"
        public static let analyticsDisabled = "No data is shared"
        public static let analyticsEnabled = "Usage data is shared"
        public static let dangerZone = "Danger Zone"
        public static let server = "Server"
        public static let backup = "Backup"
        public static let backupDescription = "Your secret key is the only way to recover your account. Save it in a secure place like a password manager."
        public static let secretKey = "Secret Key"
        public static let tapToReveal = "Tap to reveal"
        public static let tapToHide = "Tap to hide"
        public static let secretKeyLabel = "SECRET KEY (TAP TO COPY)"
        public static let secretKeyCopied = "Secret key copied to clipboard. Store it in a safe place!"
        public static let logout = "Logout"
        public static let logoutSubtitle = "Sign out and clear local data"
        public static let logoutConfirm = "Are you sure you want to logout? Make sure you have backed up your secret key!"
    }

    /// settings/account.tsx's push section, which en.ts does not cover.
    public enum Push {
        public static let title = "Push Notifications"
        public static let footer = "Shows every push token registered on your account. Tap an old token to delete it."
        public static let permission = "Permission"
        public static let loading = "Loading"
        public static let allowed = "Allowed"
        public static let denied = "Denied"
        public static let notRequested = "Not requested"
        public static let checking = "Checking push notification permissions for this device."
        public static let canReceive = "This device can receive push notifications."
        public static let canAskAgain = "The system prompt can still be shown again from the app."
        public static let stoppedPrompting = "iOS has stopped prompting. Open system settings to enable notifications again."
        public static let requestAgain = "Request Permission Again"
        public static let requestAgainCanAsk = "Shows the system prompt again if iOS still allows it."
        public static let requestAgainSettings = "Opens system settings when iOS will not prompt again."
        public static let enabled = "Push notifications are enabled for this device."
        public static let openSettingsTitle = "Open Settings"
        public static let openedSettings = "The system will not show the permission prompt again, so Happy opened Settings instead."
        public static let notGranted = "Push notification permission was not granted."
        public static let requestFailed = "Failed to request push notification permission."
        public static func registeredTokens(_ count: Int) -> String { "Registered Tokens (\(count))" }
        public static let tokensFooter = "Current-device metadata comes from this phone. Older tokens use their token fingerprint plus server timestamps."
        public static let noTokens = "No registered push tokens"
        public static let noTokensSubtitle = "Once this device is registered, it will appear here."
        public static let deleteTitle = "Delete Push Token"
        public static func deleteMessage(_ fingerprint: String) -> String { "Remove \(fingerprint) from your account?" }
        public static let deleteFailed = "Failed to delete push token."
        public static let loadFailed = "Failed to load push notification settings."
    }

    /// app/(app)/settings/agents.tsx, which en.ts does not cover.
    public enum Agents {
        public static let machines = "Machines"
        public static let noMachines = "No connected machines"
        public static let noMachinesSubtitle = "Run Happy on a computer to connect it"
        public static let defaults = "Defaults"
        public static let clearOverrides = "Clear Overrides"
        public static let clearOverridesSubtitle = "Return every agent to code defaults"
        public static let permission = "Permission"
        public static let model = "Model"
        public static let effort = "Effort"
        public static func defaultValue(_ name: String) -> String { "Default (\(name))" }
        public static let useCodeDefault = "Use code default"
        public static let customModel = "Custom model…"
        public static let customModelSubtitle = "Enter an exact model ID"
        public static let customModelTitle = "Custom Codex model"
        public static let customModelMessage = "Enter an exact model ID. Availability depends on your Codex account or API configuration."
        public static let customModelPlaceholder = "model-id"
    }

    public enum Usage {
        public static let today = "Today"
        public static let last7Days = "Last 7 days"
        public static let last30Days = "Last 30 days"
        public static let totalTokens = "Total Tokens"
        public static let totalCost = "Total Cost"
        public static let tokens = "Tokens"
        public static let cost = "Cost"
        public static let usageOverTime = "Usage over time"
        public static let byModel = "By Model"
        public static let noData = "No usage data available"
        // UsagePanel.tsx, not in en.ts.
        public static let loadFailed = "Failed to load usage data"
    }

    public enum Changelog {
        public static let noEntriesAvailable = "No changelog entries available."
    }

    /// settings/connect/claude.tsx `OAuthViewUnsupported`.
    public enum ConnectClaude {
        public static let title = "Connect Claude"
        public static let instruction = "Run the following command in your terminal:"
        public static let command = "happy connect claude"
    }

    /// The parts of app/(app)/dev/index.tsx this app has.
    public enum Developer {
        public static let appInformation = "App Information"
        public static let version = "Version"
        public static let buildNumber = "Build Number"
        public static let platform = "Platform"
        public static let anonymousId = "Anonymous ID"
        public static let network = "Network"
        public static let apiEndpoint = "API Endpoint"
        public static let socketStatus = "Socket.IO Status"
    }

    public enum Server {
        public static let title = "Server"
        public static let serverUrlLabel = "Server URL"
        public static let selfHostFooter = "For self-hosted servers. Sign out and back in after changing it."
        public static let enterServerUrl = "Please enter a server URL"
        public static let notValidHappyServer = "Not a valid Happy Server"
        public static let changeServer = "Change Server"
        public static let continueWithServer = "Continue with this server?"
        public static let resetToDefault = "Reset to Default"
        public static let resetServerDefault = "Reset server to default?"
        public static let validating = "Validating..."
        public static let validatingServer = "Validating server..."
        public static let serverReturnedError = "Server returned an error"
        public static let failedToConnectToServer = "Failed to connect to server"
        public static let currentlyUsingCustomServer = "Currently using custom server"
        public static let invalidFormat = "Invalid format"
        public static let defaultServer = "Default"
    }

    public enum Modals {
        public static let authenticateTerminal = "Authenticate Terminal"
        public static let pasteUrlFromTerminal = "Paste the authentication URL from your terminal"
        public static let invalidAuthUrl = "Invalid authentication URL"
        public static let failedToConnectTerminal = "Failed to connect terminal"
        public static let terminalConnectedSuccessfully = "Terminal connected successfully"
        public static let deviceLinkedSuccessfully = "Device linked successfully"
        public static let failedToLinkDevice = "Failed to link device"
        public static let cameraPermissionsRequiredToScanQr = "Camera permissions are required to scan QR codes"
        public static let developerMode = "Developer Mode"
        public static let developerModeEnabled = "Developer mode enabled"
        public static let developerModeDisabled = "Developer mode disabled"
        public static let disconnectGithub = "Disconnect GitHub"
        public static let disconnectGithubConfirm = "Are you sure you want to disconnect your GitHub account?"
        public static func disconnectService(_ service: String) -> String { "Disconnect \(service)" }
        public static func disconnectServiceConfirm(_ service: String) -> String { "Are you sure you want to disconnect \(service) from your account?" }
        public static let disconnect = "Disconnect"
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
        public static let authenticationFailed = "Authentication failed"
        public static func disconnectServiceFailed(_ service: String) -> String { "Failed to disconnect \(service)" }
        public static let operationFailed = "Operation failed"
    }
}
