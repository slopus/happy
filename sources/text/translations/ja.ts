/**
 * Japanese translations for the Happy app
 * Values can be:
 * - String constants for static text
 * - Functions with typed object parameters for dynamic text
 */

import { TranslationStructure } from "../_default";

/**
 * Japanese plural helper function
 * Japanese doesn't have grammatical plurals, so this just returns the appropriate form
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on count
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

export const ja: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        inbox: '受信トレイ',
        sessions: 'ターミナル',
        settings: '設定',
    },

    inbox: {
        // Inbox screen
        emptyTitle: '受信トレイは空です',
        emptyDescription: '友達と接続してセッションを共有しましょう',
        updates: '更新',
    },

    common: {
        // Simple string constants
        cancel: 'キャンセル',
        authenticate: '認証',
        save: '保存',
        error: 'エラー',
        success: '成功',
        ok: 'OK',
        continue: '続行',
        back: '戻る',
        create: '作成',
        rename: '名前を変更',
        reset: 'リセット',
        logout: 'ログアウト',
        yes: 'はい',
        no: 'いいえ',
        discard: '破棄',
        version: 'バージョン',
        copied: 'コピーしました',
        copy: 'コピー',
        scanning: 'スキャン中...',
        urlPlaceholder: 'https://example.com',
        home: 'ホーム',
        message: 'メッセージ',
        files: 'ファイル',
        fileViewer: 'ファイルビューアー',
        loading: '読み込み中...',
        retry: '再試行',
        delete: '削除',
        optional: '任意',
        saveAs: '名前を付けて保存',
    },

    profile: {
        userProfile: 'ユーザープロフィール',
        details: '詳細',
        firstName: '名',
        lastName: '姓',
        username: 'ユーザー名',
        status: 'ステータス',
    },

    profiles: {
        title: 'プロファイル',
        subtitle: 'セッション用の環境変数プロファイルを管理',
        noProfile: 'プロファイルなし',
        noProfileDescription: 'デフォルトの環境設定を使用',
        defaultModel: 'デフォルトモデル',
        addProfile: 'プロファイルを追加',
        profileName: 'プロファイル名',
        enterName: 'プロファイル名を入力',
        baseURL: 'ベースURL',
        authToken: '認証トークン',
        enterToken: '認証トークンを入力',
        model: 'モデル',
        tmuxSession: 'Tmuxセッション',
        enterTmuxSession: 'tmuxセッション名を入力',
        tmuxTempDir: 'Tmux一時ディレクトリ',
        enterTmuxTempDir: '一時ディレクトリのパスを入力',
        tmuxUpdateEnvironment: '環境を自動更新',
        nameRequired: 'プロファイル名は必須です',
        deleteConfirm: 'プロファイル「{name}」を削除してもよろしいですか？',
        editProfile: 'プロファイルを編集',
        addProfileTitle: '新しいプロファイルを追加',
        delete: {
            title: 'プロファイルを削除',
            message: ({ name }: { name: string }) => `「${name}」を削除してもよろしいですか？この操作は元に戻せません。`,
            confirm: '削除',
            cancel: 'キャンセル',
        },
    },

    status: {
        connected: '接続済み',
        connecting: '接続中',
        disconnected: '切断済み',
        error: 'エラー',
        online: 'オンライン',
        offline: 'オフライン',
        lastSeen: ({ time }: { time: string }) => `最終アクセス: ${time}`,
        permissionRequired: '権限が必要です',
        activeNow: 'アクティブ',
        unknown: '不明',
    },

    time: {
        justNow: 'たった今',
        minutesAgo: ({ count }: { count: number }) => `${count}分前`,
        hoursAgo: ({ count }: { count: number }) => `${count}時間前`,
    },

    connect: {
        restoreAccount: 'アカウントを復元',
        enterSecretKey: 'シークレットキーを入力してください',
        invalidSecretKey: 'シークレットキーが無効です。確認して再試行してください。',
        enterUrlManually: 'URLを手動で入力',
    },

    settings: {
        title: '設定',
        connectedAccounts: '接続済みアカウント',
        connectAccount: 'アカウントを接続',
        github: 'GitHub',
        machines: 'マシン',
        features: '機能',
        social: 'ソーシャル',
        account: 'アカウント',
        accountSubtitle: 'アカウントの詳細を管理',
        appearance: '外観',
        appearanceSubtitle: 'アプリの見た目をカスタマイズ',
        voiceAssistant: '音声アシスタント',
        voiceAssistantSubtitle: '音声操作の設定',
        featuresTitle: '機能',
        featuresSubtitle: 'アプリ機能の有効/無効を切り替え',
        developer: '開発者',
        developerTools: '開発者ツール',
        about: 'このアプリについて',
        aboutFooter: 'Happy CoderはCodexとClaude Codeのモバイルクライアントです。完全なエンドツーエンド暗号化を採用し、アカウントはデバイスにのみ保存されます。Anthropicとは提携していません。',
        whatsNew: '新機能',
        whatsNewSubtitle: '最新のアップデートと改善を確認',
        reportIssue: '問題を報告',
        privacyPolicy: 'プライバシーポリシー',
        termsOfService: '利用規約',
        eula: 'EULA',
        supportUs: '開発を支援',
        supportUsSubtitlePro: 'ご支援ありがとうございます！',
        supportUsSubtitle: 'プロジェクト開発を支援',
        scanQrCodeToAuthenticate: 'QRコードをスキャンして認証',
        githubConnected: ({ login }: { login: string }) => `@${login}として接続中`,
        connectGithubAccount: 'GitHubアカウントを接続',
        claudeAuthSuccess: 'Claudeへの接続に成功しました',
        exchangingTokens: 'トークンを交換中...',
        usage: '使用状況',
        usageSubtitle: 'API使用量とコストを確認',
        profiles: 'プロファイル',
        profilesSubtitle: 'セッション用の環境変数プロファイルを管理',

        // Dynamic settings messages
        accountConnected: ({ service }: { service: string }) => `${service}アカウントが接続されました`,
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name}は${status === 'online' ? 'オンライン' : 'オフライン'}です`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature}を${enabled ? '有効' : '無効'}にしました`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'テーマ',
        themeDescription: 'お好みの配色を選択',
        themeOptions: {
            adaptive: '自動',
            light: 'ライト',
            dark: 'ダーク',
        },
        themeDescriptions: {
            adaptive: 'システム設定に合わせる',
            light: '常にライトテーマを使用',
            dark: '常にダークテーマを使用',
        },
        display: '表示',
        displayDescription: 'レイアウトと間隔を調整',
        inlineToolCalls: 'ツール呼び出しをインライン表示',
        inlineToolCallsDescription: 'チャットメッセージ内にツール呼び出しを直接表示',
        expandTodoLists: 'Todoリストを展開',
        expandTodoListsDescription: '変更点だけでなくすべてのTodoを表示',
        showLineNumbersInDiffs: '差分に行番号を表示',
        showLineNumbersInDiffsDescription: 'コード差分に行番号を表示',
        showLineNumbersInToolViews: 'ツールビューに行番号を表示',
        showLineNumbersInToolViewsDescription: 'ツールビューの差分に行番号を表示',
        wrapLinesInDiffs: '差分で行を折り返し',
        wrapLinesInDiffsDescription: '差分表示で水平スクロールの代わりに長い行を折り返す',
        alwaysShowContextSize: '常にコンテキストサイズを表示',
        alwaysShowContextSizeDescription: '上限に近づいていなくてもコンテキスト使用量を表示',
        avatarStyle: 'アバタースタイル',
        avatarStyleDescription: 'セッションアバターの外観を選択',
        avatarOptions: {
            pixelated: 'ピクセル',
            gradient: 'グラデーション',
            brutalist: 'ブルータリスト',
        },
        showFlavorIcons: 'AIプロバイダーアイコンを表示',
        showFlavorIconsDescription: 'セッションアバターにAIプロバイダーアイコンを表示',
        compactSessionView: 'コンパクトセッション表示',
        compactSessionViewDescription: 'アクティブなセッションをコンパクトなレイアウトで表示',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: '実験的機能',
        experimentsDescription: '開発中の実験的機能を有効にします。これらの機能は不安定であったり、予告なく変更される場合があります。',
        experimentalFeatures: '実験的機能',
        experimentalFeaturesEnabled: '実験的機能が有効です',
        experimentalFeaturesDisabled: '安定版機能のみを使用',
        webFeatures: 'Web機能',
        webFeaturesDescription: 'Webバージョンでのみ利用可能な機能。',
        enterToSend: 'Enterで送信',
        enterToSendEnabled: 'Enterで送信（Shift+Enterで改行）',
        enterToSendDisabled: 'Enterで改行',
        commandPalette: 'コマンドパレット',
        commandPaletteEnabled: '⌘Kで開く',
        commandPaletteDisabled: 'クイックコマンドアクセスは無効',
        markdownCopyV2: 'Markdownコピー v2',
        markdownCopyV2Subtitle: '長押しでコピーモーダルを開く',
        hideInactiveSessions: '非アクティブセッションを非表示',
        hideInactiveSessionsSubtitle: 'アクティブなチャットのみをリストに表示',
        enhancedSessionWizard: '拡張セッションウィザード',
        enhancedSessionWizardEnabled: 'プロファイル優先セッションランチャーが有効',
        enhancedSessionWizardDisabled: '標準セッションランチャーを使用',
    },

    errors: {
        networkError: 'ネットワークエラーが発生しました',
        serverError: 'サーバーエラーが発生しました',
        unknownError: '不明なエラーが発生しました',
        connectionTimeout: '接続がタイムアウトしました',
        authenticationFailed: '認証に失敗しました',
        permissionDenied: '権限がありません',
        fileNotFound: 'ファイルが見つかりません',
        invalidFormat: 'フォーマットが無効です',
        operationFailed: '操作に失敗しました',
        tryAgain: '再試行してください',
        contactSupport: '問題が続く場合はサポートにお問い合わせください',
        sessionNotFound: 'セッションが見つかりません',
        voiceSessionFailed: '音声セッションの開始に失敗しました',
        voiceServiceUnavailable: '音声サービスは一時的に利用できません',
        oauthInitializationFailed: 'OAuth フローの初期化に失敗しました',
        tokenStorageFailed: '認証トークンの保存に失敗しました',
        oauthStateMismatch: 'セキュリティ検証に失敗しました。再試行してください',
        tokenExchangeFailed: '認可コードの交換に失敗しました',
        oauthAuthorizationDenied: '認可が拒否されました',
        webViewLoadFailed: '認証ページの読み込みに失敗しました',
        failedToLoadProfile: 'ユーザープロフィールの読み込みに失敗しました',
        userNotFound: 'ユーザーが見つかりません',
        sessionDeleted: 'セッションは削除されました',
        sessionDeletedDescription: 'このセッションは完全に削除されました',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field}は${min}から${max}の間である必要があります`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `${seconds}秒後に再試行`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (エラー ${code})`,
        disconnectServiceFailed: ({ service }: { service: string }) =>
            `${service}の切断に失敗しました`,
        connectServiceFailed: ({ service }: { service: string }) =>
            `${service}の接続に失敗しました。再試行してください。`,
        failedToLoadFriends: '友達リストの読み込みに失敗しました',
        failedToAcceptRequest: '友達リクエストの承認に失敗しました',
        failedToRejectRequest: '友達リクエストの拒否に失敗しました',
        failedToRemoveFriend: '友達の削除に失敗しました',
        searchFailed: '検索に失敗しました。再試行してください。',
        failedToSendRequest: '友達リクエストの送信に失敗しました',
    },

    newSession: {
        // Used by new-session screen and launch flows
        title: '新しいセッションを開始',
        noMachinesFound: 'マシンが見つかりません。まずコンピューターでHappyセッションを起動してください。',
        allMachinesOffline: 'すべてのマシンがオフラインです',
        machineDetails: 'マシンの詳細を表示 →',
        directoryDoesNotExist: 'ディレクトリが見つかりません',
        createDirectoryConfirm: ({ directory }: { directory: string }) => `ディレクトリ ${directory} は存在しません。作成しますか？`,
        sessionStarted: 'セッションが開始されました',
        sessionStartedMessage: 'セッションが正常に開始されました。',
        sessionSpawningFailed: 'セッションの生成に失敗しました - セッションIDが返されませんでした。',
        startingSession: 'セッションを開始中...',
        startNewSessionInFolder: 'このフォルダで新しいセッション',
        failedToStart: 'セッションの開始に失敗しました。ターゲットマシンでデーモンが実行中か確認してください。',
        sessionTimeout: 'セッションの開始がタイムアウトしました。マシンが遅いか、デーモンが応答していない可能性があります。',
        notConnectedToServer: 'サーバーに接続されていません。インターネット接続を確認してください。',
        noMachineSelected: 'セッションを開始するマシンを選択してください',
        noPathSelected: 'セッションを開始するディレクトリを選択してください',
        sessionType: {
            title: 'セッションタイプ',
            simple: 'シンプル',
            worktree: 'ワークツリー',
            comingSoon: '近日公開',
        },
        worktree: {
            creating: ({ name }: { name: string }) => `ワークツリー '${name}' を作成中...`,
            notGitRepo: 'ワークツリーにはGitリポジトリが必要です',
            failed: ({ error }: { error: string }) => `ワークツリーの作成に失敗しました: ${error}`,
            success: 'ワークツリーが正常に作成されました',
        }
    },

    sessionHistory: {
        // Used by session history screen
        title: 'セッション履歴',
        empty: 'セッションが見つかりません',
        today: '今日',
        yesterday: '昨日',
        daysAgo: ({ count }: { count: number }) => `${count}日前`,
        viewAll: 'すべてのセッションを表示',
    },

    session: {
        inputPlaceholder: 'メッセージを入力...',
    },

    commandPalette: {
        placeholder: 'コマンドを入力または検索...',
    },

    server: {
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: 'サーバー設定',
        enterServerUrl: 'サーバーURLを入力してください',
        notValidHappyServer: '有効なHappy Serverではありません',
        changeServer: 'サーバーを変更',
        continueWithServer: 'このサーバーで続行しますか？',
        resetToDefault: 'デフォルトにリセット',
        resetServerDefault: 'サーバーをデフォルトにリセットしますか？',
        validating: '検証中...',
        validatingServer: 'サーバーを検証中...',
        serverReturnedError: 'サーバーがエラーを返しました',
        failedToConnectToServer: 'サーバーへの接続に失敗しました',
        currentlyUsingCustomServer: '現在カスタムサーバーを使用中',
        customServerUrlLabel: 'カスタムサーバーURL',
        advancedFeatureFooter: "これは高度な機能です。何をしているか理解している場合のみサーバーを変更してください。サーバー変更後は再度ログインが必要です。"
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'セッションを終了',
        killSessionConfirm: 'このセッションを終了してもよろしいですか？',
        archiveSession: 'セッションをアーカイブ',
        archiveSessionConfirm: 'このセッションをアーカイブしてもよろしいですか？',
        happySessionIdCopied: 'Happy Session IDがクリップボードにコピーされました',
        failedToCopySessionId: 'Happy Session IDのコピーに失敗しました',
        happySessionId: 'Happy Session ID',
        claudeCodeSessionId: 'Claude Code Session ID',
        claudeCodeSessionIdCopied: 'Claude Code Session IDがクリップボードにコピーされました',
        aiProvider: 'AIプロバイダー',
        failedToCopyClaudeCodeSessionId: 'Claude Code Session IDのコピーに失敗しました',
        metadataCopied: 'メタデータがクリップボードにコピーされました',
        failedToCopyMetadata: 'メタデータのコピーに失敗しました',
        failedToKillSession: 'セッションの終了に失敗しました',
        failedToArchiveSession: 'セッションのアーカイブに失敗しました',
        connectionStatus: '接続状態',
        created: '作成日時',
        lastUpdated: '最終更新',
        sequence: 'シーケンス',
        quickActions: 'クイックアクション',
        viewMachine: 'マシンを表示',
        viewMachineSubtitle: 'マシンの詳細とセッションを表示',
        killSessionSubtitle: 'セッションを即座に終了',
        archiveSessionSubtitle: 'このセッションをアーカイブして停止',
        metadata: 'メタデータ',
        host: 'ホスト',
        path: 'パス',
        operatingSystem: 'オペレーティングシステム',
        processId: 'プロセスID',
        happyHome: 'Happy Home',
        copyMetadata: 'メタデータをコピー',
        agentState: 'エージェント状態',
        controlledByUser: 'ユーザーによる制御',
        pendingRequests: '保留中のリクエスト',
        activity: 'アクティビティ',
        thinking: '思考中',
        thinkingSince: '思考開始時刻',
        cliVersion: 'CLIバージョン',
        cliVersionOutdated: 'CLIの更新が必要',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `バージョン ${currentVersion} がインストールされています。${requiredVersion} 以降に更新してください`,
        updateCliInstructions: 'npm install -g happy-coder@latest を実行してください',
        deleteSession: 'セッションを削除',
        deleteSessionSubtitle: 'このセッションを完全に削除',
        deleteSessionConfirm: 'セッションを完全に削除しますか？',
        deleteSessionWarning: 'この操作は取り消せません。このセッションに関連するすべてのメッセージとデータが完全に削除されます。',
        failedToDeleteSession: 'セッションの削除に失敗しました',
        sessionDeleted: 'セッションが正常に削除されました',

    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'コーディングを始めますか？',
            installCli: 'Happy CLIをインストール',
            runIt: '実行する',
            scanQrCode: 'QRコードをスキャン',
            openCamera: 'カメラを開く',
        },
    },

    agentInput: {
        permissionMode: {
            title: '権限モード',
            default: 'デフォルト',
            acceptEdits: '編集を許可',
            plan: 'プランモード',
            bypassPermissions: 'Yoloモード',
            badgeAcceptAllEdits: 'すべての編集を許可',
            badgeBypassAllPermissions: 'すべての権限をバイパス',
            badgePlanMode: 'プランモード',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
        },
        model: {
            title: 'モデル',
            configureInCli: 'CLIの設定でモデルを構成',
        },
        codexPermissionMode: {
            title: 'CODEX権限モード',
            default: 'CLI設定',
            readOnly: '読み取り専用モード',
            safeYolo: 'セーフYOLO',
            yolo: 'YOLO',
            badgeReadOnly: '読み取り専用モード',
            badgeSafeYolo: 'セーフYOLO',
            badgeYolo: 'YOLO',
        },
        codexModel: {
            title: 'CODEXモデル',
            gpt5CodexLow: 'gpt-5-codex 低',
            gpt5CodexMedium: 'gpt-5-codex 中',
            gpt5CodexHigh: 'gpt-5-codex 高',
            gpt5Minimal: 'GPT-5 最小',
            gpt5Low: 'GPT-5 低',
            gpt5Medium: 'GPT-5 中',
            gpt5High: 'GPT-5 高',
        },
        geminiPermissionMode: {
            title: 'GEMINI権限モード',
            default: 'デフォルト',
            acceptEdits: '編集を許可',
            plan: 'プランモード',
            bypassPermissions: 'Yoloモード',
            badgeAcceptAllEdits: 'すべての編集を許可',
            badgeBypassAllPermissions: 'すべての権限をバイパス',
            badgePlanMode: 'プランモード',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `残り ${percent}%`,
        },
        suggestion: {
            fileLabel: 'ファイル',
            folderLabel: 'フォルダ',
        },
        noMachinesAvailable: 'マシンなし',
    },

    machineLauncher: {
        showLess: '折りたたむ',
        showAll: ({ count }: { count: number }) => `すべて表示 (${count}パス)`,
        enterCustomPath: 'カスタムパスを入力',
        offlineUnableToSpawn: 'オフラインのため新しいセッションを生成できません',
    },

    sidebar: {
        sessionsTitle: 'Happy',
    },

    toolView: {
        input: '入力',
        output: '出力',
    },

    tools: {
        fullView: {
            description: '説明',
            inputParams: '入力パラメータ',
            output: '出力',
            error: 'エラー',
            completed: 'ツールが正常に完了しました',
            noOutput: '出力がありません',
            running: 'ツールを実行中...',
            rawJsonDevMode: 'Raw JSON (開発モード)',
        },
        taskView: {
            initializing: 'エージェントを初期化中...',
            moreTools: ({ count }: { count: number }) => `+${count} 個のツール`,
        },
        askUserQuestion: {
            submit: '回答を送信',
            multipleQuestions: ({ count }: { count: number }) => `${count}件の質問`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `編集 ${index}/${total}`,
            replaceAll: 'すべて置換',
        },
        names: {
            task: 'タスク',
            terminal: 'ターミナル',
            searchFiles: 'ファイル検索',
            search: '検索',
            searchContent: 'コンテンツ検索',
            listFiles: 'ファイル一覧',
            planProposal: 'プラン提案',
            readFile: 'ファイル読み取り',
            editFile: 'ファイル編集',
            writeFile: 'ファイル書き込み',
            fetchUrl: 'URL取得',
            readNotebook: 'ノートブック読み取り',
            editNotebook: 'ノートブック編集',
            todoList: 'Todoリスト',
            webSearch: 'Web検索',
            reasoning: '推論',
            applyChanges: 'ファイルを更新',
            viewDiff: '現在のファイル変更',
            question: '質問',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `ターミナル(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `検索(pattern: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `検索(path: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `URL取得(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `ノートブック編集(file: ${path}, mode: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Todoリスト(count: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Web検索(query: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(pattern: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count}件の編集)`,
            readingFile: ({ file }: { file: string }) => `${file}を読み取り中`,
            writingFile: ({ file }: { file: string }) => `${file}に書き込み中`,
            modifyingFile: ({ file }: { file: string }) => `${file}を変更中`,
            modifyingFiles: ({ count }: { count: number }) => `${count}ファイルを変更中`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} 他${count}件`,
            showingDiff: '変更を表示中',
        }
    },

    files: {
        searchPlaceholder: 'ファイルを検索...',
        detachedHead: 'detached HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `ステージ済み ${staged} • 未ステージ ${unstaged}`,
        notRepo: 'Gitリポジトリではありません',
        notUnderGit: 'このディレクトリはGitバージョン管理下にありません',
        searching: 'ファイルを検索中...',
        noFilesFound: 'ファイルが見つかりません',
        noFilesInProject: 'プロジェクトにファイルがありません',
        tryDifferentTerm: '別の検索語を試してください',
        searchResults: ({ count }: { count: number }) => `検索結果 (${count})`,
        projectRoot: 'プロジェクトルート',
        stagedChanges: ({ count }: { count: number }) => `ステージ済みの変更 (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `未ステージの変更 (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `${fileName}を読み込み中...`,
        binaryFile: 'バイナリファイル',
        cannotDisplayBinary: 'バイナリファイルの内容を表示できません',
        diff: '差分',
        file: 'ファイル',
        fileEmpty: 'ファイルは空です',
        noChanges: '表示する変更はありません',
    },

    settingsVoice: {
        // Voice settings screen
        languageTitle: '言語',
        languageDescription: '音声アシスタントの操作に使用する言語を選択します。この設定はすべてのデバイスで同期されます。',
        preferredLanguage: '優先言語',
        preferredLanguageSubtitle: '音声アシスタントの応答に使用する言語',
        language: {
            searchPlaceholder: '言語を検索...',
            title: '言語',
            footer: ({ count }: { count: number }) => `${count}言語が利用可能`,
            autoDetect: '自動検出',
        }
    },

    settingsAccount: {
        // Account settings screen
        accountInformation: 'アカウント情報',
        status: 'ステータス',
        statusActive: 'アクティブ',
        statusNotAuthenticated: '未認証',
        anonymousId: '匿名ID',
        publicId: '公開ID',
        notAvailable: '利用不可',
        linkNewDevice: '新しいデバイスをリンク',
        linkNewDeviceSubtitle: 'QRコードをスキャンしてデバイスをリンク',
        profile: 'プロフィール',
        name: '名前',
        github: 'GitHub',
        tapToDisconnect: 'タップして切断',
        server: 'サーバー',
        backup: 'バックアップ',
        backupDescription: 'シークレットキーはアカウントを復元する唯一の方法です。パスワードマネージャーなどの安全な場所に保存してください。',
        secretKey: 'シークレットキー',
        tapToReveal: 'タップして表示',
        tapToHide: 'タップして非表示',
        secretKeyLabel: 'シークレットキー (タップでコピー)',
        secretKeyCopied: 'シークレットキーがクリップボードにコピーされました。安全な場所に保管してください！',
        secretKeyCopyFailed: 'シークレットキーのコピーに失敗しました',
        privacy: 'プライバシー',
        privacyDescription: '匿名の使用データを共有してアプリの改善にご協力ください。個人情報は収集されません。',
        analytics: 'アナリティクス',
        analyticsDisabled: 'データは共有されません',
        analyticsEnabled: '匿名の使用データが共有されます',
        dangerZone: '危険ゾーン',
        logout: 'ログアウト',
        logoutSubtitle: 'サインアウトしてローカルデータを消去',
        logoutConfirm: 'ログアウトしてもよろしいですか？シークレットキーのバックアップを取っていることを確認してください！',
    },

    settingsLanguage: {
        // Language settings screen
        title: '言語',
        description: 'アプリインターフェースの言語を選択します。この設定はすべてのデバイスで同期されます。',
        currentLanguage: '現在の言語',
        automatic: '自動',
        automaticSubtitle: 'デバイス設定から検出',
        needsRestart: '言語が変更されました',
        needsRestartMessage: '新しい言語設定を適用するにはアプリの再起動が必要です。',
        restartNow: '今すぐ再起動',
    },

    connectButton: {
        authenticate: 'ターミナルを認証',
        authenticateWithUrlPaste: 'URLペーストでターミナルを認証',
        pasteAuthUrl: 'ターミナルから認証URLを貼り付け',
    },

    updateBanner: {
        updateAvailable: 'アップデートが利用可能',
        pressToApply: 'タップしてアップデートを適用',
        whatsNew: "新機能",
        seeLatest: '最新のアップデートと改善を確認',
        nativeUpdateAvailable: 'アプリのアップデートが利用可能',
        tapToUpdateAppStore: 'タップしてApp Storeで更新',
        tapToUpdatePlayStore: 'タップしてPlay Storeで更新',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `バージョン ${version}`,
        noEntriesAvailable: '変更履歴はありません。',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Webブラウザが必要です',
        webBrowserRequiredDescription: 'ターミナル接続リンクはセキュリティ上の理由からWebブラウザでのみ開くことができます。QRコードスキャナーを使用するか、コンピューターでこのリンクを開いてください。',
        processingConnection: '接続を処理中...',
        invalidConnectionLink: '無効な接続リンク',
        invalidConnectionLinkDescription: '接続リンクが見つからないか無効です。URLを確認して再試行してください。',
        connectTerminal: 'ターミナルを接続',
        terminalRequestDescription: 'ターミナルがHappy Coderアカウントへの接続を要求しています。これにより、ターミナルは安全にメッセージを送受信できるようになります。',
        connectionDetails: '接続の詳細',
        publicKey: '公開鍵',
        encryption: '暗号化',
        endToEndEncrypted: 'エンドツーエンド暗号化',
        acceptConnection: '接続を承認',
        connecting: '接続中...',
        reject: '拒否',
        security: 'セキュリティ',
        securityFooter: 'この接続リンクはブラウザ内で安全に処理され、サーバーには送信されませんでした。あなたのプライベートデータは安全に保たれ、メッセージを復号できるのはあなただけです。',
        securityFooterDevice: 'この接続はデバイス上で安全に処理され、サーバーには送信されませんでした。あなたのプライベートデータは安全に保たれ、メッセージを復号できるのはあなただけです。',
        clientSideProcessing: 'クライアントサイド処理',
        linkProcessedLocally: 'リンクはブラウザ内でローカルに処理されました',
        linkProcessedOnDevice: 'リンクはデバイス上でローカルに処理されました',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'ターミナルを認証',
        pasteUrlFromTerminal: 'ターミナルから認証URLを貼り付けてください',
        deviceLinkedSuccessfully: 'デバイスが正常にリンクされました',
        terminalConnectedSuccessfully: 'ターミナルが正常に接続されました',
        invalidAuthUrl: '無効な認証URL',
        developerMode: '開発者モード',
        developerModeEnabled: '開発者モードが有効になりました',
        developerModeDisabled: '開発者モードが無効になりました',
        disconnectGithub: 'GitHubを切断',
        disconnectGithubConfirm: 'GitHubアカウントを切断してもよろしいですか？',
        disconnectService: ({ service }: { service: string }) =>
            `${service}を切断`,
        disconnectServiceConfirm: ({ service }: { service: string }) =>
            `${service}をアカウントから切断してもよろしいですか？`,
        disconnect: '切断',
        failedToConnectTerminal: 'ターミナルの接続に失敗しました',
        cameraPermissionsRequiredToConnectTerminal: 'ターミナルの接続にはカメラの権限が必要です',
        failedToLinkDevice: 'デバイスのリンクに失敗しました',
        cameraPermissionsRequiredToScanQr: 'QRコードのスキャンにはカメラの権限が必要です'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'ターミナルを接続',
        linkNewDevice: '新しいデバイスをリンク',
        restoreWithSecretKey: 'シークレットキーで復元',
        whatsNew: "新機能",
        friends: '友達',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'CodexとClaude Codeのモバイルクライアント',
        subtitle: 'エンドツーエンド暗号化され、アカウントはデバイスにのみ保存されます。',
        createAccount: 'アカウントを作成',
        linkOrRestoreAccount: 'アカウントをリンクまたは復元',
        loginWithMobileApp: 'モバイルアプリでログイン',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'アプリを気に入っていただけましたか？',
        feedbackPrompt: "ご意見をお聞かせください！",
        yesILoveIt: 'はい、気に入りました！',
        notReally: 'あまり...'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label}がクリップボードにコピーされました`
    },

    machine: {
        launchNewSessionInDirectory: 'ディレクトリで新しいセッションを起動',
        offlineUnableToSpawn: 'マシンがオフラインのためランチャーは無効です',
        offlineHelp: '• コンピューターがオンラインであることを確認してください\n• `happy daemon status`を実行して診断してください\n• 最新のCLIバージョンを使用していますか？`npm install -g happy-coder@latest`でアップグレードしてください',
        daemon: 'デーモン',
        status: 'ステータス',
        stopDaemon: 'デーモンを停止',
        lastKnownPid: '最後に確認されたPID',
        lastKnownHttpPort: '最後に確認されたHTTPポート',
        startedAt: '開始時刻',
        cliVersion: 'CLIバージョン',
        daemonStateVersion: 'デーモン状態バージョン',
        activeSessions: ({ count }: { count: number }) => `アクティブセッション (${count})`,
        machineGroup: 'マシン',
        host: 'ホスト',
        machineId: 'マシンID',
        username: 'ユーザー名',
        homeDirectory: 'ホームディレクトリ',
        platform: 'プラットフォーム',
        architecture: 'アーキテクチャ',
        lastSeen: '最終確認',
        never: 'なし',
        metadataVersion: 'メタデータバージョン',
        untitledSession: '無題のセッション',
        back: '戻る',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `${mode}モードに切り替えました`,
        unknownEvent: '不明なイベント',
        usageLimitUntil: ({ time }: { time: string }) => `${time}まで使用制限中`,
        unknownTime: '不明な時間',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: "はい、このセッションでは確認しない",
            stopAndExplain: '停止して、何をすべきか説明',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'はい、このセッション中のすべての編集を許可',
            yesForTool: "はい、このツールについては確認しない",
            noTellClaude: 'いいえ、フィードバックを提供',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: 'テキスト範囲を選択',
        title: 'テキストを選択',
        noTextProvided: 'テキストが提供されていません',
        textNotFound: 'テキストが見つからないか期限切れです',
        textCopied: 'テキストがクリップボードにコピーされました',
        failedToCopy: 'テキストのクリップボードへのコピーに失敗しました',
        noTextToCopy: 'コピーできるテキストがありません',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'コードをコピーしました',
        copyFailed: 'コピーに失敗しました',
        mermaidRenderFailed: 'Mermaidダイアグラムのレンダリングに失敗しました',
    },

    artifacts: {
        // Artifacts feature
        title: 'アーティファクト',
        countSingular: '1件のアーティファクト',
        countPlural: ({ count }: { count: number }) => `${count}件のアーティファクト`,
        empty: 'アーティファクトはまだありません',
        emptyDescription: '最初のアーティファクトを作成して始めましょう',
        new: '新規アーティファクト',
        edit: 'アーティファクトを編集',
        delete: '削除',
        updateError: 'アーティファクトの更新に失敗しました。再試行してください。',
        notFound: 'アーティファクトが見つかりません',
        discardChanges: '変更を破棄しますか？',
        discardChangesDescription: '保存されていない変更があります。破棄してもよろしいですか？',
        deleteConfirm: 'アーティファクトを削除しますか？',
        deleteConfirmDescription: 'この操作は取り消せません',
        titleLabel: 'タイトル',
        titlePlaceholder: 'アーティファクトのタイトルを入力',
        bodyLabel: 'コンテンツ',
        bodyPlaceholder: 'ここにコンテンツを書いてください...',
        emptyFieldsError: 'タイトルまたはコンテンツを入力してください',
        createError: 'アーティファクトの作成に失敗しました。再試行してください。',
        save: '保存',
        saving: '保存中...',
        loading: 'アーティファクトを読み込み中...',
        error: 'アーティファクトの読み込みに失敗しました',
    },

    friends: {
        // Friends feature
        title: '友達',
        manageFriends: '友達とつながりを管理',
        searchTitle: '友達を探す',
        pendingRequests: '友達リクエスト',
        myFriends: 'マイフレンド',
        noFriendsYet: "まだ友達がいません",
        findFriends: '友達を探す',
        remove: '削除',
        pendingRequest: '保留中',
        sentOn: ({ date }: { date: string }) => `送信日: ${date}`,
        accept: '承認',
        reject: '拒否',
        addFriend: '友達を追加',
        alreadyFriends: '既に友達です',
        requestPending: 'リクエスト保留中',
        searchInstructions: '友達を検索するにはユーザー名を入力してください',
        searchPlaceholder: 'ユーザー名を入力...',
        searching: '検索中...',
        userNotFound: 'ユーザーが見つかりません',
        noUserFound: 'そのユーザー名のユーザーが見つかりません',
        checkUsername: 'ユーザー名を確認して再試行してください',
        howToFind: '友達を見つける方法',
        findInstructions: 'ユーザー名で友達を検索します。友達リクエストを送信するには、両方のユーザーがGitHubを接続している必要があります。',
        requestSent: '友達リクエストが送信されました！',
        requestAccepted: '友達リクエストが承認されました！',
        requestRejected: '友達リクエストが拒否されました',
        friendRemoved: '友達が削除されました',
        confirmRemove: '友達を削除',
        confirmRemoveMessage: 'この友達を削除してもよろしいですか？',
        cannotAddYourself: '自分自身に友達リクエストを送信することはできません',
        bothMustHaveGithub: '友達になるには、両方のユーザーがGitHubを接続している必要があります',
        status: {
            none: '未接続',
            requested: 'リクエスト送信済み',
            pending: 'リクエスト保留中',
            friend: '友達',
            rejected: '拒否済み',
        },
        acceptRequest: 'リクエストを承認',
        removeFriend: '友達を削除',
        removeFriendConfirm: ({ name }: { name: string }) => `${name}さんを友達から削除してもよろしいですか？`,
        requestSentDescription: ({ name }: { name: string }) => `${name}さんに友達リクエストが送信されました`,
        requestFriendship: '友達リクエストを送信',
        cancelRequest: '友達リクエストをキャンセル',
        cancelRequestConfirm: ({ name }: { name: string }) => `${name}さんへの友達リクエストをキャンセルしますか？`,
        denyRequest: '友達リクエストを拒否',
        nowFriendsWith: ({ name }: { name: string }) => `${name}さんと友達になりました`,
    },

    usage: {
        // Usage panel strings
        today: '今日',
        last7Days: '過去7日間',
        last30Days: '過去30日間',
        totalTokens: '合計トークン',
        totalCost: '合計コスト',
        tokens: 'トークン',
        cost: 'コスト',
        usageOverTime: '使用量の推移',
        byModel: 'モデル別',
        noData: '使用データがありません',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
        friendRequestFrom: ({ name }: { name: string }) => `${name}さんから友達リクエストが届きました`,
        friendRequestGeneric: '新しい友達リクエスト',
        friendAccepted: ({ name }: { name: string }) => `${name}さんと友達になりました`,
        friendAcceptedGeneric: '友達リクエストが承認されました',
    }
} as const;
