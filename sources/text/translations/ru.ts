import type { TranslationStructure } from '../_default';

/**
 * Russian plural helper function
 * Russian has 3 plural forms: one, few, many
 * @param options - Object containing count and the three plural forms
 * @returns The appropriate form based on Russian plural rules
 */
function plural({ count, one, few, many }: { count: number; one: string; few: string; many: string }): string {
    const n = Math.abs(count);
    const n10 = n % 10;
    const n100 = n % 100;
    
    // Rule: ends in 1 but not 11
    if (n10 === 1 && n100 !== 11) return one;
    
    // Rule: ends in 2-4 but not 12-14
    if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return few;
    
    // Rule: everything else (0, 5-9, 11-19, etc.)
    return many;
}

/**
 * Russian translations for the Happy app
 * Must match the exact structure of the English translations
 */
export const ru: TranslationStructure = {
    common: {
        // Simple string constants
        cancel: 'Отмена',
        authenticate: 'Авторизация',
        save: 'Сохранить',
        error: 'Ошибка',
        success: 'Успешно',
        ok: 'ОК',
        continue: 'Продолжить',
        back: 'Назад',
        rename: 'Переименовать',
        reset: 'Сбросить',
        logout: 'Выйти',
        yes: 'Да',
        no: 'Нет',
        version: 'Версия',
        copied: 'Скопировано',
        scanning: 'Сканирование...',
        urlPlaceholder: 'https://example.com',
        home: 'Главная',
        message: 'Сообщение',
        files: 'Файлы',
        fileViewer: 'Просмотр файла',
    },

    connect: {
        restoreAccount: 'Восстановить аккаунт',
        enterSecretKey: 'Пожалуйста, введите секретный ключ',
        invalidSecretKey: 'Неверный секретный ключ. Проверьте и попробуйте снова.',
        enterUrlManually: 'Ввести URL вручную',
    },

    settings: {
        title: 'Настройки',
        connectedAccounts: 'Подключенные аккаунты',
        github: 'GitHub',
        machines: 'Машины',
        features: 'Функции',
        account: 'Аккаунт',
        accountSubtitle: 'Управление учётной записью',
        appearance: 'Внешний вид',
        appearanceSubtitle: 'Настройка внешнего вида приложения',
        voiceAssistant: 'Голосовой ассистент',
        voiceAssistantSubtitle: 'Настройка предпочтений голосового взаимодействия',
        featuresTitle: 'Возможности',
        featuresSubtitle: 'Включить или отключить функции приложения',
        developer: 'Разработчик',
        developerTools: 'Инструменты разработчика',
        about: 'О программе',
        aboutFooter: 'Happy Coder — мобильное приложение для работы с Claude Code. Использует сквозное шифрование, все данные аккаунта хранятся только на вашем устройстве. Не связано с Anthropic.',
        whatsNew: 'Что нового',
        whatsNewSubtitle: 'Посмотреть последние обновления и улучшения',
        reportIssue: 'Сообщить о проблеме',
        privacyPolicy: 'Политика конфиденциальности',
        termsOfService: 'Условия использования',
        eula: 'EULA',
        supportUs: 'Поддержите нас',
        supportUsSubtitlePro: 'Спасибо за вашу поддержку!',
        supportUsSubtitle: 'Поддержать разработку проекта',
        scanQrCodeToAuthenticate: 'Отсканируйте QR-код для авторизации',
        githubConnected: ({ login }: { login: string }) => `Подключен как @${login}`,
        connectGithubAccount: 'Подключить аккаунт GitHub',

        // Dynamic settings messages
        accountConnected: ({ service }: { service: string }) => `Аккаунт ${service} подключен`,
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} ${status === 'online' ? 'online' : 'offline'}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'включена' : 'отключена'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Тема',
        themeDescription: 'Выберите предпочтительную цветовую схему',
        themeOptions: {
            adaptive: 'Адаптивная',
            light: 'Светлая', 
            dark: 'Тёмная',
        },
        themeDescriptions: {
            adaptive: 'Следовать настройкам системы',
            light: 'Всегда использовать светлую тему',
            dark: 'Всегда использовать тёмную тему',
        },
        display: 'Отображение',
        displayDescription: 'Управление макетом и интервалами',
        inlineToolCalls: 'Встроенные вызовы инструментов',
        inlineToolCallsDescription: 'Отображать вызовы инструментов прямо в сообщениях чата',
        expandTodoLists: 'Развернуть списки задач',
        expandTodoListsDescription: 'Показывать все задачи вместо только изменений',
        showLineNumbersInDiffs: 'Показывать номера строк в различиях',
        showLineNumbersInDiffsDescription: 'Отображать номера строк в различиях кода',
        showLineNumbersInToolViews: 'Показывать номера строк в представлениях инструментов',
        showLineNumbersInToolViewsDescription: 'Отображать номера строк в различиях представлений инструментов',
        alwaysShowContextSize: 'Всегда показывать размер контекста',
        alwaysShowContextSizeDescription: 'Отображать использование контекста даже когда не близко к лимиту',
        avatarStyle: 'Стиль аватара',
        avatarStyleDescription: 'Выберите внешний вид аватара сессии',
        avatarOptions: {
            pixelated: 'Пиксельная',
            gradient: 'Градиентная',
            brutalist: 'Бруталистская',
        },
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Эксперименты',
        experimentsDescription: 'Включить экспериментальные функции, которые всё ещё разрабатываются. Эти функции могут быть нестабильными или изменяться без предупреждения.',
        experimentalFeatures: 'Экспериментальные функции',
        experimentalFeaturesEnabled: 'Экспериментальные функции включены',
        experimentalFeaturesDisabled: 'Используются только стабильные функции',
        webFeatures: 'Веб-функции',
        webFeaturesDescription: 'Функции, доступные только в веб-версии приложения.',
        commandPalette: 'Command Palette',
        commandPaletteEnabled: 'Нажмите ⌘K для открытия',
        commandPaletteDisabled: 'Быстрый доступ к командам отключён',
    },

    errors: {
        networkError: 'Произошла ошибка сети',
        serverError: 'Произошла ошибка сервера',
        unknownError: 'Произошла неизвестная ошибка',
        connectionTimeout: 'Время соединения истекло',
        authenticationFailed: 'Ошибка авторизации',
        permissionDenied: 'Доступ запрещен',
        fileNotFound: 'Файл не найден',
        invalidFormat: 'Неверный формат',
        operationFailed: 'Операция не выполнена',
        tryAgain: 'Пожалуйста, попробуйте снова',
        contactSupport: 'Если проблема сохранится, обратитесь в поддержку',
        sessionNotFound: 'Сессия не найдена',
        voiceSessionFailed: 'Не удалось запустить голосовую сессию',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} должно быть от ${min} до ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Повторить через ${seconds} ${plural({ count: seconds, one: 'секунду', few: 'секунды', many: 'секунд' })}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Ошибка ${code})`,
    },

    newSession: {
        // Used by new-session screen and launch flows
        title: 'Начать новую сессию',
        noMachinesFound: 'Машины не найдены. Сначала запустите сессию Happy на вашем компьютере.',
        allMachinesOffline: 'Все машины находятся offline',
        machineOfflineHelp: {
            computerOnline: '• Ваш компьютер online?',
            daemonRunning: '• Запущен ли daemon Happy? Проверьте командой `happy daemon status`'
        },
        machineDetails: 'Посмотреть детали машины →',
        sessionStarted: 'Сессия запущена',
        sessionStartedMessage: 'Сессия была запущена, но может потребоваться время для появления.',
        sessionSpawningFailed: 'Ошибка создания сессии - ID сессии не получен.',
        failedToStart: 'Не удалось запустить сессию. Убедитесь, что daemon запущен на целевой машине.',
        sessionTimeout: 'Время запуска сессии истекло. Машина может работать медленно или daemon не отвечает.',
        notConnectedToServer: 'Нет подключения к серверу. Проверьте интернет-соединение.'
    },

    server: {
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: 'Настройка сервера',
        enterServerUrl: 'Пожалуйста, введите URL сервера',
        notValidHappyServer: 'Это не валидный сервер Happy',
        changeServer: 'Изменить сервер',
        continueWithServer: 'Продолжить с этим сервером?',
        resetToDefault: 'Сбросить по умолчанию',
        resetServerDefault: 'Сбросить сервер по умолчанию?',
        validating: 'Проверка...',
        validatingServer: 'Проверка сервера...',
        serverReturnedError: 'Сервер вернул ошибку',
        failedToConnectToServer: 'Не удалось подключиться к серверу',
        currentlyUsingCustomServer: 'Сейчас используется пользовательский сервер',
        customServerUrlLabel: 'URL пользовательского сервера',
        advancedFeatureFooter: 'Это расширенная функция. Изменяйте сервер только если знаете, что делаете. Вам нужно будет выйти и войти снова после изменения серверов.'
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Завершить сессию',
        killSessionConfirm: 'Вы уверены, что хотите завершить эту сессию?',
        happySessionIdCopied: 'ID сессии Happy скопирован в буфер обмена',
        failedToCopySessionId: 'Не удалось скопировать ID сессии Happy',
        happySessionId: 'ID сессии Happy',
        claudeCodeSessionId: 'ID сессии Claude Code',
        claudeCodeSessionIdCopied: 'ID сессии Claude Code скопирован в буфер обмена',
        failedToCopyClaudeCodeSessionId: 'Не удалось скопировать ID сессии Claude Code',
        metadataCopied: 'Метаданные скопированы в буфер обмена',
        failedToCopyMetadata: 'Не удалось скопировать метаданные',
        failedToKillSession: 'Не удалось завершить сессию',
        connectionStatus: 'Статус подключения',
        created: 'Создано',
        lastUpdated: 'Последнее обновление',
        sequence: 'Последовательность',
        quickActions: 'Быстрые действия',
        viewMachine: 'Посмотреть машину',
        viewMachineSubtitle: 'Посмотреть детали машины и сессии',
        killSessionSubtitle: 'Немедленно завершить сессию',
        metadata: 'Метаданные',
        host: 'Хост',
        path: 'Путь',
        operatingSystem: 'Операционная система',
        processId: 'ID процесса',
        happyHome: 'Домашний каталог Happy',
        copyMetadata: 'Копировать метаданные',
        agentState: 'Состояние агента',
        controlledByUser: 'Управляется пользователем',
        pendingRequests: 'Ожидающие запросы',
        activity: 'Активность',
        thinking: 'Думает',
        thinkingSince: 'Думает с',
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Готовы к программированию?',
            installCli: 'Установите Happy CLI',
            runIt: 'Запустите его',
            scanQrCode: 'Отсканируйте QR-код',
            openCamera: 'Открыть камеру',
        },
    },

    status: {
        connected: 'подключено',
        connecting: 'подключение',
        disconnected: 'отключено',
        error: 'ошибка',
        online: 'online',
        offline: 'offline',
    },

    session: {
        inputPlaceholder: 'Введите сообщение...',
    },

    commandPalette: {
        placeholder: 'Введите команду или поиск...',
    },

    agentInput: {
        permissionMode: {
            title: 'РЕЖИМ РАЗРЕШЕНИЙ',
            default: 'По умолчанию',
            acceptEdits: 'Принимать правки',
            plan: 'Режим планирования',
            bypassPermissions: 'YOLO режим',
            badgeAcceptAllEdits: 'Принимать все правки',
            badgeBypassAllPermissions: 'Обход всех разрешений',
            badgePlanMode: 'Режим планирования',
        },
        model: {
            title: 'МОДЕЛЬ',
            default: 'Использовать настройки CLI',
            adaptiveUsage: 'Opus до 50% использования, затем Sonnet',
            sonnet: 'Sonnet',
            opus: 'Opus',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `Осталось ${percent}%`,
        },
        suggestion: {
            fileLabel: 'ФАЙЛ',
            folderLabel: 'ПАПКА',
        }
    },

    machineLauncher: {
        showLess: 'Показать меньше',
        showAll: ({ count }: { count: number }) => `Показать все (${count} ${plural({ count, one: 'путь', few: 'пути', many: 'путей' })})`,
        enterCustomPath: 'Ввести свой путь',
        offlineUnableToSpawn: 'Невозможно создать сессию, машина offline',
    },

    sidebar: {
        sessionsTitle: 'Сессии',
    },

    toolView: {
        input: 'Входные данные',
        output: 'Результат',
    },

    tools: {
        fullView: {
            description: 'Описание',
            inputParams: 'Входные параметры',
            output: 'Результат',
            error: 'Ошибка',
            completed: 'Инструмент выполнен успешно',
            noOutput: 'Результат не получен',
            running: 'Выполняется...',
            rawJsonDevMode: 'Исходный JSON (режим разработчика)',
        },
        taskView: {
            initializing: 'Инициализация агента...',
            moreTools: ({ count }: { count: number }) => `+${count} ещё ${plural({ count, one: 'инструмент', few: 'инструмента', many: 'инструментов' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Правка ${index} из ${total}`,
            replaceAll: 'Заменить все',
        },
        names: {
            task: 'Задача',
            terminal: 'Терминал',
            searchFiles: 'Поиск файлов',
            search: 'Поиск',
            searchContent: 'Поиск содержимого',
            listFiles: 'Список файлов',
            planProposal: 'Предложение плана',
            readFile: 'Чтение файла',
            editFile: 'Редактирование файла',
            writeFile: 'Запись файла',
            fetchUrl: 'Получение URL',
            readNotebook: 'Чтение блокнота',
            editNotebook: 'Редактирование блокнота',
            todoList: 'Список задач',
            webSearch: 'Веб-поиск',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Терминал(команда: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Поиск(шаблон: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Поиск(путь: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Получение URL(адрес: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Редактирование блокнота(файл: ${path}, режим: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Список задач(количество: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Веб-поиск(запрос: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(шаблон: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} ${plural({ count, one: 'правка', few: 'правки', many: 'правок' })})`,
        }
    },

    files: {
        searchPlaceholder: 'Поиск файлов...',
        detachedHead: 'отделённый HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} подготовлено • ${unstaged} не подготовлено`,
        notRepo: 'Не является git-репозиторием',
        notUnderGit: 'Эта папка не находится под управлением git',
        searching: 'Поиск файлов...',
        noFilesFound: 'Файлы не найдены',
        noFilesInProject: 'Файлов в проекте нет',
        tryDifferentTerm: 'Попробуйте другой поисковый запрос',
        searchResults: ({ count }: { count: number }) => `Результаты поиска (${count})`,
        projectRoot: 'Корень проекта',
        stagedChanges: ({ count }: { count: number }) => `Подготовленные изменения (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Неподготовленные изменения (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Загрузка ${fileName}...`,
        binaryFile: 'Бинарный файл',
        cannotDisplayBinary: 'Невозможно отобразить содержимое бинарного файла',
        diff: 'Различия',
        file: 'Файл',
        fileEmpty: 'Файл пустой',
        noChanges: 'Нет изменений для отображения',
    },

    settingsVoice: {
        // Voice settings screen
        languageTitle: 'Язык',
        languageDescription: 'Выберите предпочтительный язык для взаимодействия с голосовым помощником. Эта настройка синхронизируется на всех ваших устройствах.',
        preferredLanguage: 'Предпочтительный язык',
        preferredLanguageSubtitle: 'Язык, используемый для ответов голосового помощника',
        language: {
            searchPlaceholder: 'Поиск языков...',
            title: 'Языки',
            footer: ({ count }: { count: number }) => `Доступно ${count} ${plural({ count, one: 'язык', few: 'языка', many: 'языков' })}`,
            autoDetect: 'Автоопределение',
        }
    },

    settingsAccount: {
        // Account settings screen
        accountInformation: 'Информация об аккаунте',
        status: 'Статус',
        statusActive: 'Активный',
        statusNotAuthenticated: 'Не авторизован',
        anonymousId: 'Анонимный ID',
        publicId: 'Публичный ID',
        notAvailable: 'Недоступно',
        linkNewDevice: 'Привязать новое устройство',
        linkNewDeviceSubtitle: 'Отсканируйте QR-код для привязки устройства',
        profile: 'Профиль',
        name: 'Имя',
        github: 'GitHub',
        tapToDisconnect: 'Нажмите для отключения',
        server: 'Сервер',
        backup: 'Резервная копия',
        backupDescription: 'Ваш секретный ключ - единственный способ восстановить ваш аккаунт. Сохраните его в безопасном месте, например в менеджере паролей.',
        secretKey: 'Секретный ключ',
        tapToReveal: 'Нажмите для показа',
        tapToHide: 'Нажмите для скрытия',
        secretKeyLabel: 'СЕКРЕТНЫЙ КЛЮЧ (НАЖМИТЕ ДЛЯ КОПИРОВАНИЯ)',
        secretKeyCopied: 'Секретный ключ скопирован в буфер обмена. Сохраните его в безопасном месте!',
        secretKeyCopyFailed: 'Не удалось скопировать секретный ключ',
        privacy: 'Конфиденциальность',
        privacyDescription: 'Помогите улучшить приложение, поделившись анонимными данными об использовании. Никакая личная информация не собирается.',
        analytics: 'Аналитика',
        analyticsDisabled: 'Данные не передаются',
        analyticsEnabled: 'Анонимные данные об использовании передаются',
        dangerZone: 'Опасная зона',
        logout: 'Выйти',
        logoutSubtitle: 'Выйти из аккаунта и очистить локальные данные',
        logoutConfirm: 'Вы уверены, что хотите выйти? Убедитесь, что вы сохранили резервную копию секретного ключа!',
    },

    connectButton: {
        authenticate: 'Авторизация терминала',
        authenticateWithUrlPaste: 'Авторизация терминала через URL',
        pasteAuthUrl: 'Вставьте авторизационный URL из терминала',
    },

    updateBanner: {
        updateAvailable: 'Доступно обновление',
        pressToApply: 'Нажмите, чтобы применить обновление',
        whatsNew: 'Что нового',
        seeLatest: 'Посмотреть последние обновления и улучшения',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Версия ${version}`,
        noEntriesAvailable: 'Записи журнала изменений недоступны.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Требуется веб-браузер',
        webBrowserRequiredDescription: 'Ссылки подключения терминала можно открывать только в веб-браузере по соображениям безопасности. Используйте сканер QR-кодов или откройте эту ссылку на компьютере.',
        processingConnection: 'Обработка подключения...',
        invalidConnectionLink: 'Неверная ссылка подключения',
        invalidConnectionLinkDescription: 'Ссылка подключения отсутствует или неверна. Проверьте URL и попробуйте снова.',
        connectTerminal: 'Подключить терминал',
        terminalRequestDescription: 'Терминал запрашивает подключение к вашему аккаунту Happy Coder. Это позволит терминалу безопасно отправлять и получать сообщения.',
        connectionDetails: 'Детали подключения',
        publicKey: 'Публичный ключ',
        encryption: 'Шифрование',
        endToEndEncrypted: 'Сквозное шифрование',
        acceptConnection: 'Принять подключение',
        connecting: 'Подключение...',
        reject: 'Отклонить',
        security: 'Безопасность',
        securityFooter: 'Эта ссылка подключения была безопасно обработана в вашем браузере и никогда не отправлялась на сервер. Ваши личные данные останутся в безопасности, и только вы можете расшифровать сообщения.',
        securityFooterDevice: 'Это подключение было безопасно обработано на вашем устройстве и никогда не отправлялось на сервер. Ваши личные данные останутся в безопасности, и только вы можете расшифровать сообщения.',
        clientSideProcessing: 'Обработка на стороне клиента',
        linkProcessedLocally: 'Ссылка обработана локально в браузере',
        linkProcessedOnDevice: 'Ссылка обработана локально на устройстве',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Авторизация терминала',
        pasteUrlFromTerminal: 'Вставьте URL авторизации из вашего терминала',
        deviceLinkedSuccessfully: 'Устройство успешно связано',
        terminalConnectedSuccessfully: 'Терминал успешно подключен',
        invalidAuthUrl: 'Неверный URL авторизации',
        developerMode: 'Режим разработчика',
        developerModeEnabled: 'Режим разработчика включен',
        developerModeDisabled: 'Режим разработчика отключен',
        disconnectGithub: 'Отключить GitHub',
        disconnectGithubConfirm: 'Вы уверены, что хотите отключить аккаунт GitHub?',
        disconnect: 'Отключить',
        failedToConnectTerminal: 'Не удалось подключить терминал',
        cameraPermissionsRequiredToConnectTerminal: 'Для подключения терминала требуется доступ к камере',
        failedToLinkDevice: 'Не удалось связать устройство',
        cameraPermissionsRequiredToScanQr: 'Для сканирования QR-кодов требуется доступ к камере'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Подключить терминал',
        linkNewDevice: 'Связать новое устройство',
        restoreWithSecretKey: 'Восстановить секретным ключом',
        whatsNew: 'Что нового',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Мобильный клиент Claude Code',
        subtitle: 'Сквозное шифрование, аккаунт хранится только на вашем устройстве.',
        createAccount: 'Создать аккаунт',
        linkOrRestoreAccount: 'Связать или восстановить аккаунт',
        loginWithMobileApp: 'Войти через мобильное приложение',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Нравится приложение?',
        feedbackPrompt: 'Мы будем рады вашему отзыву!',
        yesILoveIt: 'Да, мне нравится!',
        notReally: 'Не совсем'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} скопировано в буфер обмена`
    },

    machine: {
        launchNewSessionInDirectory: 'Запустить новую сессию в папке',
        daemon: 'Daemon',
        status: 'Статус',
        stopDaemon: 'Остановить daemon',
        lastKnownPid: 'Последний известный PID',
        lastKnownHttpPort: 'Последний известный HTTP порт',
        startedAt: 'Запущен в',
        cliVersion: 'Версия CLI',
        daemonStateVersion: 'Версия состояния daemon',
        activeSessions: ({ count }: { count: number }) => `Активные сессии (${count})`,
        machineGroup: 'Машина',
        host: 'Хост',
        machineId: 'ID машины',
        username: 'Имя пользователя',
        homeDirectory: 'Домашний каталог',
        platform: 'Платформа',
        architecture: 'Архитектура',
        lastSeen: 'Последняя активность',
        never: 'Никогда',
        metadataVersion: 'Версия метаданных',
        untitledSession: 'Безымянная сессия',
        back: 'Назад',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Переключено в режим ${mode}`,
        unknownEvent: 'Неизвестное событие',
        usageLimitUntil: ({ time }: { time: string }) => `Лимит использования достигнут до ${time}`,
        unknownTime: 'неизвестное время',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Язык',
        description: 'Выберите предпочтительный язык интерфейса приложения. Настройки синхронизируются на всех ваших устройствах.',
        currentLanguage: 'Текущий язык',
        automatic: 'Автоматически',
        automaticSubtitle: 'Определять по настройкам устройства',
        needsRestart: 'Язык изменён',
        needsRestartMessage: 'Приложение нужно перезапустить для применения новых языковых настроек.',
        restartNow: 'Перезапустить',
        languages: {
            en: 'English',
            ru: 'Русский',
        }
    },
} as const;

export type TranslationsRu = typeof ru;
