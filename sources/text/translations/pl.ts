import type { TranslationStructure } from '../_default';

/**
 * Polish plural helper function
 * Polish has 3 plural forms: one, few, many
 * @param options - Object containing count and the three plural forms
 * @returns The appropriate form based on Polish plural rules
 */
function plural({ count, one, few, many }: { count: number; one: string; few: string; many: string }): string {
    const n = Math.abs(count);
    const n10 = n % 10;
    const n100 = n % 100;
    
    // Rule: 1 (but not 11)
    if (n === 1) return one;
    
    // Rule: 2-4 but not 12-14
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    
    // Rule: everything else (0, 5-19, 11, 12-14, etc.)
    return many;
}

/**
 * Polish translations for the Happy app
 * Must match the exact structure of the English translations
 */
export const pl: TranslationStructure = {
    common: {
        // Simple string constants
        cancel: 'Anuluj',
        authenticate: 'Uwierzytelnij',
        save: 'Zapisz',
        error: 'Błąd',
        success: 'Sukces',
        ok: 'OK',
        continue: 'Kontynuuj',
        back: 'Wstecz',
        create: 'Utwórz',
        rename: 'Zmień nazwę',
        reset: 'Resetuj',
        logout: 'Wyloguj',
        yes: 'Tak',
        no: 'Nie',
        version: 'Wersja',
        copied: 'Skopiowano',
        scanning: 'Skanowanie...',
        urlPlaceholder: 'https://example.com',
        home: 'Główna',
        message: 'Wiadomość',
        files: 'Pliki',
        fileViewer: 'Przeglądarka plików',
        loading: 'Ładowanie...',
        retry: 'Ponów',
    },

    status: {
        connected: 'połączono',
        connecting: 'łączenie',
        disconnected: 'rozłączono',
        error: 'błąd',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `ostatnio widziano ${time}`,
        permissionRequired: 'wymagane uprawnienie',
        activeNow: 'Aktywny teraz',
        unknown: 'nieznane',
    },

    time: {
        justNow: 'teraz',
        minutesAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'minuta', few: 'minuty', many: 'minut' })} temu`,
        hoursAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'godzina', few: 'godziny', many: 'godzin' })} temu`,
    },

    connect: {
        restoreAccount: 'Przywróć konto',
        enterSecretKey: 'Proszę wprowadzić klucz tajny',
        invalidSecretKey: 'Nieprawidłowy klucz tajny. Sprawdź i spróbuj ponownie.',
        enterUrlManually: 'Wprowadź URL ręcznie',
    },

    settings: {
        title: 'Ustawienia',
        connectedAccounts: 'Połączone konta',
        connectAccount: 'Połącz konto',
        github: 'GitHub',
        machines: 'Maszyny',
        features: 'Funkcje',
        account: 'Konto',
        accountSubtitle: 'Zarządzaj szczegółami konta',
        appearance: 'Wygląd',
        appearanceSubtitle: 'Dostosuj wygląd aplikacji',
        voiceAssistant: 'Asystent głosowy',
        voiceAssistantSubtitle: 'Konfiguruj preferencje interakcji głosowej',
        featuresTitle: 'Funkcje',
        featuresSubtitle: 'Włącz lub wyłącz funkcje aplikacji',
        developer: 'Deweloper',
        developerTools: 'Narzędzia deweloperskie',
        about: 'O aplikacji',
        aboutFooter: 'Happy Coder to mobilny klient Claude Code. Jest w pełni szyfrowany end-to-end, a Twoje konto jest przechowywane tylko na Twoim urządzeniu. Nie jest powiązany z Anthropic.',
        whatsNew: 'Co nowego',
        whatsNewSubtitle: 'Zobacz najnowsze aktualizacje i ulepszenia',
        reportIssue: 'Zgłoś problem',
        privacyPolicy: 'Polityka prywatności',
        termsOfService: 'Warunki użytkowania',
        eula: 'EULA',
        supportUs: 'Wesprzyj nas',
        supportUsSubtitlePro: 'Dziękujemy za wsparcie!',
        supportUsSubtitle: 'Wesprzyj rozwój projektu',
        scanQrCodeToAuthenticate: 'Zeskanuj kod QR, aby się uwierzytelnić',
        githubConnected: ({ login }: { login: string }) => `Połączono jako @${login}`,
        connectGithubAccount: 'Połącz konto GitHub',
        claudeAuthSuccess: 'Pomyślnie połączono z Claude',
        exchangingTokens: 'Wymiana tokenów...',

        // Dynamic settings messages
        accountConnected: ({ service }: { service: string }) => `Konto ${service} połączone`,
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} jest ${status === 'online' ? 'online' : 'offline'}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'włączona' : 'wyłączona'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Motyw',
        themeDescription: 'Wybierz preferowaną kolorystykę',
        themeOptions: {
            adaptive: 'Adaptacyjny',
            light: 'Jasny',
            dark: 'Ciemny',
        },
        themeDescriptions: {
            adaptive: 'Dopasuj do ustawień systemu',
            light: 'Zawsze używaj jasnego motywu',
            dark: 'Zawsze używaj ciemnego motywu',
        },
        display: 'Wyświetlanie',
        displayDescription: 'Kontroluj układ i odstępy',
        inlineToolCalls: 'Wbudowane wywołania narzędzi',
        inlineToolCallsDescription: 'Wyświetlaj wywołania narzędzi bezpośrednio w wiadomościach czatu',
        expandTodoLists: 'Rozwiń listy zadań',
        expandTodoListsDescription: 'Pokazuj wszystkie zadania zamiast tylko zmian',
        showLineNumbersInDiffs: 'Pokaż numery linii w różnicach',
        showLineNumbersInDiffsDescription: 'Wyświetlaj numery linii w różnicach kodu',
        showLineNumbersInToolViews: 'Pokaż numery linii w widokach narzędzi',
        showLineNumbersInToolViewsDescription: 'Wyświetlaj numery linii w różnicach widoków narzędzi',
        alwaysShowContextSize: 'Zawsze pokazuj rozmiar kontekstu',
        alwaysShowContextSizeDescription: 'Wyświetlaj użycie kontekstu nawet gdy nie jest blisko limitu',
        avatarStyle: 'Styl awatara',
        avatarStyleDescription: 'Wybierz wygląd awatara sesji',
        avatarOptions: {
            pixelated: 'Pikselowy',
            gradient: 'Gradientowy',
            brutalist: 'Brutalistyczny',
        },
        compactSessionView: 'Kompaktowy widok sesji',
        compactSessionViewDescription: 'Pokazuj aktywne sesje w bardziej zwartym układzie',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Eksperymenty',
        experimentsDescription: 'Włącz eksperymentalne funkcje, które są nadal w rozwoju. Te funkcje mogą być niestabilne lub zmienić się bez ostrzeżenia.',
        experimentalFeatures: 'Funkcje eksperymentalne',
        experimentalFeaturesEnabled: 'Funkcje eksperymentalne włączone',
        experimentalFeaturesDisabled: 'Używane tylko stabilne funkcje',
        webFeatures: 'Funkcje webowe',
        webFeaturesDescription: 'Funkcje dostępne tylko w wersji webowej aplikacji.',
        commandPalette: 'Paleta poleceń',
        commandPaletteEnabled: 'Naciśnij ⌘K, aby otworzyć',
        commandPaletteDisabled: 'Szybki dostęp do poleceń wyłączony',
    },

    errors: {
        networkError: 'Wystąpił błąd sieci',
        serverError: 'Wystąpił błąd serwera',
        unknownError: 'Wystąpił nieznany błąd',
        connectionTimeout: 'Przekroczono czas oczekiwania na połączenie',
        authenticationFailed: 'Uwierzytelnienie nie powiodło się',
        permissionDenied: 'Brak uprawnień',
        fileNotFound: 'Plik nie został znaleziony',
        invalidFormat: 'Nieprawidłowy format',
        operationFailed: 'Operacja nie powiodła się',
        tryAgain: 'Spróbuj ponownie',
        contactSupport: 'Skontaktuj się z pomocą techniczną, jeśli problem będzie się powtarzał',
        sessionNotFound: 'Sesja nie została znaleziona',
        voiceSessionFailed: 'Nie udało się uruchomić sesji głosowej',
        oauthInitializationFailed: 'Nie udało się zainicjować przepływu OAuth',
        tokenStorageFailed: 'Nie udało się zapisać tokenów uwierzytelniania',
        oauthStateMismatch: 'Weryfikacja bezpieczeństwa nie powiodła się. Spróbuj ponownie',
        tokenExchangeFailed: 'Nie udało się wymienić kodu autoryzacji',
        oauthAuthorizationDenied: 'Autoryzacja została odrzucona',
        webViewLoadFailed: 'Nie udało się załadować strony uwierzytelniania',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} musi być między ${min} a ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Ponów próbę za ${seconds} ${plural({ count: seconds, one: 'sekundę', few: 'sekundy', many: 'sekund' })}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Błąd ${code})`,
        disconnectServiceFailed: ({ service }: { service: string }) => 
            `Nie udało się rozłączyć ${service}`,
        connectServiceFailed: ({ service }: { service: string }) =>
            `Nie udało się połączyć z ${service}. Spróbuj ponownie.`,
    },

    newSession: {
        // Used by new-session screen and launch flows
        title: 'Rozpocznij nową sesję',
        noMachinesFound: 'Nie znaleziono maszyn. Najpierw uruchom sesję Happy na swoim komputerze.',
        allMachinesOffline: 'Wszystkie maszyny są offline',
        machineOfflineHelp: {
            computerOnline: '• Czy Twój komputer jest online?',
            daemonRunning: '• Czy daemon Happy działa? Sprawdź poleceniem `happy daemon status`'
        },
        machineDetails: 'Zobacz szczegóły maszyny →',
        directoryDoesNotExist: 'Katalog nie został znaleziony',
        createDirectoryConfirm: ({ directory }: { directory: string }) => `Katalog ${directory} nie istnieje. Czy chcesz go utworzyć?`,
        sessionStarted: 'Sesja rozpoczęta',
        sessionStartedMessage: 'Sesja została pomyślnie rozpoczęta.',
        sessionSpawningFailed: 'Tworzenie sesji nie powiodło się - nie zwrócono ID sesji.',
        failedToStart: 'Nie udało się uruchomić sesji. Upewnij się, że daemon działa na docelowej maszynie.',
        sessionTimeout: 'Przekroczono czas uruchamiania sesji. Maszyna może działać wolno lub daemon może nie odpowiadać.',
        notConnectedToServer: 'Brak połączenia z serwerem. Sprawdź połączenie internetowe.',
        startingSession: 'Rozpoczynanie sesji...',
        startNewSessionInFolder: 'Rozpocznij nową sesję w tym folderze'
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Historia sesji',
        empty: 'Nie znaleziono sesji',
        today: 'Dzisiaj',
        yesterday: 'Wczoraj',
        daysAgo: ({ count }: { count: number }) => `${count} ${plural({ count, one: 'dzień', few: 'dni', many: 'dni' })} temu`,
        viewAll: 'Zobacz wszystkie sesje',
    },

    session: {
        inputPlaceholder: 'Wpisz wiadomość...',
    },

    commandPalette: {
        placeholder: 'Wpisz polecenie lub wyszukaj...',
    },

    server: {
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: 'Konfiguracja serwera',
        enterServerUrl: 'Proszę wprowadzić URL serwera',
        notValidHappyServer: 'To nie jest prawidłowy serwer Happy',
        changeServer: 'Zmień serwer',
        continueWithServer: 'Kontynuować z tym serwerem?',
        resetToDefault: 'Resetuj do domyślnego',
        resetServerDefault: 'Zresetować serwer do domyślnego?',
        validating: 'Sprawdzanie...',
        validatingServer: 'Sprawdzanie serwera...',
        serverReturnedError: 'Serwer zwrócił błąd',
        failedToConnectToServer: 'Nie udało się połączyć z serwerem',
        currentlyUsingCustomServer: 'Aktualnie używany jest niestandardowy serwer',
        customServerUrlLabel: 'URL niestandardowego serwera',
        advancedFeatureFooter: 'To jest zaawansowana funkcja. Zmieniaj serwer tylko jeśli wiesz, co robisz. Po zmianie serwera będziesz musiał się wylogować i zalogować ponownie.'
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Zakończ sesję',
        killSessionConfirm: 'Czy na pewno chcesz zakończyć tę sesję?',
        happySessionIdCopied: 'ID sesji Happy skopiowane do schowka',
        failedToCopySessionId: 'Nie udało się skopiować ID sesji Happy',
        happySessionId: 'ID sesji Happy',
        claudeCodeSessionId: 'ID sesji Claude Code',
        claudeCodeSessionIdCopied: 'ID sesji Claude Code skopiowane do schowka',
        failedToCopyClaudeCodeSessionId: 'Nie udało się skopiować ID sesji Claude Code',
        metadataCopied: 'Metadane skopiowane do schowka',
        failedToCopyMetadata: 'Nie udało się skopiować metadanych',
        failedToKillSession: 'Nie udało się zakończyć sesji',
        connectionStatus: 'Status połączenia',
        created: 'Utworzono',
        lastUpdated: 'Ostatnia aktualizacja',
        sequence: 'Sekwencja',
        quickActions: 'Szybkie akcje',
        viewMachine: 'Zobacz maszynę',
        viewMachineSubtitle: 'Zobacz szczegóły maszyny i sesje',
        killSessionSubtitle: 'Natychmiastowo zakończ sesję',
        metadata: 'Metadane',
        host: 'Host',
        path: 'Ścieżka',
        operatingSystem: 'System operacyjny',
        processId: 'ID procesu',
        happyHome: 'Katalog domowy Happy',
        copyMetadata: 'Kopiuj metadane',
        agentState: 'Stan agenta',
        controlledByUser: 'Kontrolowany przez użytkownika',
        pendingRequests: 'Oczekujące żądania',
        activity: 'Aktywność',
        thinking: 'Myśli',
        thinkingSince: 'Myśli od',
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Gotowy do kodowania?',
            installCli: 'Zainstaluj Happy CLI',
            runIt: 'Uruchom je',
            scanQrCode: 'Zeskanuj kod QR',
            openCamera: 'Otwórz kamerę',
        },
    },

    agentInput: {
        permissionMode: {
            title: 'TRYB UPRAWNIEŃ',
            default: 'Domyślny',
            acceptEdits: 'Akceptuj edycje',
            plan: 'Tryb planowania',
            bypassPermissions: 'Tryb YOLO',
            badgeAcceptAllEdits: 'Akceptuj wszystkie edycje',
            badgeBypassAllPermissions: 'Omiń wszystkie uprawnienia',
            badgePlanMode: 'Tryb planowania',
        },
        model: {
            title: 'MODEL',
            default: 'Użyj ustawień CLI',
            adaptiveUsage: 'Opus do 50% użycia, potem Sonnet',
            sonnet: 'Sonnet',
            opus: 'Opus',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `Pozostało ${percent}%`,
        },
        suggestion: {
            fileLabel: 'PLIK',
            folderLabel: 'FOLDER',
        }
    },

    machineLauncher: {
        showLess: 'Pokaż mniej',
        showAll: ({ count }: { count: number }) => `Pokaż wszystkie (${count} ${plural({ count, one: 'ścieżka', few: 'ścieżki', many: 'ścieżek' })})`,
        enterCustomPath: 'Wprowadź niestandardową ścieżkę',
        offlineUnableToSpawn: 'Nie można utworzyć nowej sesji, offline',
    },

    sidebar: {
        sessionsTitle: 'Sesje',
    },

    toolView: {
        input: 'Wejście',
        output: 'Wyjście',
    },

    tools: {
        fullView: {
            description: 'Opis',
            inputParams: 'Parametry wejściowe',
            output: 'Wyjście',
            error: 'Błąd',
            completed: 'Narzędzie ukończone pomyślnie',
            noOutput: 'Nie wygenerowano żadnego wyjścia',
            running: 'Narzędzie działa...',
            rawJsonDevMode: 'Surowy JSON (tryb deweloperski)',
        },
        taskView: {
            initializing: 'Inicjalizacja agenta...',
            moreTools: ({ count }: { count: number }) => `+${count} ${plural({ count, one: 'więcej narzędzie', few: 'więcej narzędzia', many: 'więcej narzędzi' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Edycja ${index} z ${total}`,
            replaceAll: 'Zamień wszystkie',
        },
        names: {
            task: 'Zadanie',
            terminal: 'Terminal',
            searchFiles: 'Wyszukaj pliki',
            search: 'Wyszukaj',
            searchContent: 'Wyszukaj zawartość',
            listFiles: 'Lista plików',
            planProposal: 'Propozycja planu',
            readFile: 'Czytaj plik',
            editFile: 'Edytuj plik',
            writeFile: 'Zapisz plik',
            fetchUrl: 'Pobierz URL',
            readNotebook: 'Czytaj notatnik',
            editNotebook: 'Edytuj notatnik',
            todoList: 'Lista zadań',
            webSearch: 'Wyszukiwanie w sieci',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Wyszukaj(wzorzec: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Wyszukaj(ścieżka: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Pobierz URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Edytuj notatnik(plik: ${path}, tryb: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Lista zadań(liczba: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Wyszukiwanie w sieci(zapytanie: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(wzorzec: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} ${plural({ count, one: 'edycja', few: 'edycje', many: 'edycji' })})`,
        }
    },

    files: {
        searchPlaceholder: 'Wyszukaj pliki...',
        detachedHead: 'odłączony HEAD',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} przygotowanych • ${unstaged} nieprzygotowanych`,
        notRepo: 'To nie jest repozytorium git',
        notUnderGit: 'Ten katalog nie jest pod kontrolą wersji git',
        searching: 'Wyszukiwanie plików...',
        noFilesFound: 'Nie znaleziono plików',
        noFilesInProject: 'Brak plików w projekcie',
        tryDifferentTerm: 'Spróbuj innego terminu wyszukiwania',
        searchResults: ({ count }: { count: number }) => `Wyniki wyszukiwania (${count})`,
        projectRoot: 'Katalog główny projektu',
        stagedChanges: ({ count }: { count: number }) => `Przygotowane zmiany (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Nieprzygotowane zmiany (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Ładowanie ${fileName}...`,
        binaryFile: 'Plik binarny',
        cannotDisplayBinary: 'Nie można wyświetlić zawartości pliku binarnego',
        diff: 'Różnice',
        file: 'Plik',
        fileEmpty: 'Plik jest pusty',
        noChanges: 'Brak zmian do wyświetlenia',
    },

    settingsVoice: {
        // Voice settings screen
        languageTitle: 'Język',
        languageDescription: 'Wybierz preferowany język dla interakcji z asystentem głosowym. To ustawienie synchronizuje się na wszystkich Twoich urządzeniach.',
        preferredLanguage: 'Preferowany język',
        preferredLanguageSubtitle: 'Język używany do odpowiedzi asystenta głosowego',
        language: {
            searchPlaceholder: 'Wyszukaj języki...',
            title: 'Języki',
            footer: ({ count }: { count: number }) => `Dostępnych ${count} ${plural({ count, one: 'język', few: 'języki', many: 'języków' })}`,
            autoDetect: 'Automatyczne wykrywanie',
        }
    },

    settingsAccount: {
        // Account settings screen
        accountInformation: 'Informacje o koncie',
        status: 'Status',
        statusActive: 'Aktywny',
        statusNotAuthenticated: 'Nie uwierzytelniony',
        anonymousId: 'ID anonimowe',
        publicId: 'ID publiczne',
        notAvailable: 'Niedostępne',
        linkNewDevice: 'Połącz nowe urządzenie',
        linkNewDeviceSubtitle: 'Zeskanuj kod QR, aby połączyć urządzenie',
        profile: 'Profil',
        name: 'Nazwa',
        github: 'GitHub',
        tapToDisconnect: 'Dotknij, aby rozłączyć',
        server: 'Serwer',
        backup: 'Kopia zapasowa',
        backupDescription: 'Twój klucz tajny to jedyny sposób na odzyskanie konta. Zapisz go w bezpiecznym miejscu, takim jak menedżer haseł.',
        secretKey: 'Klucz tajny',
        tapToReveal: 'Dotknij, aby pokazać',
        tapToHide: 'Dotknij, aby ukryć',
        secretKeyLabel: 'KLUCZ TAJNY (DOTKNIJ, ABY SKOPIOWAĆ)',
        secretKeyCopied: 'Klucz tajny skopiowany do schowka. Przechowuj go w bezpiecznym miejscu!',
        secretKeyCopyFailed: 'Nie udało się skopiować klucza tajnego',
        privacy: 'Prywatność',
        privacyDescription: 'Pomóż ulepszyć aplikację, udostępniając anonimowe dane o użytkowaniu. Nie zbieramy żadnych informacji osobistych.',
        analytics: 'Analityka',
        analyticsDisabled: 'Dane nie są udostępniane',
        analyticsEnabled: 'Anonimowe dane o użytkowaniu są udostępniane',
        dangerZone: 'Strefa niebezpieczna',
        logout: 'Wyloguj',
        logoutSubtitle: 'Wyloguj się i wyczyść dane lokalne',
        logoutConfirm: 'Czy na pewno chcesz się wylogować? Upewnij się, że masz kopię zapasową klucza tajnego!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Język',
        description: 'Wybierz preferowany język interfejsu aplikacji. To ustawienie zostanie zsynchronizowane na wszystkich Twoich urządzeniach.',
        currentLanguage: 'Aktualny język',
        automatic: 'Automatycznie',
        automaticSubtitle: 'Wykrywaj na podstawie ustawień urządzenia',
        needsRestart: 'Język zmieniony',
        needsRestartMessage: 'Aplikacja musi zostać uruchomiona ponownie, aby zastosować nowe ustawienia języka.',
        restartNow: 'Uruchom ponownie',
    },

    connectButton: {
        authenticate: 'Uwierzytelnij terminal',
        authenticateWithUrlPaste: 'Uwierzytelnij terminal poprzez wklejenie URL',
        pasteAuthUrl: 'Wklej URL uwierzytelnienia z terminala',
    },

    updateBanner: {
        updateAvailable: 'Dostępna aktualizacja',
        pressToApply: 'Naciśnij, aby zastosować aktualizację',
        whatsNew: 'Co nowego',
        seeLatest: 'Zobacz najnowsze aktualizacje i ulepszenia',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Wersja ${version}`,
        noEntriesAvailable: 'Brak dostępnych wpisów dziennika zmian.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Wymagana przeglądarka internetowa',
        webBrowserRequiredDescription: 'Linki połączenia terminala można otwierać tylko w przeglądarce internetowej ze względów bezpieczeństwa. Użyj skanera kodów QR lub otwórz ten link na komputerze.',
        processingConnection: 'Przetwarzanie połączenia...',
        invalidConnectionLink: 'Nieprawidłowy link połączenia',
        invalidConnectionLinkDescription: 'Link połączenia jest nieprawidłowy lub go brakuje. Sprawdź URL i spróbuj ponownie.',
        connectTerminal: 'Połącz terminal',
        terminalRequestDescription: 'Terminal żąda połączenia z Twoim kontem Happy Coder. Pozwoli to terminalowi bezpiecznie wysyłać i odbierać wiadomości.',
        connectionDetails: 'Szczegóły połączenia',
        publicKey: 'Klucz publiczny',
        encryption: 'Szyfrowanie',
        endToEndEncrypted: 'Szyfrowanie end-to-end',
        acceptConnection: 'Akceptuj połączenie',
        connecting: 'Łączenie...',
        reject: 'Odrzuć',
        security: 'Bezpieczeństwo',
        securityFooter: 'Ten link połączenia został bezpiecznie przetworzony w Twojej przeglądarce i nigdy nie został wysłany na żaden serwer. Twoje prywatne dane pozostaną bezpieczne i tylko Ty możesz odszyfrować wiadomości.',
        securityFooterDevice: 'To połączenie zostało bezpiecznie przetworzone na Twoim urządzeniu i nigdy nie zostało wysłane na żaden serwer. Twoje prywatne dane pozostaną bezpieczne i tylko Ty możesz odszyfrować wiadomości.',
        clientSideProcessing: 'Przetwarzanie po stronie klienta',
        linkProcessedLocally: 'Link przetworzony lokalnie w przeglądarce',
        linkProcessedOnDevice: 'Link przetworzony lokalnie na urządzeniu',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Uwierzytelnij terminal',
        pasteUrlFromTerminal: 'Wklej URL uwierzytelnienia z terminala',
        deviceLinkedSuccessfully: 'Urządzenie połączone pomyślnie',
        terminalConnectedSuccessfully: 'Terminal połączony pomyślnie',
        invalidAuthUrl: 'Nieprawidłowy URL uwierzytelnienia',
        developerMode: 'Tryb deweloperski',
        developerModeEnabled: 'Tryb deweloperski włączony',
        developerModeDisabled: 'Tryb deweloperski wyłączony',
        disconnectGithub: 'Rozłącz GitHub',
        disconnectGithubConfirm: 'Czy na pewno chcesz rozłączyć swoje konto GitHub?',
        disconnectService: ({ service }: { service: string }) => 
            `Rozłącz ${service}`,
        disconnectServiceConfirm: ({ service }: { service: string }) => 
            `Czy na pewno chcesz rozłączyć ${service} ze swojego konta?`,
        disconnect: 'Rozłącz',
        failedToConnectTerminal: 'Nie udało się połączyć terminala',
        cameraPermissionsRequiredToConnectTerminal: 'Uprawnienia do kamery są wymagane do połączenia terminala',
        failedToLinkDevice: 'Nie udało się połączyć urządzenia',
        cameraPermissionsRequiredToScanQr: 'Uprawnienia do kamery są wymagane do skanowania kodów QR'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Połącz terminal',
        linkNewDevice: 'Połącz nowe urządzenie',
        restoreWithSecretKey: 'Przywróć kluczem tajnym',
        whatsNew: 'Co nowego',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Mobilny klient Claude Code',
        subtitle: 'Szyfrowanie end-to-end, a Twoje konto jest przechowywane tylko na Twoim urządzeniu.',
        createAccount: 'Utwórz konto',
        linkOrRestoreAccount: 'Połącz lub przywróć konto',
        loginWithMobileApp: 'Zaloguj się przez aplikację mobilną',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Podoba Ci się aplikacja?',
        feedbackPrompt: 'Chcielibyśmy usłyszeć Twoją opinię!',
        yesILoveIt: 'Tak, uwielbiam ją!',
        notReally: 'Nie bardzo'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} skopiowano do schowka`
    },

    machine: {
        launchNewSessionInDirectory: 'Uruchom nową sesję w katalogu',
        daemon: 'Daemon',
        status: 'Status',
        stopDaemon: 'Zatrzymaj daemon',
        lastKnownPid: 'Ostatni znany PID',
        lastKnownHttpPort: 'Ostatni znany port HTTP',
        startedAt: 'Uruchomiony o',
        cliVersion: 'Wersja CLI',
        daemonStateVersion: 'Wersja stanu daemon',
        activeSessions: ({ count }: { count: number }) => `Aktywne sesje (${count})`,
        machineGroup: 'Maszyna',
        host: 'Host',
        machineId: 'ID maszyny',
        username: 'Nazwa użytkownika',
        homeDirectory: 'Katalog domowy',
        platform: 'Platforma',
        architecture: 'Architektura',
        lastSeen: 'Ostatnio widziana',
        never: 'Nigdy',
        metadataVersion: 'Wersja metadanych',
        untitledSession: 'Sesja bez nazwy',
        back: 'Wstecz',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Przełączono na tryb ${mode}`,
        unknownEvent: 'Nieznane zdarzenie',
        usageLimitUntil: ({ time }: { time: string }) => `Osiągnięto limit użycia do ${time}`,
        unknownTime: 'nieznany czas',
    }
} as const;

export type TranslationsPl = typeof pl;