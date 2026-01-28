/**
 * Chinese (Traditional) translations for the Happy app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

import { TranslationStructure } from "../_default";

/**
 * Chinese plural helper function
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on count
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

export const zhHant: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        inbox: '收件匣',
        sessions: '終端',
        settings: '設定',
    },

    inbox: {
        // Inbox screen
        emptyTitle: '收件匣是空的',
        emptyDescription: '與好友建立連結，開始共享工作階段',
        updates: '更新',
    },

    common: {
        // Simple string constants
        cancel: '取消',
        authenticate: '驗證',
        save: '儲存',
        saveAs: '另存為',
        error: '錯誤',
        success: '成功',
        ok: '確定',
        continue: '繼續',
        back: '返回',
        create: '建立',
        rename: '重新命名',
        reset: '重設',
        logout: '登出',
        yes: '是',
        no: '否',
        discard: '放棄',
        version: '版本',
        copied: '已複製',
        copy: '複製',
        scanning: '掃描中...',
        urlPlaceholder: 'https://example.com',
        home: '首頁',
        message: '訊息',
        files: '檔案',
        fileViewer: '檔案檢視器',
        loading: '載入中...',
        retry: '重試',
        delete: '刪除',
        optional: '選填',
    },

    profile: {
        userProfile: '使用者資料',
        details: '詳情',
        firstName: '名',
        lastName: '姓',
        username: '使用者名稱',
        status: '狀態',
    },

    status: {
        connected: '已連線',
        connecting: '連線中',
        disconnected: '已中斷連線',
        error: '錯誤',
        online: '線上',
        offline: '離線',
        lastSeen: ({ time }: { time: string }) => `最後活躍時間 ${time}`,
        permissionRequired: '需要權限',
        activeNow: '目前活躍',
        unknown: '未知',
    },

    time: {
        justNow: '剛剛',
        minutesAgo: ({ count }: { count: number }) => `${count} 分鐘前`,
        hoursAgo: ({ count }: { count: number }) => `${count} 小時前`,
    },

    connect: {
        restoreAccount: '恢復帳戶',
        enterSecretKey: '請輸入金鑰',
        invalidSecretKey: '無效的金鑰，請檢查後重試。',
        enterUrlManually: '手動輸入 URL',
    },

    settings: {
        title: '設定',
        connectedAccounts: '已連結帳戶',
        connectAccount: '連結帳戶',
        github: 'GitHub',
        machines: '裝置',
        features: '功能',
        social: '社交',
        account: '帳戶',
        accountSubtitle: '管理您的帳戶詳情',
        appearance: '外觀',
        appearanceSubtitle: '自訂應用程式外觀',
        voiceAssistant: '語音助理',
        voiceAssistantSubtitle: '設定語音互動偏好',
        featuresTitle: '功能',
        featuresSubtitle: '啟用或停用應用程式功能',
        developer: '開發者',
        developerTools: '開發者工具',
        about: '關於',
        aboutFooter: 'Happy Coder 是一個 Codex 和 Claude Code 行動用戶端。它採用端對端加密，您的帳戶僅儲存在本機裝置上。與 Anthropic 無關聯。',
        whatsNew: '更新日誌',
        whatsNewSubtitle: '查看最新更新和改進',
        reportIssue: '回報問題',
        privacyPolicy: '隱私權政策',
        termsOfService: '服務條款',
        eula: '終端使用者授權協議',
        supportUs: '支援我們',
        supportUsSubtitlePro: '感謝您的支援！',
        supportUsSubtitle: '支援專案開發',
        scanQrCodeToAuthenticate: '掃描 QR Code 進行驗證',
        githubConnected: ({ login }: { login: string }) => `已連結為 @${login}`,
        connectGithubAccount: '連結您的 GitHub 帳戶',
        claudeAuthSuccess: '成功連結到 Claude',
        exchangingTokens: '正在交換權杖...',
        usage: '使用情況',
        usageSubtitle: '查看 API 使用情況和費用',
        profiles: '設定檔',
        profilesSubtitle: '管理工作階段的環境變數設定檔',

        // Dynamic settings messages
        accountConnected: ({ service }: { service: string }) => `已連結 ${service} 帳戶`,
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} ${status === 'online' ? '線上' : '離線'}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} 已${enabled ? '啟用' : '停用'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: '主題',
        themeDescription: '選擇您喜歡的配色方案',
        themeOptions: {
            adaptive: '自適應',
            light: '淺色',
            dark: '深色',
        },
        themeDescriptions: {
            adaptive: '跟隨系統設定',
            light: '始終使用淺色主題',
            dark: '始終使用深色主題',
        },
        display: '顯示',
        displayDescription: '控制版面配置和間距',
        inlineToolCalls: '內嵌工具呼叫',
        inlineToolCallsDescription: '在聊天訊息中直接顯示工具呼叫',
        expandTodoLists: '展開待辦清單',
        expandTodoListsDescription: '顯示所有待辦事項而不僅僅是變更',
        showLineNumbersInDiffs: '在差異中顯示行號',
        showLineNumbersInDiffsDescription: '在程式碼差異中顯示行號',
        showLineNumbersInToolViews: '在工具檢視中顯示行號',
        showLineNumbersInToolViewsDescription: '在工具檢視差異中顯示行號',
        wrapLinesInDiffs: '在差異中換行',
        wrapLinesInDiffsDescription: '在差異檢視中換行顯示長行而不是水平捲動',
        alwaysShowContextSize: '始終顯示上下文大小',
        alwaysShowContextSizeDescription: '即使未接近限制時也顯示上下文使用情況',
        avatarStyle: '頭像風格',
        avatarStyleDescription: '選擇工作階段頭像外觀',
        avatarOptions: {
            pixelated: '像素化',
            gradient: '漸層',
            brutalist: '粗獷風格',
        },
        showFlavorIcons: '顯示 AI 提供者圖示',
        showFlavorIconsDescription: '在工作階段頭像上顯示 AI 提供者圖示',
        compactSessionView: '緊湊工作階段檢視',
        compactSessionViewDescription: '以更緊湊的版面配置顯示活躍工作階段',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: '實驗功能',
        experimentsDescription: '啟用仍在開發中的實驗功能。這些功能可能不穩定或會在沒有通知的情況下改變。',
        experimentalFeatures: '實驗功能',
        experimentalFeaturesEnabled: '實驗功能已啟用',
        experimentalFeaturesDisabled: '僅使用穩定功能',
        webFeatures: 'Web 功能',
        webFeaturesDescription: '僅在應用程式的 Web 版本中可用的功能。',
        enterToSend: 'Enter 鍵傳送',
        enterToSendEnabled: '按 Enter 傳送（Shift+Enter 換行）',
        enterToSendDisabled: 'Enter 鍵插入換行',
        commandPalette: '命令面板',
        commandPaletteEnabled: '按 ⌘K 開啟',
        commandPaletteDisabled: '快速命令存取已停用',
        markdownCopyV2: 'Markdown 複製 v2',
        markdownCopyV2Subtitle: '長按開啟複製強制回應視窗',
        hideInactiveSessions: '隱藏非活躍工作階段',
        hideInactiveSessionsSubtitle: '僅在清單中顯示活躍的聊天',
        enhancedSessionWizard: '增強工作階段精靈',
        enhancedSessionWizardEnabled: '設定檔優先的工作階段啟動器已啟用',
        enhancedSessionWizardDisabled: '使用標準工作階段啟動器',
    },

    errors: {
        networkError: '發生網路錯誤',
        serverError: '發生伺服器錯誤',
        unknownError: '發生未知錯誤',
        connectionTimeout: '連線逾時',
        authenticationFailed: '驗證失敗',
        permissionDenied: '權限被拒絕',
        fileNotFound: '檔案未找到',
        invalidFormat: '格式無效',
        operationFailed: '操作失敗',
        tryAgain: '請重試',
        contactSupport: '如果問題持續存在，請聯絡支援',
        sessionNotFound: '工作階段未找到',
        voiceSessionFailed: '啟動語音工作階段失敗',
        voiceServiceUnavailable: '語音服務暫時無法使用',
        oauthInitializationFailed: '初始化 OAuth 流程失敗',
        tokenStorageFailed: '儲存驗證權杖失敗',
        oauthStateMismatch: '安全驗證失敗。請重試',
        tokenExchangeFailed: '交換授權碼失敗',
        oauthAuthorizationDenied: '授權被拒絕',
        webViewLoadFailed: '載入驗證頁面失敗',
        failedToLoadProfile: '無法載入使用者資料',
        userNotFound: '未找到使用者',
        sessionDeleted: '工作階段已被刪除',
        sessionDeletedDescription: '此工作階段已被永久刪除',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} 必須在 ${min} 和 ${max} 之間`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `${seconds} 秒後重試`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (錯誤 ${code})`,
        disconnectServiceFailed: ({ service }: { service: string }) =>
            `中斷連線 ${service} 失敗`,
        connectServiceFailed: ({ service }: { service: string }) =>
            `連結 ${service} 失敗。請重試。`,
        failedToLoadFriends: '載入好友清單失敗',
        failedToAcceptRequest: '接受好友請求失敗',
        failedToRejectRequest: '拒絕好友請求失敗',
        failedToRemoveFriend: '刪除好友失敗',
        searchFailed: '搜尋失敗。請重試。',
        failedToSendRequest: '傳送好友請求失敗',
    },

    newSession: {
        // Used by new-session screen and launch flows
        title: '啟動新工作階段',
        noMachinesFound: '未找到裝置。請先在您的電腦上啟動 Happy 工作階段。',
        allMachinesOffline: '所有裝置似乎都已離線',
        machineDetails: '查看裝置詳情 →',
        directoryDoesNotExist: '目錄不存在',
        createDirectoryConfirm: ({ directory }: { directory: string }) => `目錄 ${directory} 不存在。您要建立它嗎？`,
        sessionStarted: '工作階段已啟動',
        sessionStartedMessage: '工作階段已成功啟動。',
        sessionSpawningFailed: '工作階段生成失敗 - 未返回工作階段 ID。',
        startingSession: '正在啟動工作階段...',
        startNewSessionInFolder: '在此資料夾中啟動新工作階段',
        failedToStart: '啟動工作階段失敗。確保守護程序在目標裝置上執行。',
        sessionTimeout: '工作階段啟動逾時。裝置可能執行緩慢或守護程序可能無回應。',
        notConnectedToServer: '未連線到伺服器。請檢查您的網路連線。',
        noMachineSelected: '請選擇一台裝置以啟動工作階段',
        noPathSelected: '請選擇一個目錄以啟動工作階段',
        sessionType: {
            title: '工作階段類型',
            simple: '簡單',
            worktree: 'Worktree',
            comingSoon: '即將推出',
        },
        worktree: {
            creating: ({ name }: { name: string }) => `正在建立 worktree '${name}'...`,
            notGitRepo: 'Worktree 需要 git 倉庫',
            failed: ({ error }: { error: string }) => `建立 worktree 失敗：${error}`,
            success: 'Worktree 建立成功',
        }
    },

    sessionHistory: {
        // Used by session history screen
        title: '工作階段歷史',
        empty: '未找到工作階段',
        today: '今天',
        yesterday: '昨天',
        daysAgo: ({ count }: { count: number }) => `${count} 天前`,
        viewAll: '查看所有工作階段',
    },

    session: {
        inputPlaceholder: '輸入訊息...',
    },

    commandPalette: {
        placeholder: '輸入命令或搜尋...',
    },

    server: {
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: '伺服器設定',
        enterServerUrl: '請輸入伺服器 URL',
        notValidHappyServer: '不是有效的 Happy 伺服器',
        changeServer: '更改伺服器',
        continueWithServer: '繼續使用此伺服器？',
        resetToDefault: '重設為預設',
        resetServerDefault: '重設伺服器為預設值？',
        validating: '驗證中...',
        validatingServer: '正在驗證伺服器...',
        serverReturnedError: '伺服器返回錯誤',
        failedToConnectToServer: '連線伺服器失敗',
        currentlyUsingCustomServer: '目前使用自訂伺服器',
        customServerUrlLabel: '自訂伺服器 URL',
        advancedFeatureFooter: "這是一個進階功能。只有在您知道自己在做什麼時才更改伺服器。更改伺服器後您需要重新登入。"
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: '終止工作階段',
        killSessionConfirm: '您確定要終止此工作階段嗎？',
        archiveSession: '封存工作階段',
        archiveSessionConfirm: '您確定要封存此工作階段嗎？',
        happySessionIdCopied: 'Happy 工作階段 ID 已複製到剪貼簿',
        failedToCopySessionId: '複製 Happy 工作階段 ID 失敗',
        happySessionId: 'Happy 工作階段 ID',
        claudeCodeSessionId: 'Claude Code 工作階段 ID',
        claudeCodeSessionIdCopied: 'Claude Code 工作階段 ID 已複製到剪貼簿',
        aiProvider: 'AI 提供者',
        failedToCopyClaudeCodeSessionId: '複製 Claude Code 工作階段 ID 失敗',
        metadataCopied: '中繼資料已複製到剪貼簿',
        failedToCopyMetadata: '複製中繼資料失敗',
        failedToKillSession: '終止工作階段失敗',
        failedToArchiveSession: '封存工作階段失敗',
        connectionStatus: '連線狀態',
        created: '建立時間',
        lastUpdated: '最後更新',
        sequence: '序列',
        quickActions: '快速操作',
        viewMachine: '查看裝置',
        viewMachineSubtitle: '查看裝置詳情和工作階段',
        killSessionSubtitle: '立即終止工作階段',
        archiveSessionSubtitle: '封存此工作階段並停止它',
        metadata: '中繼資料',
        host: '主機',
        path: '路徑',
        operatingSystem: '作業系統',
        processId: '處理程序 ID',
        happyHome: 'Happy 主目錄',
        copyMetadata: '複製中繼資料',
        agentState: 'Agent 狀態',
        controlledByUser: '使用者控制',
        pendingRequests: '待處理請求',
        activity: '活動',
        thinking: '思考中',
        thinkingSince: '思考開始時間',
        cliVersion: 'CLI 版本',
        cliVersionOutdated: '需要更新 CLI',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `已安裝版本 ${currentVersion}。請更新到 ${requiredVersion} 或更高版本`,
        updateCliInstructions: '請執行 npm install -g happy-coder@latest',
        deleteSession: '刪除工作階段',
        deleteSessionSubtitle: '永久刪除此工作階段',
        deleteSessionConfirm: '永久刪除工作階段？',
        deleteSessionWarning: '此操作無法復原。與此工作階段相關的所有訊息和資料將被永久刪除。',
        failedToDeleteSession: '刪除工作階段失敗',
        sessionDeleted: '工作階段刪除成功',

    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: '準備開始寫程式？',
            installCli: '安裝 Happy CLI',
            runIt: '執行它',
            scanQrCode: '掃描 QR Code',
            openCamera: '開啟相機',
        },
    },

    agentInput: {
        permissionMode: {
            title: '權限模式',
            default: '預設',
            acceptEdits: '接受編輯',
            plan: '計畫模式',
            bypassPermissions: 'Yolo 模式',
            badgeAcceptAllEdits: '接受所有編輯',
            badgeBypassAllPermissions: '繞過所有權限',
            badgePlanMode: '計畫模式',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
        },
        model: {
            title: '模型',
            configureInCli: '在 CLI 設定中配置模型',
        },
        codexPermissionMode: {
            title: 'CODEX 權限模式',
            default: 'CLI 設定',
            readOnly: '唯讀模式',
            safeYolo: '安全 YOLO',
            yolo: 'YOLO',
            badgeReadOnly: '唯讀模式',
            badgeSafeYolo: '安全 YOLO',
            badgeYolo: 'YOLO',
        },
        codexModel: {
            title: 'CODEX 模型',
            gpt5CodexLow: 'gpt-5-codex low',
            gpt5CodexMedium: 'gpt-5-codex medium',
            gpt5CodexHigh: 'gpt-5-codex high',
            gpt5Minimal: 'GPT-5 極簡',
            gpt5Low: 'GPT-5 低',
            gpt5Medium: 'GPT-5 中',
            gpt5High: 'GPT-5 高',
        },
        geminiPermissionMode: {
            title: 'GEMINI 權限模式',
            default: '預設',
            readOnly: '唯讀',
            safeYolo: '安全 YOLO',
            yolo: 'YOLO',
            badgeReadOnly: '唯讀',
            badgeSafeYolo: '安全 YOLO',
            badgeYolo: 'YOLO',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `剩餘 ${percent}%`,
        },
        suggestion: {
            fileLabel: '檔案',
            folderLabel: '資料夾',
        },
        noMachinesAvailable: '無裝置',
    },

    machineLauncher: {
        showLess: '顯示更少',
        showAll: ({ count }: { count: number }) => `顯示全部 (${count} 個路徑)`,
        enterCustomPath: '輸入自訂路徑',
        offlineUnableToSpawn: '無法生成新工作階段，已離線',
    },

    sidebar: {
        sessionsTitle: 'Happy',
    },

    toolView: {
        input: '輸入',
        output: '輸出',
    },

    tools: {
        fullView: {
            description: '描述',
            inputParams: '輸入參數',
            output: '輸出',
            error: '錯誤',
            completed: '工具已成功完成',
            noOutput: '未產生輸出',
            running: '工具正在執行...',
            rawJsonDevMode: '原始 JSON（開發模式）',
        },
        taskView: {
            initializing: '正在初始化 agent...',
            moreTools: ({ count }: { count: number }) => `+${count} 個更多${plural({ count, singular: '工具', plural: '工具' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `編輯 ${index}/${total}`,
            replaceAll: '全部替換',
        },
        names: {
            task: '任務',
            terminal: '終端機',
            searchFiles: '搜尋檔案',
            search: '搜尋',
            searchContent: '搜尋內容',
            listFiles: '列出檔案',
            planProposal: '計畫建議',
            readFile: '讀取檔案',
            editFile: '編輯檔案',
            writeFile: '寫入檔案',
            fetchUrl: '獲取 URL',
            readNotebook: '讀取 Notebook',
            editNotebook: '編輯 Notebook',
            todoList: '待辦清單',
            webSearch: 'Web 搜尋',
            reasoning: '推理',
            applyChanges: '更新檔案',
            viewDiff: '目前檔案更改',
            question: '問題',
        },
        askUserQuestion: {
            submit: '提交答案',
            multipleQuestions: ({ count }: { count: number }) => `${count} 個問題`,
            other: '其他',
            otherDescription: '輸入您自己的答案',
            otherPlaceholder: '輸入您的答案...',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `終端機(命令: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `搜尋(模式: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `搜尋(路徑: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `獲取 URL(網址: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `編輯 Notebook(檔案: ${path}, 模式: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `待辦清單(數量: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Web 搜尋(查詢: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(模式: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} 處編輯)`,
            readingFile: ({ file }: { file: string }) => `正在讀取 ${file}`,
            writingFile: ({ file }: { file: string }) => `正在寫入 ${file}`,
            modifyingFile: ({ file }: { file: string }) => `正在修改 ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `正在修改 ${count} 個檔案`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} 和其他 ${count} 個`,
            showingDiff: '顯示更改',
        }
    },

    files: {
        searchPlaceholder: '搜尋檔案...',
        detachedHead: '游離 HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} 已暫存 • ${unstaged} 未暫存`,
        notRepo: '不是 git 倉庫',
        notUnderGit: '此目錄不在 git 版本控制下',
        searching: '正在搜尋檔案...',
        noFilesFound: '未找到檔案',
        noFilesInProject: '專案中沒有檔案',
        tryDifferentTerm: '嘗試不同的搜尋詞',
        searchResults: ({ count }: { count: number }) => `搜尋結果 (${count})`,
        projectRoot: '專案根目錄',
        stagedChanges: ({ count }: { count: number }) => `已暫存的更改 (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `未暫存的更改 (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `正在載入 ${fileName}...`,
        binaryFile: '二進位檔案',
        cannotDisplayBinary: '無法顯示二進位檔案內容',
        diff: '差異',
        file: '檔案',
        fileEmpty: '檔案為空',
        noChanges: '沒有要顯示的更改',
    },

    settingsVoice: {
        // Voice settings screen
        languageTitle: '語言',
        languageDescription: '選擇您希望語音助理互動使用的語言。此設定將在您的所有裝置間同步。',
        preferredLanguage: '偏好語言',
        preferredLanguageSubtitle: '語音助理回應使用的語言',
        language: {
            searchPlaceholder: '搜尋語言...',
            title: '語言',
            footer: ({ count }: { count: number }) => `${count} 種可用語言`,
            autoDetect: '自動偵測',
        }
    },

    settingsAccount: {
        // Account settings screen
        accountInformation: '帳戶資訊',
        status: '狀態',
        statusActive: '活躍',
        statusNotAuthenticated: '未驗證',
        anonymousId: '匿名 ID',
        publicId: '公共 ID',
        notAvailable: '不可用',
        linkNewDevice: '連結新裝置',
        linkNewDeviceSubtitle: '掃描 QR Code 來連結裝置',
        profile: '個人資料',
        name: '姓名',
        github: 'GitHub',
        tapToDisconnect: '點擊中斷連線',
        server: '伺服器',
        backup: '備份',
        backupDescription: '您的金鑰是恢復帳戶的唯一方法。請將其保存在安全的地方，比如密碼管理器中。',
        secretKey: '金鑰',
        tapToReveal: '點擊顯示',
        tapToHide: '點擊隱藏',
        secretKeyLabel: '金鑰（點擊複製）',
        secretKeyCopied: '金鑰已複製到剪貼簿。請將其保存在安全的地方！',
        secretKeyCopyFailed: '複製金鑰失敗',
        privacy: '隱私',
        privacyDescription: '透過分享匿名使用資料來幫助改進應用程式。不會收集個人資訊。',
        analytics: '分析',
        analyticsDisabled: '不分享資料',
        analyticsEnabled: '分享匿名使用資料',
        dangerZone: '危險區域',
        logout: '登出',
        logoutSubtitle: '登出並清除本機資料',
        logoutConfirm: '您確定要登出嗎？請確保您已備份金鑰！',
    },

    settingsLanguage: {
        // Language settings screen
        title: '語言',
        description: '選擇您希望應用程式介面使用的語言。此設定將在您的所有裝置間同步。',
        currentLanguage: '目前語言',
        automatic: '自動',
        automaticSubtitle: '從裝置設定中偵測',
        needsRestart: '語言已更改',
        needsRestartMessage: '應用程式需要重新啟動以套用新的語言設定。',
        restartNow: '立即重新啟動',
    },

    connectButton: {
        authenticate: '驗證終端',
        authenticateWithUrlPaste: '透過 URL 貼上驗證終端',
        pasteAuthUrl: '貼上來自您終端的驗證 URL',
    },

    updateBanner: {
        updateAvailable: '有可用更新',
        pressToApply: '點擊套用更新',
        whatsNew: "更新內容",
        seeLatest: '查看最新更新和改進',
        nativeUpdateAvailable: '應用程式更新可用',
        tapToUpdateAppStore: '點擊在 App Store 中更新',
        tapToUpdatePlayStore: '點擊在 Play Store 中更新',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `版本 ${version}`,
        noEntriesAvailable: '沒有可用的更新日誌條目。',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: '需要 Web 瀏覽器',
        webBrowserRequiredDescription: '出於安全原因，終端連線連結只能在 Web 瀏覽器中開啟。請使用 QR Code 掃描器或在電腦上開啟此連結。',
        processingConnection: '正在處理連線...',
        invalidConnectionLink: '無效的連線連結',
        invalidConnectionLinkDescription: '連線連結缺失或無效。請檢查 URL 並重試。',
        connectTerminal: '連線終端',
        terminalRequestDescription: '有終端正在請求連線到您的 Happy Coder 帳戶。這將允許終端安全地傳送和接收訊息。',
        connectionDetails: '連線詳情',
        publicKey: '公鑰',
        encryption: '加密',
        endToEndEncrypted: '端對端加密',
        acceptConnection: '接受連線',
        connecting: '連線中...',
        reject: '拒絕',
        security: '安全',
        securityFooter: '此連線連結在您的瀏覽器中安全處理，從未傳送到任何伺服器。您的私人資料將保持安全，只有您能解密訊息。',
        securityFooterDevice: '此連線在您的裝置上安全處理，從未傳送到任何伺服器。您的私人資料將保持安全，只有您能解密訊息。',
        clientSideProcessing: '用戶端處理',
        linkProcessedLocally: '連結在瀏覽器中本機處理',
        linkProcessedOnDevice: '連結在裝置上本機處理',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: '驗證終端',
        pasteUrlFromTerminal: '貼上來自您終端的驗證 URL',
        deviceLinkedSuccessfully: '裝置連結成功',
        terminalConnectedSuccessfully: '終端連線成功',
        invalidAuthUrl: '無效的驗證 URL',
        developerMode: '開發者模式',
        developerModeEnabled: '開發者模式已啟用',
        developerModeDisabled: '開發者模式已停用',
        disconnectGithub: '中斷 GitHub 連線',
        disconnectGithubConfirm: '您確定要中斷 GitHub 帳戶連線嗎？',
        disconnectService: ({ service }: { service: string }) =>
            `中斷 ${service} 連線`,
        disconnectServiceConfirm: ({ service }: { service: string }) =>
            `您確定要中斷 ${service} 與您帳戶的連線嗎？`,
        disconnect: '中斷連線',
        failedToConnectTerminal: '連線終端失敗',
        cameraPermissionsRequiredToConnectTerminal: '連線終端需要相機權限',
        failedToLinkDevice: '連結裝置失敗',
        cameraPermissionsRequiredToScanQr: '掃描 QR Code 需要相機權限'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: '連線終端',
        linkNewDevice: '連結新裝置',
        restoreWithSecretKey: '透過金鑰恢復',
        whatsNew: "更新日誌",
        friends: '好友',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Codex 和 Claude Code 行動用戶端',
        subtitle: '端對端加密，您的帳戶僅儲存在您的裝置上。',
        createAccount: '建立帳戶',
        linkOrRestoreAccount: '連結或恢復帳戶',
        loginWithMobileApp: '使用行動應用程式登入',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: '喜歡這個應用程式嗎？',
        feedbackPrompt: "我們很希望聽到您的回饋！",
        yesILoveIt: '是的，我喜歡！',
        notReally: '不太喜歡'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} 已複製到剪貼簿`
    },

    machine: {
        launchNewSessionInDirectory: '在目錄中啟動新工作階段',
        offlineUnableToSpawn: '裝置離線時無法啟動',
        offlineHelp: '• 確保您的電腦在線上\n• 執行 `happy daemon status` 進行診斷\n• 您是否在執行最新的 CLI 版本？請使用 `npm install -g happy-coder@latest` 升級',
        daemon: '守護程序',
        status: '狀態',
        stopDaemon: '停止守護程序',
        lastKnownPid: '最後已知 PID',
        lastKnownHttpPort: '最後已知 HTTP 連接埠',
        startedAt: '啟動時間',
        cliVersion: 'CLI 版本',
        daemonStateVersion: '守護程序狀態版本',
        activeSessions: ({ count }: { count: number }) => `活躍工作階段 (${count})`,
        machineGroup: '裝置',
        host: '主機',
        machineId: '裝置 ID',
        username: '使用者名稱',
        homeDirectory: '主目錄',
        platform: '平台',
        architecture: '架構',
        lastSeen: '最後活躍',
        never: '從未',
        metadataVersion: '中繼資料版本',
        untitledSession: '無標題工作階段',
        back: '返回',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `已切換到 ${mode} 模式`,
        unknownEvent: '未知事件',
        usageLimitUntil: ({ time }: { time: string }) => `使用限制到 ${time}`,
        unknownTime: '未知時間',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: '是，並且本次工作階段不再詢問',
            stopAndExplain: '停止，並說明該做什麼',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: '是，允許本次工作階段的所有編輯',
            yesForTool: '是，不再詢問此工具',
            noTellClaude: '否，並告訴 Claude 該如何不同地操作',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: '選擇文字範圍',
        title: '選擇文字',
        noTextProvided: '未提供文字',
        textNotFound: '文字未找到或已過期',
        textCopied: '文字已複製到剪貼簿',
        failedToCopy: '複製文字到剪貼簿失敗',
        noTextToCopy: '沒有可複製的文字',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: '程式碼已複製',
        copyFailed: '複製失敗',
        mermaidRenderFailed: '渲染 mermaid 圖表失敗',
    },

    artifacts: {
        title: '工件',
        countSingular: '1 個工件',
        countPlural: ({ count }: { count: number }) => `${count} 個工件`,
        empty: '暫無工件',
        emptyDescription: '建立您的第一個工件來儲存和組織內容',
        new: '新建工件',
        edit: '編輯工件',
        delete: '刪除',
        updateError: '更新工件失敗。請重試。',
        notFound: '未找到工件',
        discardChanges: '放棄更改？',
        discardChangesDescription: '您有未儲存的更改。確定要放棄它們嗎？',
        deleteConfirm: '刪除工件？',
        deleteConfirmDescription: '此工件將被永久刪除。',
        titlePlaceholder: '工件標題',
        bodyPlaceholder: '在此輸入內容...',
        save: '儲存',
        saving: '儲存中...',
        loading: '載入中...',
        error: '載入工件失敗',
        titleLabel: '標題',
        bodyLabel: '內容',
        emptyFieldsError: '请输入標題或內容',
        createError: '建立工件失敗。請重試。',
    },

    friends: {
        // Friends feature
        title: '好友',
        manageFriends: '管理您的好友和連結',
        searchTitle: '尋找好友',
        pendingRequests: '好友請求',
        myFriends: '我的好友',
        noFriendsYet: '您還沒有好友',
        findFriends: '尋找好友',
        remove: '刪除',
        pendingRequest: '待處理',
        sentOn: ({ date }: { date: string }) => `傳送於 ${date}`,
        accept: '接受',
        reject: '拒絕',
        addFriend: '新增好友',
        alreadyFriends: '已是好友',
        requestPending: '請求待處理',
        searchInstructions: '輸入使用者名稱搜尋好友',
        searchPlaceholder: '輸入使用者名稱...',
        searching: '搜尋中...',
        userNotFound: '未找到使用者',
        noUserFound: '未找到該使用者名稱的使用者',
        checkUsername: '請檢查使用者名稱後重試',
        howToFind: '如何尋找好友',
        findInstructions: '透過使用者名稱搜尋好友。您和您的好友都需要連結 GitHub 才能傳送好友請求。',
        requestSent: '好友請求已傳送！',
        requestAccepted: '好友請求已接受！',
        requestRejected: '好友請求已拒絕',
        friendRemoved: '好友已刪除',
        confirmRemove: '刪除好友',
        confirmRemoveMessage: '確定要刪除這位好友嗎？',
        cannotAddYourself: '您不能向自己傳送好友請求',
        bothMustHaveGithub: '雙方都必須連結 GitHub 才能成為好友',
        status: {
            none: '未連結',
            requested: '請求已傳送',
            pending: '請求待處理',
            friend: '好友',
            rejected: '已拒絕',
        },
        acceptRequest: '接受請求',
        removeFriend: '移除好友',
        removeFriendConfirm: ({ name }: { name: string }) => `確定要將 ${name} 從好友清單中移除嗎？`,
        requestSentDescription: ({ name }: { name: string }) => `您的好友請求已傳送給 ${name}`,
        requestFriendship: '請求加為好友',
        cancelRequest: '取消好友請求',
        cancelRequestConfirm: ({ name }: { name: string }) => `取消傳送給 ${name} 的好友請求？`,
        denyRequest: '拒絕請求',
        nowFriendsWith: ({ name }: { name: string }) => `您現在與 ${name} 是好友了`,
    },

    usage: {
        // Usage panel strings
        today: '今天',
        last7Days: '過去 7 天',
        last30Days: '過去 30 天',
        totalTokens: '總權杖數',
        totalCost: '總費用',
        tokens: '權杖',
        cost: '費用',
        usageOverTime: '使用趨勢',
        byModel: '按模型',
        noData: '暫無使用資料',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
        friendRequestFrom: ({ name }: { name: string }) => `${name} 向您傳送了好友請求`,
        friendRequestGeneric: '新的好友請求',
        friendAccepted: ({ name }: { name: string }) => `您現在與 ${name} 成為了好友`,
        friendAcceptedGeneric: '好友請求已接受',
    },

    profiles: {
        // Profile management feature
        title: '設定檔',
        subtitle: '管理工作階段的環境變數設定檔',
        noProfile: '無設定檔',
        noProfileDescription: '使用預設環境設定',
        defaultModel: '預設模型',
        addProfile: '新增設定檔',
        profileName: '設定檔名稱',
        enterName: '輸入設定檔名稱',
        baseURL: '基礎 URL',
        authToken: '認證權杖',
        enterToken: '輸入認證權杖',
        model: '模型',
        tmuxSession: 'Tmux 工作階段',
        enterTmuxSession: '輸入 tmux 工作階段名稱',
        tmuxTempDir: 'Tmux 暫存目錄',
        enterTmuxTempDir: '輸入暫存目錄路徑',
        tmuxUpdateEnvironment: '自動更新環境',
        nameRequired: '設定檔名稱為必填',
        deleteConfirm: '確定要刪除設定檔「{name}」嗎？',
        editProfile: '編輯設定檔',
        addProfileTitle: '新增設定檔',
        delete: {
            title: '刪除設定檔',
            message: ({ name }: { name: string }) => `確定要刪除「${name}」嗎？此操作無法復原。`,
            confirm: '刪除',
            cancel: '取消',
        },
    }
} as const;
