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
        public static let copyAiPrompt = "Copy AI prompt"
        public static let copyAiPromptHint = "Paste it into Claude Code or Codex on your computer to diagnose from the logs."
        public static let copied = "Copied"
        public static let copyFailed = "Could not copy the AI prompt."
    }

    public enum Sidebar {
        public static let sessionsTitle = "Happy"
    }

    public enum Connect {
        public static let enterSecretKey = "Please enter a secret key"
        public static let invalidSecretKey = "Invalid secret key. Please check and try again."
        public static let enterUrlManually = "Enter URL manually"
    }

    public enum Settings {
        public static let title = "Settings"
        public static let scanQrCodeToAuthenticate = "Scan QR code to authenticate"
        public static let account = "Account"
        public static let about = "About"
        public static let aboutFooter = "Happy Coder is a Codex and Claude Code mobile client. It's fully end-to-end encrypted and your account is stored only on your device. Not affiliated with Anthropic."
    }

    public enum SettingsAccount {
        public static let status = "Status"
        public static let statusActive = "Active"
        public static let anonymousId = "Analytics ID"
        public static let linkNewDevice = "Link New Device"
        public static let linkNewDeviceSubtitle = "Scan QR code to link device"
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
    }
}
