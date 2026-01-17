/**
 * Chinese (Simplified) translations for the Happy app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

import type { TranslationStructure } from '../_types';

/**
 * Chinese plural helper function
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on count
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

export const zhHans: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        inbox: '收件箱',
        sessions: '终端',
        settings: '设置',
    },

    inbox: {
        // Inbox screen
        emptyTitle: '收件箱为空',
        emptyDescription: '与好友建立连接，开始共享会话',
        updates: '更新',
    },

    common: {
        // Simple string constants
        add: '添加',
        actions: '操作',
        cancel: '取消',
        authenticate: '认证',
        save: '保存',
        saveAs: '另存为',
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
        discard: '放弃',
        discardChanges: '放弃更改',
        unsavedChangesWarning: '你有未保存的更改。',
        keepEditing: '继续编辑',
        version: '版本',
        copied: '已复制',
        copy: '复制',
        scanning: '扫描中...',
        urlPlaceholder: 'https://example.com',
        home: '主页',
        message: '消息',
        files: '文件',
        fileViewer: '文件查看器',
        loading: '加载中...',
        retry: '重试',
        delete: '删除',
        optional: '可选的',
        noMatches: '无匹配结果',
        all: 'All',
        machine: '机器',
        clearSearch: 'Clear search',
    },

    profile: {
        userProfile: '用户资料',
        details: '详情',
        firstName: '名',
        lastName: '姓',
        username: '用户名',
        status: '状态',
    },


    status: {
        connected: '已连接',
        connecting: '连接中',
        disconnected: '已断开',
        error: '错误',
        online: '在线',
        offline: '离线',
        lastSeen: ({ time }: { time: string }) => `最后活跃时间 ${time}`,
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
        invalidSecretKey: '无效的密钥，请检查后重试。',
        enterUrlManually: '手动输入 URL',
    },

    settings: {
        title: '设置',
        connectedAccounts: '已连接账户',
        connectAccount: '连接账户',
        github: 'GitHub',
        machines: '设备',
        features: '功能',
        social: '社交',
        account: '账户',
        accountSubtitle: '管理您的账户详情',
        appearance: '外观',
        appearanceSubtitle: '自定义应用外观',
        voiceAssistant: '语音助手',
        voiceAssistantSubtitle: '配置语音交互偏好',
        featuresTitle: '功能',
        featuresSubtitle: '启用或禁用应用功能',
        developer: '开发者',
        developerTools: '开发者工具',
        about: '关于',
        aboutFooter: 'Happy Coder 是一个 Codex 和 Claude Code 移动客户端。它采用端到端加密，您的账户仅存储在本地设备上。与 Anthropic 无关联。',
        whatsNew: '更新日志',
        whatsNewSubtitle: '查看最新更新和改进',
        reportIssue: '报告问题',
        privacyPolicy: '隐私政策',
        termsOfService: '服务条款',
        eula: '最终用户许可协议',
        supportUs: '支持我们',
        supportUsSubtitlePro: '感谢您的支持！',
        supportUsSubtitle: '支持项目开发',
        scanQrCodeToAuthenticate: '扫描二维码进行认证',
        githubConnected: ({ login }: { login: string }) => `已连接为 @${login}`,
        connectGithubAccount: '连接您的 GitHub 账户',
        claudeAuthSuccess: '成功连接到 Claude',
        exchangingTokens: '正在交换令牌...',
        usage: '使用情况',
        usageSubtitle: '查看 API 使用情况和费用',
        profiles: '配置文件',
        profilesSubtitle: '管理环境配置文件和变量',

        // Dynamic settings messages
        accountConnected: ({ service }: { service: string }) => `已连接 ${service} 账户`,
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} ${status === 'online' ? '在线' : '离线'}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} 已${enabled ? '启用' : '禁用'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: '主题',
        themeDescription: '选择您喜欢的配色方案',
        themeOptions: {
            adaptive: '自适应',
            light: '浅色', 
            dark: '深色',
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
        expandTodoLists: '展开待办列表',
        expandTodoListsDescription: '显示所有待办事项而不仅仅是变更',
        showLineNumbersInDiffs: '在差异中显示行号',
        showLineNumbersInDiffsDescription: '在代码差异中显示行号',
        showLineNumbersInToolViews: '在工具视图中显示行号',
        showLineNumbersInToolViewsDescription: '在工具视图差异中显示行号',
        wrapLinesInDiffs: '在差异中换行',
        wrapLinesInDiffsDescription: '在差异视图中换行显示长行而不是水平滚动',
        alwaysShowContextSize: '始终显示上下文大小',
        alwaysShowContextSizeDescription: '即使未接近限制时也显示上下文使用情况',
        avatarStyle: '头像风格',
        avatarStyleDescription: '选择会话头像外观',
        avatarOptions: {
            pixelated: '像素化',
            gradient: '渐变',
            brutalist: '粗糙风格',
        },
        showFlavorIcons: '显示 AI 提供商图标',
        showFlavorIconsDescription: '在会话头像上显示 AI 提供商图标',
        compactSessionView: '紧凑会话视图',
        compactSessionViewDescription: '以更紧凑的布局显示活跃会话',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: '实验功能',
        experimentsDescription: '启用仍在开发中的实验功能。这些功能可能不稳定或会在没有通知的情况下改变。',
        experimentalFeatures: '实验功能',
        experimentalFeaturesEnabled: '实验功能已启用',
        experimentalFeaturesDisabled: '仅使用稳定功能',
        webFeatures: 'Web 功能',
        webFeaturesDescription: '仅在应用的 Web 版本中可用的功能。',
        enterToSend: '回车发送',
        enterToSendEnabled: '按回车发送（Shift+回车换行）',
        enterToSendDisabled: '回车换行',
        commandPalette: '命令面板',
        commandPaletteEnabled: '按 ⌘K 打开',
        commandPaletteDisabled: '快速命令访问已禁用',
        markdownCopyV2: 'Markdown 复制 v2',
        markdownCopyV2Subtitle: '长按打开复制模态框',
        hideInactiveSessions: '隐藏非活跃会话',
        hideInactiveSessionsSubtitle: '仅在列表中显示活跃的聊天',
        enhancedSessionWizard: '增强会话向导',
        enhancedSessionWizardEnabled: '配置文件优先启动器已激活',
        enhancedSessionWizardDisabled: '使用标准会话启动器',
        profiles: 'AI 配置文件',
        profilesEnabled: '已启用配置文件选择',
        profilesDisabled: '已禁用配置文件选择',
        pickerSearch: '选择器搜索',
        pickerSearchSubtitle: '在设备和路径选择器中显示搜索框',
        machinePickerSearch: '设备搜索',
        machinePickerSearchSubtitle: '在设备选择器中显示搜索框',
        pathPickerSearch: '路径搜索',
        pathPickerSearchSubtitle: '在路径选择器中显示搜索框',
    },

    errors: {
        networkError: '发生网络错误',
        serverError: '发生服务器错误',
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
        voiceServiceUnavailable: '语音服务暂时不可用',
        oauthInitializationFailed: '初始化 OAuth 流程失败',
        tokenStorageFailed: '存储认证令牌失败',
        oauthStateMismatch: '安全验证失败。请重试',
        tokenExchangeFailed: '交换授权码失败',
        oauthAuthorizationDenied: '授权被拒绝',
        webViewLoadFailed: '加载认证页面失败',
        failedToLoadProfile: '无法加载用户资料',
        userNotFound: '未找到用户',
        sessionDeleted: '会话已被删除',
        sessionDeletedDescription: '此会话已被永久删除',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} 必须在 ${min} 和 ${max} 之间`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `${seconds} 秒后重试`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (错误 ${code})`,
        disconnectServiceFailed: ({ service }: { service: string }) => 
            `断开连接 ${service} 失败`,
        connectServiceFailed: ({ service }: { service: string }) =>
            `连接 ${service} 失败。请重试。`,
        failedToLoadFriends: '加载好友列表失败',
        failedToAcceptRequest: '接受好友请求失败',
        failedToRejectRequest: '拒绝好友请求失败',
        failedToRemoveFriend: '删除好友失败',
        searchFailed: '搜索失败。请重试。',
        failedToSendRequest: '发送好友请求失败',
    },

    newSession: {
        // Used by new-session screen and launch flows
        title: '启动新会话',
        selectMachineTitle: '选择设备',
        selectPathTitle: '选择路径',
        searchPathsPlaceholder: '搜索路径...',
        noMachinesFound: '未找到设备。请先在您的计算机上启动 Happy 会话。',
        allMachinesOffline: '所有设备似乎都已离线',
        machineDetails: '查看设备详情 →',
        directoryDoesNotExist: '目录不存在',
        createDirectoryConfirm: ({ directory }: { directory: string }) => `目录 ${directory} 不存在。您要创建它吗？`,
        sessionStarted: '会话已启动',
        sessionStartedMessage: '会话已成功启动。',
        sessionSpawningFailed: '会话生成失败 - 未返回会话 ID。',
        startingSession: '正在启动会话...',
        startNewSessionInFolder: '在此文件夹中启动新会话',
        failedToStart: '启动会话失败。确保守护进程在目标设备上运行。',
        sessionTimeout: '会话启动超时。设备可能运行缓慢或守护进程可能无响应。',
        notConnectedToServer: '未连接到服务器。请检查您的网络连接。',
        noMachineSelected: '请选择一台设备以启动会话',
        noPathSelected: '请选择一个目录以启动会话',
        machinePicker: {
            searchPlaceholder: '搜索设备...',
            recentTitle: '最近',
            favoritesTitle: '收藏',
            allTitle: '全部',
            emptyMessage: '没有可用设备',
        },
        pathPicker: {
            enterPathTitle: '输入路径',
            enterPathPlaceholder: '输入路径...',
            customPathTitle: '自定义路径',
            recentTitle: '最近',
            favoritesTitle: '收藏',
            suggestedTitle: '推荐',
            allTitle: '全部',
            emptyRecent: '没有最近的路径',
            emptyFavorites: '没有收藏的路径',
            emptySuggested: '没有推荐的路径',
            emptyAll: '没有路径',
        },
        sessionType: {
            title: '会话类型',
            simple: '简单',
            worktree: 'Worktree',
            comingSoon: '即将推出',
        },
        worktree: {
            creating: ({ name }: { name: string }) => `正在创建 worktree '${name}'...`,
            notGitRepo: 'Worktree 需要 git 仓库',
            failed: ({ error }: { error: string }) => `创建 worktree 失败：${error}`,
            success: 'Worktree 创建成功',
        }
    },

    sessionHistory: {
        // Used by session history screen
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
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: '服务器配置',
        enterServerUrl: '请输入服务器 URL',
        notValidHappyServer: '不是有效的 Happy 服务器',
        changeServer: '更改服务器',
        continueWithServer: '继续使用此服务器？',
        resetToDefault: '重置为默认',
        resetServerDefault: '重置服务器为默认值？',
        validating: '验证中...',
        validatingServer: '正在验证服务器...',
        serverReturnedError: '服务器返回错误',
        failedToConnectToServer: '连接服务器失败',
        currentlyUsingCustomServer: '当前使用自定义服务器',
        customServerUrlLabel: '自定义服务器 URL',
        advancedFeatureFooter: "这是一个高级功能。只有在您知道自己在做什么时才更改服务器。更改服务器后您需要重新登录。"
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: '终止会话',
        killSessionConfirm: '您确定要终止此会话吗？',
        archiveSession: '归档会话',
        archiveSessionConfirm: '您确定要归档此会话吗？',
        happySessionIdCopied: 'Happy 会话 ID 已复制到剪贴板',
        failedToCopySessionId: '复制 Happy 会话 ID 失败',
        happySessionId: 'Happy 会话 ID',
        claudeCodeSessionId: 'Claude Code 会话 ID',
        claudeCodeSessionIdCopied: 'Claude Code 会话 ID 已复制到剪贴板',
        aiProfile: 'AI 配置文件',
        aiProvider: 'AI 提供商',
        failedToCopyClaudeCodeSessionId: '复制 Claude Code 会话 ID 失败',
        metadataCopied: '元数据已复制到剪贴板',
        failedToCopyMetadata: '复制元数据失败',
        failedToKillSession: '终止会话失败',
        failedToArchiveSession: '归档会话失败',
        connectionStatus: '连接状态',
        created: '创建时间',
        lastUpdated: '最后更新',
        sequence: '序列',
        quickActions: '快速操作',
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
        deleteSession: '删除会话',
        deleteSessionSubtitle: '永久删除此会话',
        deleteSessionConfirm: '永久删除会话？',
        deleteSessionWarning: '此操作无法撤销。与此会话相关的所有消息和数据将被永久删除。',
        failedToDeleteSession: '删除会话失败',
        sessionDeleted: '会话删除成功',
        
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: '准备开始编程？',
            installCli: '安装 Happy CLI',
            runIt: '运行它',
            scanQrCode: '扫描二维码',
            openCamera: '打开相机',
        },
    },

    agentInput: {
        envVars: {
            title: '环境变量',
            titleWithCount: ({ count }: { count: number }) => `环境变量 (${count})`,
        },
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
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
        },
        model: {
            title: '模型',
            configureInCli: '在 CLI 设置中配置模型',
        },
        codexPermissionMode: {
            title: 'CODEX 权限模式',
            default: 'CLI 设置',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            badgeReadOnly: 'Read Only Mode',
            badgeSafeYolo: 'Safe YOLO',
            badgeYolo: 'YOLO',
        },
        codexModel: {
            title: 'CODEX MODEL',
            gpt5CodexLow: 'gpt-5-codex low',
            gpt5CodexMedium: 'gpt-5-codex medium',
            gpt5CodexHigh: 'gpt-5-codex high',
            gpt5Minimal: 'GPT-5 Minimal',
            gpt5Low: 'GPT-5 Low',
            gpt5Medium: 'GPT-5 Medium',
            gpt5High: 'GPT-5 High',
        },
        geminiPermissionMode: {
            title: 'GEMINI 权限模式',
            default: '默认',
            readOnly: '只读',
            safeYolo: '安全 YOLO',
            yolo: 'YOLO',
            badgeReadOnly: '只读',
            badgeSafeYolo: '安全 YOLO',
            badgeYolo: 'YOLO',
        },
        geminiModel: {
            title: 'GEMINI 模型',
            gemini25Pro: {
                label: 'Gemini 2.5 Pro',
                description: '最强能力',
            },
            gemini25Flash: {
                label: 'Gemini 2.5 Flash',
                description: '快速且高效',
            },
            gemini25FlashLite: {
                label: 'Gemini 2.5 Flash Lite',
                description: '最快',
            },
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `剩余 ${percent}%`,
        },
        suggestion: {
            fileLabel: '文件',
            folderLabel: '文件夹',
        },
        noMachinesAvailable: '无设备',
    },

    machineLauncher: {
        showLess: '显示更少',
        showAll: ({ count }: { count: number }) => `显示全部 (${count} 个路径)`,
        enterCustomPath: '输入自定义路径',
        offlineUnableToSpawn: '无法生成新会话，已离线',
    },

    sidebar: {
        sessionsTitle: 'Happy',
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
            completed: '工具已成功完成',
            noOutput: '未产生输出',
            running: '工具正在运行...',
            rawJsonDevMode: '原始 JSON（开发模式）',
        },
        taskView: {
            initializing: '正在初始化 agent...',
            moreTools: ({ count }: { count: number }) => `+${count} 个更多${plural({ count, singular: '工具', plural: '工具' })}`,
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
            planProposal: '计划建议',
            readFile: '读取文件',
            editFile: '编辑文件',
            writeFile: '写入文件',
            fetchUrl: '获取 URL',
            readNotebook: '读取 Notebook',
            editNotebook: '编辑 Notebook',
            todoList: '待办列表',
            webSearch: 'Web 搜索',
            reasoning: '推理',
            applyChanges: '更新文件',
            viewDiff: '当前文件更改',
            question: '问题',
            changeTitle: '更改标题',
        },
        geminiExecute: {
            cwd: ({ cwd }: { cwd: string }) => `📁 ${cwd}`,
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `终端(命令: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `搜索(模式: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `搜索(路径: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `获取 URL(网址: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `编辑 Notebook(文件: ${path}, 模式: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `待办列表(数量: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Web 搜索(查询: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(模式: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} 处编辑)`,
            readingFile: ({ file }: { file: string }) => `正在读取 ${file}`,
            writingFile: ({ file }: { file: string }) => `正在写入 ${file}`,
            modifyingFile: ({ file }: { file: string }) => `正在修改 ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `正在修改 ${count} 个文件`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} 和其他 ${count} 个`,
            showingDiff: '显示更改',
        },
        askUserQuestion: {
            submit: '提交答案',
            multipleQuestions: ({ count }: { count: number }) => `${count} 个问题`,
        }
    },

    files: {
        searchPlaceholder: '搜索文件...',
        detachedHead: '游离 HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} 已暂存 • ${unstaged} 未暂存`,
        notRepo: '不是 git 仓库',
        notUnderGit: '此目录不在 git 版本控制下',
        searching: '正在搜索文件...',
        noFilesFound: '未找到文件',
        noFilesInProject: '项目中没有文件',
        tryDifferentTerm: '尝试不同的搜索词',
        searchResults: ({ count }: { count: number }) => `搜索结果 (${count})`,
        projectRoot: '项目根目录',
        stagedChanges: ({ count }: { count: number }) => `已暂存的更改 (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `未暂存的更改 (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `正在加载 ${fileName}...`,
        binaryFile: '二进制文件',
        cannotDisplayBinary: '无法显示二进制文件内容',
        diff: '差异',
        file: '文件',
        fileEmpty: '文件为空',
        noChanges: '没有要显示的更改',
    },

    settingsVoice: {
        // Voice settings screen
        languageTitle: '语言',
        languageDescription: '选择您希望语音助手交互使用的语言。此设置将在您的所有设备间同步。',
        preferredLanguage: '首选语言',
        preferredLanguageSubtitle: '语音助手响应使用的语言',
        language: {
            searchPlaceholder: '搜索语言...',
            title: '语言',
            footer: ({ count }: { count: number }) => `${count} 种可用语言`,
            autoDetect: '自动检测',
        }
    },

    settingsAccount: {
        // Account settings screen
        accountInformation: '账户信息',
        status: '状态',
        statusActive: '活跃',
        statusNotAuthenticated: '未认证',
        anonymousId: '匿名 ID',
        publicId: '公共 ID',
        notAvailable: '不可用',
        linkNewDevice: '链接新设备',
        linkNewDeviceSubtitle: '扫描二维码来链接设备',
        profile: '个人资料',
        name: '姓名',
        github: 'GitHub',
        tapToDisconnect: '点击断开连接',
        server: '服务器',
        backup: '备份',
        backupDescription: '您的密钥是恢复账户的唯一方法。请将其保存在安全的地方，比如密码管理器中。',
        secretKey: '密钥',
        tapToReveal: '点击显示',
        tapToHide: '点击隐藏',
        secretKeyLabel: '密钥（点击复制）',
        secretKeyCopied: '密钥已复制到剪贴板。请将其保存在安全的地方！',
        secretKeyCopyFailed: '复制密钥失败',
        privacy: '隐私',
        privacyDescription: '通过分享匿名使用数据来帮助改进应用。不会收集个人信息。',
        analytics: '分析',
        analyticsDisabled: '不分享数据',
        analyticsEnabled: '分享匿名使用数据',
        dangerZone: '危险区域',
        logout: '登出',
        logoutSubtitle: '登出并清除本地数据',
        logoutConfirm: '您确定要登出吗？请确保您已备份密钥！',
    },

    settingsLanguage: {
        // Language settings screen
        title: '语言',
        description: '选择您希望应用界面使用的语言。此设置将在您的所有设备间同步。',
        currentLanguage: '当前语言',
        automatic: '自动',
        automaticSubtitle: '从设备设置中检测',
        needsRestart: '语言已更改',
        needsRestartMessage: '应用需要重启以应用新的语言设置。',
        restartNow: '立即重启',
    },

    connectButton: {
        authenticate: '认证终端',
        authenticateWithUrlPaste: '通过 URL 粘贴认证终端',
        pasteAuthUrl: '粘贴来自您终端的认证 URL',
    },

    updateBanner: {
        updateAvailable: '有可用更新',
        pressToApply: '点击应用更新',
        whatsNew: "更新内容",
        seeLatest: '查看最新更新和改进',
        nativeUpdateAvailable: '应用更新可用',
        tapToUpdateAppStore: '点击在 App Store 中更新',
        tapToUpdatePlayStore: '点击在 Play Store 中更新',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `版本 ${version}`,
        noEntriesAvailable: '没有可用的更新日志条目。',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: '需要 Web 浏览器',
        webBrowserRequiredDescription: '出于安全原因，终端连接链接只能在 Web 浏览器中打开。请使用二维码扫描器或在计算机上打开此链接。',
        processingConnection: '正在处理连接...',
        invalidConnectionLink: '无效的连接链接',
        invalidConnectionLinkDescription: '连接链接缺失或无效。请检查 URL 并重试。',
        connectTerminal: '连接终端',
        terminalRequestDescription: '有终端正在请求连接到您的 Happy Coder 账户。这将允许终端安全地发送和接收消息。',
        connectionDetails: '连接详情',
        publicKey: '公钥',
        encryption: '加密',
        endToEndEncrypted: '端到端加密',
        acceptConnection: '接受连接',
        connecting: '连接中...',
        reject: '拒绝',
        security: '安全',
        securityFooter: '此连接链接在您的浏览器中安全处理，从未发送到任何服务器。您的私人数据将保持安全，只有您能解密消息。',
        securityFooterDevice: '此连接在您的设备上安全处理，从未发送到任何服务器。您的私人数据将保持安全，只有您能解密消息。',
        clientSideProcessing: '客户端处理',
        linkProcessedLocally: '链接在浏览器中本地处理',
        linkProcessedOnDevice: '链接在设备上本地处理',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: '认证终端',
        pasteUrlFromTerminal: '粘贴来自您终端的认证 URL',
        deviceLinkedSuccessfully: '设备链接成功',
        terminalConnectedSuccessfully: '终端连接成功',
        invalidAuthUrl: '无效的认证 URL',
        developerMode: '开发者模式',
        developerModeEnabled: '开发者模式已启用',
        developerModeDisabled: '开发者模式已禁用',
        disconnectGithub: '断开 GitHub 连接',
        disconnectGithubConfirm: '您确定要断开 GitHub 账户连接吗？',
        disconnectService: ({ service }: { service: string }) => 
            `断开 ${service} 连接`,
        disconnectServiceConfirm: ({ service }: { service: string }) => 
            `您确定要断开 ${service} 与您账户的连接吗？`,
        disconnect: '断开连接',
        failedToConnectTerminal: '连接终端失败',
        cameraPermissionsRequiredToConnectTerminal: '连接终端需要相机权限',
        failedToLinkDevice: '链接设备失败',
        cameraPermissionsRequiredToScanQr: '扫描二维码需要相机权限'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: '连接终端',
        linkNewDevice: '链接新设备', 
        restoreWithSecretKey: '通过密钥恢复',
        whatsNew: "更新日志",
        friends: '好友',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Codex 和 Claude Code 移动客户端',
        subtitle: '端到端加密，您的账户仅存储在您的设备上。',
        createAccount: '创建账户',
        linkOrRestoreAccount: '链接或恢复账户',
        loginWithMobileApp: '使用移动应用登录',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: '喜欢这个应用吗？',
        feedbackPrompt: "我们很希望听到您的反馈！",
        yesILoveIt: '是的，我喜欢！',
        notReally: '不太喜欢'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} 已复制到剪贴板`
    },

    machine: {
        launchNewSessionInDirectory: '在目录中启动新会话',
        offlineUnableToSpawn: '设备离线时无法启动',
        offlineHelp: '• 确保您的计算机在线\n• 运行 `happy daemon status` 进行诊断\n• 您是否在运行最新的 CLI 版本？请使用 `npm install -g happy-coder@latest` 升级',
        daemon: '守护进程',
        status: '状态',
        stopDaemon: '停止守护进程',
        lastKnownPid: '最后已知 PID',
        lastKnownHttpPort: '最后已知 HTTP 端口',
        startedAt: '启动时间',
        cliVersion: 'CLI 版本',
        daemonStateVersion: '守护进程状态版本',
        activeSessions: ({ count }: { count: number }) => `活跃会话 (${count})`,
        machineGroup: '设备',
        host: '主机',
        machineId: '设备 ID',
        username: '用户名',
        homeDirectory: '主目录',
        platform: '平台',
        architecture: '架构',
        lastSeen: '最后活跃',
        never: '从未',
        metadataVersion: '元数据版本',
        untitledSession: '无标题会话',
        back: '返回',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `已切换到 ${mode} 模式`,
        unknownEvent: '未知事件',
        usageLimitUntil: ({ time }: { time: string }) => `使用限制到 ${time}`,
        unknownTime: '未知时间',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: '是，并且本次会话不再询问',
            stopAndExplain: '停止，并说明该做什么',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: '是，允许本次会话的所有编辑',
            yesForTool: '是，不再询问此工具',
            noTellClaude: '否，提供反馈',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: '选择文本范围',
        title: '选择文本',
        noTextProvided: '未提供文本',
        textNotFound: '文本未找到或已过期',
        textCopied: '文本已复制到剪贴板',
        failedToCopy: '复制文本到剪贴板失败',
        noTextToCopy: '没有可复制的文本',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: '代码已复制',
        copyFailed: '复制失败',
        mermaidRenderFailed: '渲染 mermaid 图表失败',
    },

    artifacts: {
        title: '工件',
        countSingular: '1 个工件',
        countPlural: ({ count }: { count: number }) => `${count} 个工件`,
        empty: '暂无工件',
        emptyDescription: '创建您的第一个工件来保存和组织内容',
        new: '新建工件',
        edit: '编辑工件',
        delete: '删除',
        updateError: '更新工件失败。请重试。',
        notFound: '未找到工件',
        discardChanges: '放弃更改？',
        discardChangesDescription: '您有未保存的更改。确定要放弃它们吗？',
        deleteConfirm: '删除工件？',
        deleteConfirmDescription: '此工件将被永久删除。',
        titlePlaceholder: '工件标题',
        bodyPlaceholder: '在此输入内容...',
        save: '保存',
        saving: '保存中...',
        loading: '加载中...',
        error: '加载工件失败',
        titleLabel: '标题',
        bodyLabel: '内容',
        emptyFieldsError: '请输入标题或内容',
        createError: '创建工件失败。请重试。',
    },

    friends: {
        // Friends feature
        title: '好友',
        manageFriends: '管理您的好友和连接',
        searchTitle: '查找好友',
        pendingRequests: '好友请求',
        myFriends: '我的好友',
        noFriendsYet: '您还没有好友',
        findFriends: '查找好友',
        remove: '删除',
        pendingRequest: '待处理',
        sentOn: ({ date }: { date: string }) => `发送于 ${date}`,
        accept: '接受',
        reject: '拒绝',
        addFriend: '添加好友',
        alreadyFriends: '已是好友',
        requestPending: '请求待处理',
        searchInstructions: '输入用户名搜索好友',
        searchPlaceholder: '输入用户名...',
        searching: '搜索中...',
        userNotFound: '未找到用户',
        noUserFound: '未找到该用户名的用户',
        checkUsername: '请检查用户名后重试',
        howToFind: '如何查找好友',
        findInstructions: '通过用户名搜索好友。您和您的好友都需要连接 GitHub 才能发送好友请求。',
        requestSent: '好友请求已发送！',
        requestAccepted: '好友请求已接受！',
        requestRejected: '好友请求已拒绝',
        friendRemoved: '好友已删除',
        confirmRemove: '删除好友',
        confirmRemoveMessage: '确定要删除这位好友吗？',
        cannotAddYourself: '您不能向自己发送好友请求',
        bothMustHaveGithub: '双方都必须连接 GitHub 才能成为好友',
        status: {
            none: '未连接',
            requested: '请求已发送',
            pending: '请求待处理',
            friend: '好友',
            rejected: '已拒绝',
        },
        acceptRequest: '接受请求',
        removeFriend: '移除好友',
        removeFriendConfirm: ({ name }: { name: string }) => `确定要将 ${name} 从好友列表中移除吗？`,
        requestSentDescription: ({ name }: { name: string }) => `您的好友请求已发送给 ${name}`,
        requestFriendship: '请求加为好友',
        cancelRequest: '取消好友请求',
        cancelRequestConfirm: ({ name }: { name: string }) => `取消发送给 ${name} 的好友请求？`,
        denyRequest: '拒绝请求',
        nowFriendsWith: ({ name }: { name: string }) => `您现在与 ${name} 是好友了`,
    },

    usage: {
        // Usage panel strings
        today: '今天',
        last7Days: '过去 7 天',
        last30Days: '过去 30 天',
        totalTokens: '总令牌数',
        totalCost: '总费用',
        tokens: '令牌',
        cost: '费用',
        usageOverTime: '使用趋势',
        byModel: '按模型',
        noData: '暂无使用数据',
    },

    profiles: {
        title: '配置文件',
        subtitle: '管理您的配置文件',
        noProfile: '无配置文件',
        noProfileDescription: '创建配置文件以管理您的环境设置',
        addProfile: '添加配置文件',
        addProfileTitle: '添加配置文件标题',
        editProfile: '编辑配置文件',
        profileName: '配置文件名称',
        enterName: '输入配置文件名称',
        baseURL: '基础 URL',
        authToken: '认证令牌',
        enterToken: '输入认证令牌',
        model: '模型',
        defaultModel: '默认模型',
        tmuxSession: 'tmux 会话',
        enterTmuxSession: '输入 tmux 会话名称',
        tmuxTempDir: 'tmux 临时目录',
        enterTmuxTempDir: '输入 tmux 临时目录',
        tmuxUpdateEnvironment: '更新 tmux 环境',
        deleteConfirm: ({ name }: { name: string }) => `确定要删除配置文件“${name}”吗？`,
        nameRequired: '配置文件名称为必填项',
        builtIn: '内置',
        builtInNames: {
            anthropic: 'Anthropic (Default)',
            deepseek: 'DeepSeek (Reasoner)',
            zai: 'Z.AI (GLM-4.6)',
            openai: 'OpenAI (GPT-5)',
            azureOpenai: 'Azure OpenAI',
        },
        groups: {
            favorites: '收藏',
            custom: '你的配置文件',
            builtIn: '内置配置文件',
        },
        actions: {
            viewEnvironmentVariables: '环境变量',
            addToFavorites: '添加到收藏',
            removeFromFavorites: '从收藏中移除',
            editProfile: '编辑配置文件',
            duplicateProfile: '复制配置文件',
            deleteProfile: '删除配置文件',
        },
        copySuffix: '(Copy)',
        duplicateName: '已存在同名配置文件',
        setupInstructions: {
            title: '设置说明',
            viewOfficialGuide: '查看官方设置指南',
        },
        defaultSessionType: '默认会话类型',
        defaultPermissionMode: {
            title: '默认权限模式',
            descriptions: {
                default: '询问权限',
                acceptEdits: '自动批准编辑',
                plan: '执行前先规划',
                bypassPermissions: '跳过所有权限',
            },
        },
        aiBackend: {
            title: 'AI 后端',
            selectAtLeastOneError: '至少选择一个 AI 后端。',
            claudeSubtitle: 'Claude CLI',
            codexSubtitle: 'Codex CLI',
            geminiSubtitleExperimental: 'Gemini CLI（实验）',
        },
        tmux: {
            title: 'tmux',
            spawnSessionsTitle: '在 tmux 中启动会话',
            spawnSessionsEnabledSubtitle: '会话将在新的 tmux 窗口中启动。',
            spawnSessionsDisabledSubtitle: '会话将在普通 shell 中启动（无 tmux 集成）',
            sessionNamePlaceholder: '留空 = 当前/最近会话',
            tempDirPlaceholder: '/tmp（可选）',
        },
        previewMachine: {
            title: '预览设备',
            selectMachine: '选择设备',
            resolveSubtitle: '为此配置文件解析设备环境变量。',
            selectSubtitle: '选择设备以预览解析后的值。',
        },
        environmentVariables: {
            title: '环境变量',
            addVariable: '添加变量',
            namePlaceholder: '变量名（例如 MY_CUSTOM_VAR）',
            valuePlaceholder: '值（例如 my-value 或 ${MY_VAR}）',
            validation: {
                nameRequired: '请输入变量名。',
                invalidNameFormat: '变量名必须由大写字母、数字和下划线组成，且不能以数字开头。',
                duplicateName: '该变量已存在。',
            },
            card: {
                valueLabel: '值：',
                fallbackValueLabel: '备用值：',
                valueInputPlaceholder: '值',
                defaultValueInputPlaceholder: '默认值',
                secretNotRetrieved: '秘密值——出于安全原因不会读取',
                overridingDefault: ({ expectedValue }: { expectedValue: string }) =>
                    `正在覆盖文档默认值：${expectedValue}`,
                useMachineEnvToggle: '使用设备环境中的值',
                resolvedOnSessionStart: '会话在所选设备上启动时解析。',
                sourceVariableLabel: '来源变量',
                sourceVariablePlaceholder: '来源变量名（例如 Z_AI_MODEL）',
                checkingMachine: ({ machine }: { machine: string }) => `正在检查 ${machine}...`,
                emptyOnMachine: ({ machine }: { machine: string }) => `${machine} 上为空`,
                emptyOnMachineUsingFallback: ({ machine }: { machine: string }) => `${machine} 上为空（使用备用值）`,
                notFoundOnMachine: ({ machine }: { machine: string }) => `在 ${machine} 上未找到`,
                notFoundOnMachineUsingFallback: ({ machine }: { machine: string }) => `在 ${machine} 上未找到（使用备用值）`,
                valueFoundOnMachine: ({ machine }: { machine: string }) => `在 ${machine} 上找到值`,
                differsFromDocumented: ({ expectedValue }: { expectedValue: string }) =>
                    `与文档值不同：${expectedValue}`,
            },
            preview: {
                secretValueHidden: ({ value }: { value: string }) => `${value} - 出于安全已隐藏`,
                hiddenValue: '***已隐藏***',
                emptyValue: '(空)',
                sessionWillReceive: ({ name, value }: { name: string; value: string }) =>
                    `会话将收到：${name} = ${value}`,
            },
            previewModal: {
                titleWithProfile: ({ profileName }: { profileName: string }) => `环境变量 · ${profileName}`,
                descriptionPrefix: '这些环境变量会在启动会话时发送。值会通过守护进程解析于',
                descriptionFallbackMachine: '所选设备',
                descriptionSuffix: '。',
                emptyMessage: '该配置文件未设置环境变量。',
                checkingSuffix: '（检查中…）',
                detail: {
                    fixed: '固定',
                    machine: '设备',
                    checking: '检查中',
                    fallback: '备用',
                    missing: '缺失',
                },
            },
        },
        delete: {
            title: '删除配置',
            message: ({ name }: { name: string }) => `确定要删除"${name}"吗？此操作无法撤销。`,
            confirm: '删除',
            cancel: '取消',
        },
    },

    feed: {
        // Feed notifications for friend requests and acceptances
        friendRequestFrom: ({ name }: { name: string }) => `${name} 向您发送了好友请求`,
        friendRequestGeneric: '新的好友请求',
        friendAccepted: ({ name }: { name: string }) => `您现在与 ${name} 成为了好友`,
        friendAcceptedGeneric: '好友请求已接受',
    }
} as const;
