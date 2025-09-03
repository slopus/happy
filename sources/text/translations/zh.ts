/**
 * 中文（简体）翻译文件 - Happy 应用
 * 值可以是：
 * - 静态文本的字符串常量
 * - 带有类型化对象参数的动态文本函数
 */

/**
 * 中文复数辅助函数
 * 中文不区分单复数，所以直接返回单数形式
 * @param options - 包含count、singular和plural形式的对象
 * @returns 适当的形式
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    // 中文不区分单复数，但保持函数结构以匹配类型系统
    return singular;
}

export const zh = {
    common: {
        // 简单字符串常量
        cancel: '取消',
        authenticate: '认证',
        save: '保存',
        error: '错误',
        success: '成功',
        ok: '确定',
        continue: '继续',
        back: '返回',
        create: '创建',
        rename: '重命名',
        reset: '重置',
        logout: '登出',
        yes: '是',
        no: '否',
        version: '版本',
        copied: '已复制',
        scanning: '正在扫描...',
        urlPlaceholder: 'https://example.com',
        home: '主页',
        message: '消息',
        files: '文件',
        fileViewer: '文件查看器',
        loading: '加载中...',
        retry: '重试',
    },

    status: {
        connected: '已连接',
        connecting: '连接中',
        disconnected: '已断开',
        error: '错误',
        online: '在线',
        offline: '离线',
        lastSeen: ({ time }: { time: string }) => `最后在线 ${time}`,
        permissionRequired: '需要权限',
        activeNow: '当前活跃',
        unknown: '未知',
    },

    time: {
        justNow: '刚刚',
        minutesAgo: ({ count }: { count: number }) => `${count} 分钟前`,
        hoursAgo: ({ count }: { count: number }) => `${count} 小时前`,
    },

    connect: {
        restoreAccount: '恢复账户',
        enterSecretKey: '请输入密钥',
        invalidSecretKey: '密钥无效。请检查后重试。',
        enterUrlManually: '手动输入 URL',
    },

    settings: {
        title: '设置',
        connectedAccounts: '已连接账户',
        connectAccount: '连接账户',
        github: 'GitHub',
        machines: '设备',
        features: '功能',
        account: '账户',
        accountSubtitle: '管理您的账户详情',
        appearance: '外观',
        appearanceSubtitle: '自定义应用外观',
        voiceAssistant: '语音助手',
        voiceAssistantSubtitle: '配置语音交互首选项',
        featuresTitle: '功能',
        featuresSubtitle: '启用或禁用应用功能',
        developer: '开发者',
        developerTools: '开发者工具',
        about: '关于',
        aboutFooter: 'Happy Coder 是一个 Claude Code 移动客户端。它完全端到端加密，您的账户仅存储在您的设备上。与 Anthropic 无关。',
        whatsNew: '新功能',
        whatsNewSubtitle: '查看最新更新和改进',
        reportIssue: '报告问题',
        privacyPolicy: '隐私政策',
        termsOfService: '服务条款',
        eula: '最终用户许可协议',
        supportUs: '支持我们',
        supportUsSubtitlePro: '感谢您的支持！',
        supportUsSubtitle: '支持项目开发',
        scanQrCodeToAuthenticate: '扫描 QR 码进行认证',
        githubConnected: ({ login }: { login: string }) => `已连接为 @${login}`,
        connectGithubAccount: '连接您的 GitHub 账户',
        claudeAuthSuccess: '成功连接到 Claude',
        exchangingTokens: '正在交换令牌...',

        // 动态设置消息
        accountConnected: ({ service }: { service: string }) => `${service} 账户已连接`,
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} 当前${status === 'online' ? '在线' : '离线'}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} 已${enabled ? '启用' : '禁用'}`,
    },

    settingsAppearance: {
        // 外观设置屏幕
        theme: '主题',
        themeDescription: '选择您偏好的配色方案',
        themeOptions: {
            adaptive: '自适应',
            light: '浅色主题', 
            dark: '深色主题',
        },
        themeDescriptions: {
            adaptive: '跟随系统设置',
            light: '始终使用浅色主题',
            dark: '始终使用深色主题',
        },
        display: '显示',
        displayDescription: '控制布局和间距',
        inlineToolCalls: '内联工具调用',
        inlineToolCallsDescription: '在聊天消息中直接显示工具调用',
        expandTodoLists: '展开待办事项列表',
        expandTodoListsDescription: '显示所有待办事项而不仅仅是更改',
        showLineNumbersInDiffs: '在差异中显示行号',
        showLineNumbersInDiffsDescription: '在代码差异中显示行号',
        showLineNumbersInToolViews: '在工具视图中显示行号',
        showLineNumbersInToolViewsDescription: '在工具视图差异中显示行号',
        alwaysShowContextSize: '始终显示上下文大小',
        alwaysShowContextSizeDescription: '即使未接近限制也显示上下文使用情况',
        avatarStyle: '头像样式',
        avatarStyleDescription: '选择会话头像外观',
        avatarOptions: {
            pixelated: '像素化',
            gradient: '渐变',
            brutalist: '粗野主义',
        },
        compactSessionView: '紧凑会话视图',
        compactSessionViewDescription: '以更紧凑的布局显示活跃会话',
    },

    settingsFeatures: {
        // 功能设置屏幕
        experiments: '实验性功能',
        experimentsDescription: '启用仍在开发中的实验性功能。这些功能可能不稳定或会在没有通知的情况下更改。',
        experimentalFeatures: '实验性功能',
        experimentalFeaturesEnabled: '实验性功能已启用',
        experimentalFeaturesDisabled: '仅使用稳定功能',
        webFeatures: 'Web 功能',
        webFeaturesDescription: '仅在应用的 Web 版本中可用的功能。',
        commandPalette: '命令面板',
        commandPaletteEnabled: '按 ⌘K 打开',
        commandPaletteDisabled: '快速命令访问已禁用',
    },

    errors: {
        networkError: '网络错误',
        serverError: '服务器错误',
        unknownError: '发生未知错误',
        connectionTimeout: '连接超时',
        authenticationFailed: '认证失败',
        permissionDenied: '权限被拒绝',
        fileNotFound: '文件未找到',
        invalidFormat: '格式无效',
        operationFailed: '操作失败',
        tryAgain: '请重试',
        contactSupport: '如果问题持续存在，请联系支持',
        sessionNotFound: '会话未找到',
        voiceSessionFailed: '启动语音会话失败',
        oauthInitializationFailed: '初始化 OAuth 流程失败',
        tokenStorageFailed: '存储认证令牌失败',
        oauthStateMismatch: '安全验证失败。请重试',
        tokenExchangeFailed: '交换授权码失败',
        oauthAuthorizationDenied: '授权被拒绝',
        webViewLoadFailed: '加载认证页面失败',

        // 带上下文的错误函数
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}：${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} 必须在 ${min} 和 ${max} 之间`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `${seconds} 秒后重试`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message}（错误 ${code}）`,
        disconnectServiceFailed: ({ service }: { service: string }) => 
            `断开 ${service} 失败`,
        connectServiceFailed: ({ service }: { service: string }) =>
            `连接 ${service} 失败。请重试。`,
    },

    newSession: {
        // 新会话屏幕和启动流程使用
        title: '开始新会话',
        noMachinesFound: '未找到设备。请先在您的计算机上启动 Happy 会话。',
        allMachinesOffline: '所有设备都离线',
        machineDetails: '查看设备详情 →',
        directoryDoesNotExist: '目录不存在',
        createDirectoryConfirm: ({ directory }: { directory: string }) => `目录 ${directory} 不存在。您想要创建它吗？`,
        sessionStarted: '会话已启动',
        sessionStartedMessage: '会话已成功启动。',
        sessionSpawningFailed: '会话生成失败 - 未返回会话 ID。',
        startingSession: '正在启动会话...',
        startNewSessionInFolder: '在此文件夹中启动新会话',
        failedToStart: '启动会话失败。确保守护进程在目标设备上运行。',
        sessionTimeout: '会话启动超时。设备可能响应缓慢或守护进程可能没有响应。',
        notConnectedToServer: '未连接到服务器。请检查您的网络连接。'
    },

    sessionHistory: {
        // 会话历史屏幕使用
        title: '会话历史',
        empty: '未找到会话',
        today: '今天',
        yesterday: '昨天',
        daysAgo: ({ count }: { count: number }) => `${count} 天前`,
        viewAll: '查看所有会话',
    },

    session: {
        inputPlaceholder: '输入消息...',
    },

    commandPalette: {
        placeholder: '输入命令或搜索...',
    },

    server: {
        // 服务器配置屏幕使用
        serverConfiguration: '服务器配置',
        enterServerUrl: '请输入服务器 URL',
        notValidHappyServer: '不是有效的 Happy 服务器',
        changeServer: '更改服务器',
        continueWithServer: '继续使用此服务器？',
        resetToDefault: '重置为默认',
        resetServerDefault: '将服务器重置为默认？',
        validating: '验证中...',
        validatingServer: '验证服务器中...',
        serverReturnedError: '服务器返回错误',
        failedToConnectToServer: '连接服务器失败',
        currentlyUsingCustomServer: '当前使用自定义服务器',
        customServerUrlLabel: '自定义服务器 URL',
        advancedFeatureFooter: "这是一个高级功能。只有在您知道自己在做什么时才更改服务器。更改服务器后您需要重新登出和登入。"
    },

    sessionInfo: {
        // 会话信息屏幕使用
        killSession: '终止会话',
        killSessionConfirm: '您确定要终止此会话吗？',
        archiveSession: '归档会话',
        archiveSessionConfirm: '您确定要归档此会话吗？',
        happySessionIdCopied: 'Happy 会话 ID 已复制到剪贴板',
        failedToCopySessionId: '复制 Happy 会话 ID 失败',
        happySessionId: 'Happy 会话 ID',
        claudeCodeSessionId: 'Claude Code 会话 ID',
        claudeCodeSessionIdCopied: 'Claude Code 会话 ID 已复制到剪贴板',
        failedToCopyClaudeCodeSessionId: '复制 Claude Code 会话 ID 失败',
        metadataCopied: '元数据已复制到剪贴板',
        failedToCopyMetadata: '复制元数据失败',
        failedToKillSession: '终止会话失败',
        failedToArchiveSession: '归档会话失败',
        connectionStatus: '连接状态',
        created: '创建时间',
        lastUpdated: '最后更新',
        sequence: '序列',
        quickActions: '快捷操作',
        viewMachine: '查看设备',
        viewMachineSubtitle: '查看设备详情和会话',
        killSessionSubtitle: '立即终止会话',
        archiveSessionSubtitle: '归档此会话并停止它',
        metadata: '元数据',
        host: '主机',
        path: '路径',
        operatingSystem: '操作系统',
        processId: '进程 ID',
        happyHome: 'Happy 主目录',
        copyMetadata: '复制元数据',
        agentState: 'Agent 状态',
        controlledByUser: '用户控制',
        pendingRequests: '待处理请求',
        activity: '活动',
        thinking: '思考中',
        thinkingSince: '思考开始时间',
        cliVersion: 'CLI 版本',
        cliVersionOutdated: '需要更新 CLI',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `已安装版本 ${currentVersion}。请更新到 ${requiredVersion} 或更高版本`,
        updateCliInstructions: '请运行 npm install -g happy-coder@latest',
        
    },

    components: {
        emptyMainScreen: {
            // 空主屏幕组件使用
            readyToCode: '准备开始编程？',
            installCli: '安装 Happy CLI',
            runIt: '运行它',
            scanQrCode: '扫描 QR 码',
            openCamera: '打开相机',
        },
    },

    agentInput: {
        permissionMode: {
            title: '权限模式',
            default: '默认',
            acceptEdits: '接受编辑',
            plan: '计划模式',
            bypassPermissions: 'Yolo 模式',
            badgeAcceptAllEdits: '接受所有编辑',
            badgeBypassAllPermissions: '绕过所有权限',
            badgePlanMode: '计划模式',
        },
        model: {
            title: '模型',
            default: '使用 CLI 设置',
            adaptiveUsage: 'Opus 使用到 50%，然后切换到 Sonnet',
            sonnet: 'Sonnet',
            opus: 'Opus',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `剩余 ${percent}%`,
        },
        suggestion: {
            fileLabel: '文件',
            folderLabel: '文件夹',
        }
    },

    machineLauncher: {
        showLess: '显示较少',
        showAll: ({ count }: { count: number }) => `显示全部（${count} 个路径）`,
        enterCustomPath: '输入自定义路径',
        offlineUnableToSpawn: '离线状态，无法生成新会话',
    },

    sidebar: {
        sessionsTitle: '会话',
    },

    toolView: {
        input: '输入',
        output: '输出',
    },

    tools: {
        fullView: {
            description: '描述',
            inputParams: '输入参数',
            output: '输出',
            error: '错误',
            completed: '工具执行成功',
            noOutput: '未产生输出',
            running: '工具运行中...',
            rawJsonDevMode: '原始 JSON（开发模式）',
        },
        taskView: {
            initializing: '正在初始化 agent...',
            moreTools: ({ count }: { count: number }) => `+${count} 个工具`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `编辑 ${index}/${total}`,
            replaceAll: '全部替换',
        },
        names: {
            task: '任务',
            terminal: '终端',
            searchFiles: '搜索文件',
            search: '搜索',
            searchContent: '搜索内容',
            listFiles: '列出文件',
            planProposal: '计划提案',
            readFile: '读取文件',
            editFile: '编辑文件',
            writeFile: '写入文件',
            fetchUrl: '获取 URL',
            readNotebook: '读取笔记本',
            editNotebook: '编辑笔记本',
            todoList: '待办事项列表',
            webSearch: 'Web 搜索',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `终端（命令：${cmd}）`,
            searchPattern: ({ pattern }: { pattern: string }) => `搜索（模式：${pattern}）`,
            searchPath: ({ basename }: { basename: string }) => `搜索（路径：${basename}）`,
            fetchUrlHost: ({ host }: { host: string }) => `获取 URL（地址：${host}）`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `编辑笔记本（文件：${path}，模式：${mode}）`,
            todoListCount: ({ count }: { count: number }) => `待办事项列表（${count} 项）`,
            webSearchQuery: ({ query }: { query: string }) => `Web 搜索（查询：${query}）`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep（模式：${pattern}）`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path}（${count} 处编辑）`,
        }
    },

    files: {
        searchPlaceholder: '搜索文件...',
        detachedHead: '分离的 HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} 个已暂存 • ${unstaged} 个未暂存`,
        notRepo: '不是 git 仓库',
        notUnderGit: '此目录不受 git 版本控制',
        searching: '搜索文件中...',
        noFilesFound: '未找到文件',
        noFilesInProject: '项目中无文件',
        tryDifferentTerm: '尝试不同的搜索词',
        searchResults: ({ count }: { count: number }) => `搜索结果（${count}）`,
        projectRoot: '项目根目录',
        stagedChanges: ({ count }: { count: number }) => `已暂存更改（${count}）`,
        unstagedChanges: ({ count }: { count: number }) => `未暂存更改（${count}）`,
        // 文件查看器字符串
        loadingFile: ({ fileName }: { fileName: string }) => `正在加载 ${fileName}...`,
        binaryFile: '二进制文件',
        cannotDisplayBinary: '无法显示二进制文件内容',
        diff: '差异',
        file: '文件',
        fileEmpty: '文件为空',
        noChanges: '没有更改可显示',
    },

    settingsVoice: {
        // 语音设置屏幕
        languageTitle: '语言',
        languageDescription: '选择您偏好的语音助手交互语言。此设置会在您的所有设备间同步。',
        preferredLanguage: '偏好语言',
        preferredLanguageSubtitle: '语音助手回应使用的语言',
        language: {
            searchPlaceholder: '搜索语言...',
            title: '语言',
            footer: ({ count }: { count: number }) => `${count} 种语言可用`,
            autoDetect: '自动检测',
        }
    },

    settingsAccount: {
        // 账户设置屏幕
        accountInformation: '账户信息',
        status: '状态',
        statusActive: '活跃',
        statusNotAuthenticated: '未认证',
        anonymousId: '匿名 ID',
        publicId: '公共 ID',
        notAvailable: '不可用',
        linkNewDevice: '链接新设备',
        linkNewDeviceSubtitle: '扫描 QR 码链接设备',
        profile: '个人资料',
        name: '姓名',
        github: 'GitHub',
        tapToDisconnect: '点击断开连接',
        server: '服务器',
        backup: '备份',
        backupDescription: '您的密钥是恢复账户的唯一方法。请将其保存在安全的地方，如密码管理器中。',
        secretKey: '密钥',
        tapToReveal: '点击显示',
        tapToHide: '点击隐藏',
        secretKeyLabel: '密钥（点击复制）',
        secretKeyCopied: '密钥已复制到剪贴板。请将其存储在安全的地方！',
        secretKeyCopyFailed: '复制密钥失败',
        privacy: '隐私',
        privacyDescription: '通过分享匿名使用数据帮助改进应用。不会收集个人信息。',
        analytics: '分析',
        analyticsDisabled: '不分享数据',
        analyticsEnabled: '分享匿名使用数据',
        dangerZone: '危险区域',
        logout: '登出',
        logoutSubtitle: '登出并清除本地数据',
        logoutConfirm: '您确定要登出吗？请确保您已备份您的密钥！',
    },

    settingsLanguage: {
        // 语言设置屏幕
        title: '语言',
        description: '选择您偏好的应用界面语言。此设置会在您的所有设备间同步。',
        currentLanguage: '当前语言',
        automatic: '自动',
        automaticSubtitle: '从设备设置检测',
        needsRestart: '语言已更改',
        needsRestartMessage: '应用需要重启以应用新的语言设置。',
        restartNow: '立即重启',
    },

    connectButton: {
        authenticate: '认证终端',
        authenticateWithUrlPaste: '通过 URL 粘贴认证终端',
        pasteAuthUrl: '从您的终端粘贴认证 URL',
    },

    updateBanner: {
        updateAvailable: '有可用更新',
        pressToApply: '点击应用更新',
        whatsNew: "新功能",
        seeLatest: '查看最新更新和改进',
        nativeUpdateAvailable: '应用更新可用',
        tapToUpdateAppStore: '点击在 App Store 中更新',
        tapToUpdatePlayStore: '点击在 Play Store 中更新',
    },

    changelog: {
        // 更新日志屏幕使用
        version: ({ version }: { version: number }) => `版本 ${version}`,
        noEntriesAvailable: '没有可用的更新日志条目。',
    },

    terminal: {
        // 终端连接屏幕使用
        webBrowserRequired: '需要 Web 浏览器',
        webBrowserRequiredDescription: '出于安全原因，终端连接链接只能在 Web 浏览器中打开。请使用 QR 码扫描器或在计算机上打开此链接。',
        processingConnection: '正在处理连接...',
        invalidConnectionLink: '无效的连接链接',
        invalidConnectionLinkDescription: '连接链接缺失或无效。请检查 URL 并重试。',
        connectTerminal: '连接终端',
        terminalRequestDescription: '终端正在请求连接到您的 Happy Coder 账户。这将允许终端安全地发送和接收消息。',
        connectionDetails: '连接详情',
        publicKey: '公钥',
        encryption: '加密',
        endToEndEncrypted: '端到端加密',
        acceptConnection: '接受连接',
        connecting: '连接中...',
        reject: '拒绝',
        security: '安全',
        securityFooter: '此连接链接已在您的浏览器中安全处理，从未发送到任何服务器。您的私人数据将保持安全，只有您可以解密消息。',
        securityFooterDevice: '此连接已在您的设备上安全处理，从未发送到任何服务器。您的私人数据将保持安全，只有您可以解密消息。',
        clientSideProcessing: '客户端处理',
        linkProcessedLocally: '链接在浏览器本地处理',
        linkProcessedOnDevice: '链接在设备本地处理',
    },

    modals: {
        // 连接流程和设置中使用
        authenticateTerminal: '认证终端',
        pasteUrlFromTerminal: '从您的终端粘贴认证 URL',
        deviceLinkedSuccessfully: '设备链接成功',
        terminalConnectedSuccessfully: '终端连接成功',
        invalidAuthUrl: '认证 URL 无效',
        developerMode: '开发者模式',
        developerModeEnabled: '开发者模式已启用',
        developerModeDisabled: '开发者模式已禁用',
        disconnectGithub: '断开 GitHub',
        disconnectGithubConfirm: '您确定要断开您的 GitHub 账户吗？',
        disconnectService: ({ service }: { service: string }) => 
            `断开 ${service}`,
        disconnectServiceConfirm: ({ service }: { service: string }) => 
            `您确定要从您的账户断开 ${service} 吗？`,
        disconnect: '断开连接',
        failedToConnectTerminal: '连接终端失败',
        cameraPermissionsRequiredToConnectTerminal: '连接终端需要相机权限',
        failedToLinkDevice: '链接设备失败',
        cameraPermissionsRequiredToScanQr: '扫描 QR 码需要相机权限'
    },

    navigation: {
        // 导航标题和屏幕标头
        connectTerminal: '连接终端',
        linkNewDevice: '链接新设备', 
        restoreWithSecretKey: '使用密钥恢复',
        whatsNew: "新功能",
    },

    welcome: {
        // 未认证用户的主欢迎屏幕
        title: 'Claude Code 移动客户端',
        subtitle: '端到端加密，您的账户仅存储在您的设备上。',
        createAccount: '创建账户',
        linkOrRestoreAccount: '链接或恢复账户',
        loginWithMobileApp: '使用移动应用登录',
    },

    review: {
        // utils/requestReview.ts 使用
        enjoyingApp: '喜欢这个应用吗？',
        feedbackPrompt: "我们想听听您的反馈！",
        yesILoveIt: '是的，我很喜欢！',
        notReally: '不太喜欢'
    },

    items: {
        // Item 组件的复制提示使用
        copiedToClipboard: ({ label }: { label: string }) => `${label} 已复制到剪贴板`
    },

    machine: {
        launchNewSessionInDirectory: '在目录中启动新会话',
        offlineUnableToSpawn: '设备离线时启动器被禁用',
        offlineHelp: '• 确保您的计算机在线\\n• 运行 `happy daemon status` 进行诊断\\n• 您运行的是最新 CLI 版本吗？使用 `npm install -g happy-coder@latest` 升级',
        daemon: '守护进程',
        status: '状态',
        stopDaemon: '停止守护进程',
        lastKnownPid: '最后已知 PID',
        lastKnownHttpPort: '最后已知 HTTP 端口',
        startedAt: '启动时间',
        cliVersion: 'CLI 版本',
        daemonStateVersion: '守护进程状态版本',
        activeSessions: ({ count }: { count: number }) => `活跃会话（${count}）`,
        machineGroup: '设备',
        host: '主机',
        machineId: '设备 ID',
        username: '用户名',
        homeDirectory: '主目录',
        platform: '平台',
        architecture: '架构',
        lastSeen: '最后看到',
        never: '从未',
        metadataVersion: '元数据版本',
        untitledSession: '未命名会话',
        back: '返回',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `已切换到 ${mode} 模式`,
        unknownEvent: '未知事件',
        usageLimitUntil: ({ time }: { time: string }) => `使用限制直到 ${time}`,
        unknownTime: '未知时间',
    }
} as const;