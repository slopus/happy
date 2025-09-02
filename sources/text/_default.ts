/**
 * English translations for the Happy app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

/**
 * English plural helper function
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on count
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

export const en = {
    common: {
        // Simple string constants
        cancel: 'Cancel',
        authenticate: 'Authenticate',
        save: 'Save',
        error: 'Error',
        success: 'Success',
        ok: 'OK',
        continue: 'Continue',
        back: 'Back',
        rename: 'Rename',
        reset: 'Reset',
        logout: 'Logout',
        yes: 'Yes',
        no: 'No',
        version: 'Version',
        copied: 'Copied',
        scanning: 'Scanning...',
        urlPlaceholder: 'https://example.com',
        home: 'Home',
        message: 'Message',
        files: 'Files',
        fileViewer: 'File Viewer',
        loading: 'Loading...',
        retry: 'Retry',
    },

    status: {
        connected: 'connected',
        connecting: 'connecting',
        disconnected: 'disconnected',
        error: 'error',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `last seen ${time}`,
        permissionRequired: 'permission required',
        activeNow: 'Active now',
        unknown: 'unknown',
    },

    time: {
        justNow: 'just now',
        minutesAgo: ({ count }: { count: number }) => `${count} minute${count !== 1 ? 's' : ''} ago`,
        hoursAgo: ({ count }: { count: number }) => `${count} hour${count !== 1 ? 's' : ''} ago`,
    },

    connect: {
        restoreAccount: 'Restore Account',
        enterSecretKey: 'Please enter a secret key',
        invalidSecretKey: 'Invalid secret key. Please check and try again.',
        enterUrlManually: 'Enter URL manually',
    },

    settings: {
        title: 'Settings',
        connectedAccounts: 'Connected Accounts',
        github: 'GitHub',
        machines: 'Machines',
        features: 'Features',
        account: 'Account',
        accountSubtitle: 'Manage your account details',
        appearance: 'Appearance',
        appearanceSubtitle: 'Customize how the app looks',
        voiceAssistant: 'Voice Assistant',
        voiceAssistantSubtitle: 'Configure voice interaction preferences',
        featuresTitle: 'Features',
        featuresSubtitle: 'Enable or disable app features',
        developer: 'Developer',
        developerTools: 'Developer Tools',
        about: 'About',
        aboutFooter: 'Happy Coder is a Claude Code mobile client. It\'s fully end-to-end encrypted and your account is stored only on your device. Not affiliated with Anthropic.',
        whatsNew: 'What\'s New',
        whatsNewSubtitle: 'See the latest updates and improvements',
        reportIssue: 'Report an Issue',
        privacyPolicy: 'Privacy Policy',
        termsOfService: 'Terms of Service',
        eula: 'EULA',
        supportUs: 'Support us',
        supportUsSubtitlePro: 'Thank you for your support!',
        supportUsSubtitle: 'Support project development',
        scanQrCodeToAuthenticate: 'Scan QR code to authenticate',
        githubConnected: ({ login }: { login: string }) => `Connected as @${login}`,
        connectGithubAccount: 'Connect your GitHub account',
        claudeAuthSuccess: 'Successfully connected to Claude',
        exchangingTokens: 'Exchanging tokens...',

        // Dynamic settings messages
        accountConnected: ({ service }: { service: string }) => `${service} account connected`,
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} is ${status}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'enabled' : 'disabled'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Theme',
        themeDescription: 'Choose your preferred color scheme',
        themeOptions: {
            adaptive: 'Adaptive',
            light: 'Light', 
            dark: 'Dark',
        },
        themeDescriptions: {
            adaptive: 'Match system settings',
            light: 'Always use light theme',
            dark: 'Always use dark theme',
        },
        display: 'Display',
        displayDescription: 'Control layout and spacing',
        inlineToolCalls: 'Inline Tool Calls',
        inlineToolCallsDescription: 'Display tool calls directly in chat messages',
        expandTodoLists: 'Expand Todo Lists',
        expandTodoListsDescription: 'Show all todos instead of just changes',
        showLineNumbersInDiffs: 'Show Line Numbers in Diffs',
        showLineNumbersInDiffsDescription: 'Display line numbers in code diffs',
        showLineNumbersInToolViews: 'Show Line Numbers in Tool Views',
        showLineNumbersInToolViewsDescription: 'Display line numbers in tool view diffs',
        alwaysShowContextSize: 'Always Show Context Size',
        alwaysShowContextSizeDescription: 'Display context usage even when not near limit',
        avatarStyle: 'Avatar Style',
        avatarStyleDescription: 'Choose session avatar appearance',
        avatarOptions: {
            pixelated: 'Pixelated',
            gradient: 'Gradient',
            brutalist: 'Brutalist',
        },
        compactSessionView: 'Compact Session View',
        compactSessionViewDescription: 'Show active sessions in a more compact layout',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Experiments',
        experimentsDescription: 'Enable experimental features that are still in development. These features may be unstable or change without notice.',
        experimentalFeatures: 'Experimental Features',
        experimentalFeaturesEnabled: 'Experimental features enabled',
        experimentalFeaturesDisabled: 'Using stable features only',
        webFeatures: 'Web Features',
        webFeaturesDescription: 'Features available only in the web version of the app.',
        commandPalette: 'Command Palette',
        commandPaletteEnabled: 'Press ⌘K to open',
        commandPaletteDisabled: 'Quick command access disabled',
    },

    errors: {
        networkError: 'Network error occurred',
        serverError: 'Server error occurred',
        unknownError: 'An unknown error occurred',
        connectionTimeout: 'Connection timed out',
        authenticationFailed: 'Authentication failed',
        permissionDenied: 'Permission denied',
        fileNotFound: 'File not found',
        invalidFormat: 'Invalid format',
        operationFailed: 'Operation failed',
        tryAgain: 'Please try again',
        contactSupport: 'Contact support if the problem persists',
        sessionNotFound: 'Session not found',
        voiceSessionFailed: 'Failed to start voice session',
        oauthInitializationFailed: 'Failed to initialize OAuth flow',
        tokenStorageFailed: 'Failed to store authentication tokens',
        oauthStateMismatch: 'Security validation failed. Please try again',
        tokenExchangeFailed: 'Failed to exchange authorization code',
        oauthAuthorizationDenied: 'Authorization was denied',
        webViewLoadFailed: 'Failed to load authentication page',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} must be between ${min} and ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Retry in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Error ${code})`,
    },

    newSession: {
        // Used by new-session screen and launch flows
        title: 'Start New Session',
        noMachinesFound: 'No machines found. Start a Happy session on your computer first.',
        allMachinesOffline: 'All machines appear offline',
        machineOfflineHelp: {
            computerOnline: '• Is your computer online?',
            daemonRunning: '• Is the Happy daemon running? Check with `happy daemon status`'
        },
        machineDetails: 'View machine details →',
        sessionStarted: 'Session started',
        sessionStartedMessage: 'The session was started but may take a moment to appear.',
        sessionSpawningFailed: 'Session spawning failed - no session ID returned.',
        startingSession: 'Starting session...',
        startNewSessionInFolder: 'Start new session in this folder',
        failedToStart: 'Failed to start session. Make sure the daemon is running on the target machine.',
        sessionTimeout: 'Session startup timed out. The machine may be slow or the daemon may not be responding.',
        notConnectedToServer: 'Not connected to server. Check your internet connection.'
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Session History',
        empty: 'No sessions found',
        today: 'Today',
        yesterday: 'Yesterday',
        daysAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'day' : 'days'} ago`,
        viewAll: 'View all sessions',
    },

    session: {
        inputPlaceholder: 'Type a message ...',
    },

    commandPalette: {
        placeholder: 'Type a command or search...',
    },

    server: {
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: 'Server Configuration',
        enterServerUrl: 'Please enter a server URL',
        notValidHappyServer: 'Not a valid Happy Server',
        changeServer: 'Change Server',
        continueWithServer: 'Continue with this server?',
        resetToDefault: 'Reset to Default',
        resetServerDefault: 'Reset server to default?',
        validating: 'Validating...',
        validatingServer: 'Validating server...',
        serverReturnedError: 'Server returned an error',
        failedToConnectToServer: 'Failed to connect to server',
        currentlyUsingCustomServer: 'Currently using custom server',
        customServerUrlLabel: 'Custom Server URL',
        advancedFeatureFooter: "This is an advanced feature. Only change the server if you know what you're doing. You will need to log out and log in again after changing servers."
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Kill Session',
        killSessionConfirm: 'Are you sure you want to terminate this session?',
        archiveSession: 'Archive Session',
        archiveSessionConfirm: 'Are you sure you want to archive this session?',
        happySessionIdCopied: 'Happy Session ID copied to clipboard',
        failedToCopySessionId: 'Failed to copy Happy Session ID',
        happySessionId: 'Happy Session ID',
        claudeCodeSessionId: 'Claude Code Session ID',
        claudeCodeSessionIdCopied: 'Claude Code Session ID copied to clipboard',
        failedToCopyClaudeCodeSessionId: 'Failed to copy Claude Code Session ID',
        metadataCopied: 'Metadata copied to clipboard',
        failedToCopyMetadata: 'Failed to copy metadata',
        failedToKillSession: 'Failed to kill session',
        failedToArchiveSession: 'Failed to archive session',
        connectionStatus: 'Connection Status',
        created: 'Created',
        lastUpdated: 'Last Updated',
        sequence: 'Sequence',
        quickActions: 'Quick Actions',
        viewMachine: 'View Machine',
        viewMachineSubtitle: 'View machine details and sessions',
        killSessionSubtitle: 'Immediately terminate the session',
        archiveSessionSubtitle: 'Archive this session and stop it',
        metadata: 'Metadata',
        host: 'Host',
        path: 'Path',
        operatingSystem: 'Operating System',
        processId: 'Process ID',
        happyHome: 'Happy Home',
        copyMetadata: 'Copy Metadata',
        agentState: 'Agent State',
        controlledByUser: 'Controlled by User',
        pendingRequests: 'Pending Requests',
        activity: 'Activity',
        thinking: 'Thinking',
        thinkingSince: 'Thinking Since',
        
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Ready to code?',
            installCli: 'Install the Happy CLI',
            runIt: 'Run it',
            scanQrCode: 'Scan the QR code',
            openCamera: 'Open Camera',
        },
    },

    agentInput: {
        permissionMode: {
            title: 'PERMISSION MODE',
            default: 'Default',
            acceptEdits: 'Accept Edits',
            plan: 'Plan Mode',
            bypassPermissions: 'Yolo Mode',
            badgeAcceptAllEdits: 'Accept All Edits',
            badgeBypassAllPermissions: 'Bypass All Permissions',
            badgePlanMode: 'Plan Mode',
        },
        model: {
            title: 'MODEL',
            default: 'Use CLI settings',
            adaptiveUsage: 'Opus up to 50% usage, then Sonnet',
            sonnet: 'Sonnet',
            opus: 'Opus',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% left`,
        },
        suggestion: {
            fileLabel: 'FILE',
            folderLabel: 'FOLDER',
        }
    },

    machineLauncher: {
        showLess: 'Show less',
        showAll: ({ count }: { count: number }) => `Show all (${count} paths)`,
        enterCustomPath: 'Enter custom path',
        offlineUnableToSpawn: 'Unable to spawn new session, offline',
    },

    sidebar: {
        sessionsTitle: 'Sessions',
    },

    toolView: {
        input: 'Input',
        output: 'Output',
    },

    tools: {
        fullView: {
            description: 'Description',
            inputParams: 'Input Parameters',
            output: 'Output',
            error: 'Error',
            completed: 'Tool completed successfully',
            noOutput: 'No output was produced',
            running: 'Tool is running...',
            rawJsonDevMode: 'Raw JSON (Dev Mode)',
        },
        taskView: {
            initializing: 'Initializing agent...',
            moreTools: ({ count }: { count: number }) => `+${count} more ${plural({ count, singular: 'tool', plural: 'tools' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Edit ${index} of ${total}`,
            replaceAll: 'Replace All',
        },
        names: {
            task: 'Task',
            terminal: 'Terminal',
            searchFiles: 'Search Files',
            search: 'Search',
            searchContent: 'Search Content',
            listFiles: 'List Files',
            planProposal: 'Plan proposal',
            readFile: 'Read File',
            editFile: 'Edit File',
            writeFile: 'Write File',
            fetchUrl: 'Fetch URL',
            readNotebook: 'Read Notebook',
            editNotebook: 'Edit Notebook',
            todoList: 'Todo List',
            webSearch: 'Web Search',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Search(pattern: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Search(path: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Fetch URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Edit Notebook(file: ${path}, mode: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Todo List(count: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Web Search(query: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(pattern: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} edits)`,
        }
    },

    files: {
        searchPlaceholder: 'Search files...',
        detachedHead: 'detached HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} staged • ${unstaged} unstaged`,
        notRepo: 'Not a git repository',
        notUnderGit: 'This directory is not under git version control',
        searching: 'Searching files...',
        noFilesFound: 'No files found',
        noFilesInProject: 'No files in project',
        tryDifferentTerm: 'Try a different search term',
        searchResults: ({ count }: { count: number }) => `Search Results (${count})`,
        projectRoot: 'Project root',
        stagedChanges: ({ count }: { count: number }) => `Staged Changes (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Unstaged Changes (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Loading ${fileName}...`,
        binaryFile: 'Binary File',
        cannotDisplayBinary: 'Cannot display binary file content',
        diff: 'Diff',
        file: 'File',
        fileEmpty: 'File is empty',
        noChanges: 'No changes to display',
    },

    settingsVoice: {
        // Voice settings screen
        languageTitle: 'Language',
        languageDescription: 'Choose your preferred language for voice assistant interactions. This setting syncs across all your devices.',
        preferredLanguage: 'Preferred Language',
        preferredLanguageSubtitle: 'Language used for voice assistant responses',
        language: {
            searchPlaceholder: 'Search languages...',
            title: 'Languages',
            footer: ({ count }: { count: number }) => `${count} ${plural({ count, singular: 'language', plural: 'languages' })} available`,
            autoDetect: 'Auto-detect',
        }
    },

    settingsAccount: {
        // Account settings screen
        accountInformation: 'Account Information',
        status: 'Status',
        statusActive: 'Active',
        statusNotAuthenticated: 'Not Authenticated',
        anonymousId: 'Anonymous ID',
        publicId: 'Public ID',
        notAvailable: 'Not available',
        linkNewDevice: 'Link New Device',
        linkNewDeviceSubtitle: 'Scan QR code to link device',
        profile: 'Profile',
        name: 'Name',
        github: 'GitHub',
        tapToDisconnect: 'Tap to disconnect',
        server: 'Server',
        backup: 'Backup',
        backupDescription: 'Your secret key is the only way to recover your account. Save it in a secure place like a password manager.',
        secretKey: 'Secret Key',
        tapToReveal: 'Tap to reveal',
        tapToHide: 'Tap to hide',
        secretKeyLabel: 'SECRET KEY (TAP TO COPY)',
        secretKeyCopied: 'Secret key copied to clipboard. Store it in a safe place!',
        secretKeyCopyFailed: 'Failed to copy secret key',
        privacy: 'Privacy',
        privacyDescription: 'Help improve the app by sharing anonymous usage data. No personal information is collected.',
        analytics: 'Analytics',
        analyticsDisabled: 'No data is shared',
        analyticsEnabled: 'Anonymous usage data is shared',
        dangerZone: 'Danger Zone',
        logout: 'Logout',
        logoutSubtitle: 'Sign out and clear local data',
        logoutConfirm: 'Are you sure you want to logout? Make sure you have backed up your secret key!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Language',
        description: 'Choose your preferred language for the app interface. This will sync across all your devices.',
        currentLanguage: 'Current Language',
        automatic: 'Automatic',
        automaticSubtitle: 'Detect from device settings',
        needsRestart: 'Language Changed',
        needsRestartMessage: 'The app needs to restart to apply the new language setting.',
        restartNow: 'Restart Now',
    },

    connectButton: {
        authenticate: 'Authenticate Terminal',
        authenticateWithUrlPaste: 'Authenticate Terminal with URL paste',
        pasteAuthUrl: 'Paste the auth URL from your terminal',
    },

    updateBanner: {
        updateAvailable: 'Update available',
        pressToApply: 'Press to apply the update',
        whatsNew: "What's new",
        seeLatest: 'See the latest updates and improvements',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Version ${version}`,
        noEntriesAvailable: 'No changelog entries available.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Web Browser Required',
        webBrowserRequiredDescription: 'Terminal connection links can only be opened in a web browser for security reasons. Please use the QR code scanner or open this link on a computer.',
        processingConnection: 'Processing connection...',
        invalidConnectionLink: 'Invalid Connection Link',
        invalidConnectionLinkDescription: 'The connection link is missing or invalid. Please check the URL and try again.',
        connectTerminal: 'Connect Terminal',
        terminalRequestDescription: 'A terminal is requesting to connect to your Happy Coder account. This will allow the terminal to send and receive messages securely.',
        connectionDetails: 'Connection Details',
        publicKey: 'Public Key',
        encryption: 'Encryption',
        endToEndEncrypted: 'End-to-end encrypted',
        acceptConnection: 'Accept Connection',
        connecting: 'Connecting...',
        reject: 'Reject',
        security: 'Security',
        securityFooter: 'This connection link was processed securely in your browser and was never sent to any server. Your private data will remain secure and only you can decrypt the messages.',
        securityFooterDevice: 'This connection was processed securely on your device and was never sent to any server. Your private data will remain secure and only you can decrypt the messages.',
        clientSideProcessing: 'Client-Side Processing',
        linkProcessedLocally: 'Link processed locally in browser',
        linkProcessedOnDevice: 'Link processed locally on device',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Authenticate Terminal',
        pasteUrlFromTerminal: 'Paste the authentication URL from your terminal',
        deviceLinkedSuccessfully: 'Device linked successfully',
        terminalConnectedSuccessfully: 'Terminal connected successfully',
        invalidAuthUrl: 'Invalid authentication URL',
        developerMode: 'Developer Mode',
        developerModeEnabled: 'Developer mode enabled',
        developerModeDisabled: 'Developer mode disabled',
        disconnectGithub: 'Disconnect GitHub',
        disconnectGithubConfirm: 'Are you sure you want to disconnect your GitHub account?',
        disconnect: 'Disconnect',
        failedToConnectTerminal: 'Failed to connect terminal',
        cameraPermissionsRequiredToConnectTerminal: 'Camera permissions are required to connect terminal',
        failedToLinkDevice: 'Failed to link device',
        cameraPermissionsRequiredToScanQr: 'Camera permissions are required to scan QR codes'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Connect Terminal',
        linkNewDevice: 'Link New Device', 
        restoreWithSecretKey: 'Restore with Secret Key',
        whatsNew: "What's New",
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Claude Code mobile client',
        subtitle: 'End-to-end encrypted and your account is stored only on your device.',
        createAccount: 'Create account',
        linkOrRestoreAccount: 'Link or restore account',
        loginWithMobileApp: 'Login with mobile app',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Enjoying the app?',
        feedbackPrompt: "We'd love to hear your feedback!",
        yesILoveIt: 'Yes, I love it!',
        notReally: 'Not really'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copied to clipboard`
    },

    machine: {
        launchNewSessionInDirectory: 'Launch New Session in Directory',
        daemon: 'Daemon',
        status: 'Status',
        stopDaemon: 'Stop Daemon',
        lastKnownPid: 'Last Known PID',
        lastKnownHttpPort: 'Last Known HTTP Port',
        startedAt: 'Started At',
        cliVersion: 'CLI Version',
        daemonStateVersion: 'Daemon State Version',
        activeSessions: ({ count }: { count: number }) => `Active Sessions (${count})`,
        machineGroup: 'Machine',
        host: 'Host',
        machineId: 'Machine ID',
        username: 'Username',
        homeDirectory: 'Home Directory',
        platform: 'Platform',
        architecture: 'Architecture',
        lastSeen: 'Last Seen',
        never: 'Never',
        metadataVersion: 'Metadata Version',
        untitledSession: 'Untitled Session',
        back: 'Back',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Switched to ${mode} mode`,
        unknownEvent: 'Unknown event',
        usageLimitUntil: ({ time }: { time: string }) => `Usage limit reached until ${time}`,
        unknownTime: 'unknown time',
    }
} as const;

export type Translations = typeof en;

/**
 * Generic translation type that matches the structure of Translations
 * but allows different string values (for other languages)
 */
export type TranslationStructure = {
    readonly [K in keyof Translations]: {
        readonly [P in keyof Translations[K]]: Translations[K][P] extends string 
            ? string 
            : Translations[K][P] extends (...args: any[]) => string 
                ? Translations[K][P] 
                : Translations[K][P] extends object
                    ? {
                        readonly [Q in keyof Translations[K][P]]: Translations[K][P][Q] extends string
                            ? string
                            : Translations[K][P][Q]
                      }
                    : Translations[K][P]
    }
};
