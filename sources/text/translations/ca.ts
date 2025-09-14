import type { TranslationStructure } from '../_default';

/**
 * Catalan plural helper function
 * Catalan has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Catalan plural rules
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

/**
 * Catalan translations for the Happy app
 * Must match the exact structure of the English translations
 */
export const ca: TranslationStructure = {
    common: {
        // Simple string constants
        cancel: 'Cancel·la',
        authenticate: 'Autentica',
        save: 'Desa',
        error: 'Error',
        success: 'Èxit',
        ok: 'D\'acord',
        continue: 'Continua',
        back: 'Enrere',
        create: 'Crear',
        rename: 'Reanomena',
        reset: 'Reinicia',
        logout: 'Tanca la sessió',
        yes: 'Sí',
        no: 'No',
        version: 'Versió',
        copied: 'Copiat',
        scanning: 'Escanejant...',
        urlPlaceholder: 'https://exemple.com',
        home: 'Inici',
        message: 'Missatge',
        files: 'Fitxers',
        fileViewer: 'Visualitzador de fitxers',
        loading: 'Carregant...',
        retry: 'Torna-ho a provar',
    },

    status: {
        connected: 'connectat',
        connecting: 'connectant',
        disconnected: 'desconnectat',
        error: 'error',
        online: 'en línia',
        offline: 'fora de línia',
        lastSeen: ({ time }: { time: string }) => `vist per última vegada ${time}`,
        permissionRequired: 'permís requerit',
        activeNow: 'Actiu ara',
        unknown: 'desconegut',
    },

    time: {
        justNow: 'ara mateix',
        minutesAgo: ({ count }: { count: number }) => `fa ${count} minut${count !== 1 ? 's' : ''}`,
        hoursAgo: ({ count }: { count: number }) => `fa ${count} hora${count !== 1 ? 'es' : ''}`,
    },

    connect: {
        restoreAccount: 'Restaura el compte',
        enterSecretKey: 'Introdueix la teva clau secreta',
        invalidSecretKey: 'Clau secreta no vàlida. Comprova-ho i torna-ho a provar.',
        enterUrlManually: 'Introdueix l\'URL manualment',
    },

    settings: {
        title: 'Configuració',
        connectedAccounts: 'Comptes connectats',
        connectAccount: 'Connectar compte',
        github: 'GitHub',
        machines: 'Màquines',
        features: 'Funcions',
        account: 'Compte',
        accountSubtitle: 'Gestiona els detalls del teu compte',
        appearance: 'Aparença',
        appearanceSubtitle: 'Personalitza l\'aspecte de l\'aplicació',
        voiceAssistant: 'Assistent de veu',
        voiceAssistantSubtitle: 'Configura les preferències d\'interacció per veu',
        featuresTitle: 'Funcions',
        featuresSubtitle: 'Activa o desactiva les funcions de l\'aplicació',
        developer: 'Desenvolupador',
        developerTools: 'Eines de desenvolupador',
        about: 'Quant a',
        aboutFooter: 'Happy Coder és un client mòbil de Codex i Claude Code. Tot està xifrat punt a punt i el teu compte es guarda només al teu dispositiu. No està afiliat amb Anthropic.',
        whatsNew: 'Novetats',
        whatsNewSubtitle: 'Mira les últimes actualitzacions i millores',
        reportIssue: 'Informa d\'un problema',
        privacyPolicy: 'Política de privadesa',
        termsOfService: 'Condicions del servei',
        eula: 'EULA',
        supportUs: 'Dona\'ns suport',
        supportUsSubtitlePro: 'Gràcies pel teu suport!',
        supportUsSubtitle: 'Dona suport al desenvolupament del projecte',
        scanQrCodeToAuthenticate: 'Escaneja el codi QR per autenticar-te',
        githubConnected: ({ login }: { login: string }) => `Connectat com a @${login}`,
        connectGithubAccount: 'Connecta el teu compte de GitHub',
        claudeAuthSuccess: 'Connexió amb Claude realitzada amb èxit',
        exchangingTokens: 'Intercanviant tokens...',

        // Dynamic settings messages
        accountConnected: ({ service }: { service: string }) => `Compte de ${service} connectat`,
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} està ${status === 'online' ? 'en línia' : 'fora de línia'}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'activada' : 'desactivada'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Tema',
        themeDescription: 'Tria el teu esquema de colors preferit',
        themeOptions: {
            adaptive: 'Adaptatiu',
            light: 'Clar', 
            dark: 'Fosc',
        },
        themeDescriptions: {
            adaptive: 'Segueix la configuració del sistema',
            light: 'Usa sempre el tema clar',
            dark: 'Usa sempre el tema fosc',
        },
        display: 'Pantalla',
        displayDescription: 'Controla la disposició i l\'espaiat',
        inlineToolCalls: 'Crides d\'eines en línia',
        inlineToolCallsDescription: 'Mostra les crides d\'eines directament als missatges de xat',
        expandTodoLists: 'Expandeix les llistes de tasques',
        expandTodoListsDescription: 'Mostra totes les tasques en lloc de només els canvis',
        showLineNumbersInDiffs: 'Mostra els números de línia a les diferències',
        showLineNumbersInDiffsDescription: 'Mostra els números de línia a les diferències de codi',
        showLineNumbersInToolViews: 'Mostra els números de línia a les vistes d\'eines',
        showLineNumbersInToolViewsDescription: 'Mostra els números de línia a les diferències de vistes d\'eines',
        alwaysShowContextSize: 'Mostra sempre la mida del context',
        alwaysShowContextSizeDescription: 'Mostra l\'ús del context fins i tot quan no estigui prop del límit',
        avatarStyle: 'Estil d\'avatar',
        avatarStyleDescription: 'Tria l\'aparença de l\'avatar de la sessió',
        avatarOptions: {
            pixelated: 'Pixelat',
            gradient: 'Gradient',
            brutalist: 'Brutalista',
        },
        showFlavorIcons: "Mostrar icones de proveïdors d'IA",
        showFlavorIconsDescription: "Mostrar icones del proveïdor d'IA als avatars de sessió",
        compactSessionView: 'Vista compacta de sessions',
        compactSessionViewDescription: 'Mostra les sessions actives en un disseny més compacte',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Experiments',
        experimentsDescription: 'Activa funcions experimentals que encara estan en desenvolupament. Aquestes funcions poden ser inestables o canviar sense avís.',
        experimentalFeatures: 'Funcions experimentals',
        experimentalFeaturesEnabled: 'Funcions experimentals activades',
        experimentalFeaturesDisabled: 'Utilitzant només funcions estables',
        webFeatures: 'Funcions web',
        webFeaturesDescription: 'Funcions disponibles només a la versió web de l\'app.',
        commandPalette: 'Paleta de comandes',
        commandPaletteEnabled: 'Prem ⌘K per obrir',
        commandPaletteDisabled: 'Accés ràpid a comandes desactivat',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Pulsació llarga obre modal de còpia',
    },

    errors: {
        networkError: 'Error de connexió',
        serverError: 'Error del servidor',
        unknownError: 'Error desconegut',
        connectionTimeout: 'S\'ha esgotat el temps de connexió',
        authenticationFailed: 'L\'autenticació ha fallat',
        permissionDenied: 'Permís denegat',
        fileNotFound: 'Fitxer no trobat',
        invalidFormat: 'Format no vàlid',
        operationFailed: 'L\'operació ha fallat',
        tryAgain: 'Torna-ho a provar',
        contactSupport: 'Contacta amb el suport si el problema persisteix',
        sessionNotFound: 'Sessió no trobada',
        voiceSessionFailed: 'Ha fallat l\'inici de la sessió de veu',
        oauthInitializationFailed: 'Ha fallat la inicialització del flux OAuth',
        tokenStorageFailed: 'Ha fallat l\'emmagatzematge dels tokens d\'autenticació',
        oauthStateMismatch: 'Ha fallat la validació de seguretat. Si us plau, torna-ho a provar',
        tokenExchangeFailed: 'Ha fallat l\'intercanvi del codi d\'autorització',
        oauthAuthorizationDenied: 'L\'autorització ha estat denegada',
        webViewLoadFailed: 'Ha fallat la càrrega de la pàgina d\'autenticació',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} ha d'estar entre ${min} i ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Torna-ho a provar en ${seconds} ${seconds === 1 ? 'segon' : 'segons'}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Error ${code})`,
        disconnectServiceFailed: ({ service }: { service: string }) => 
            `Ha fallat la desconnexió de ${service}`,
        connectServiceFailed: ({ service }: { service: string }) =>
            `No s'ha pogut connectar ${service}. Si us plau, torna-ho a provar.`,
    },

    newSession: {
        // Used by new-session screen and launch flows
        title: 'Inicia una nova sessió',
        noMachinesFound: 'No s\'han trobat màquines. Inicia una sessió de Happy al teu ordinador primer.',
        allMachinesOffline: 'Totes les màquines estan fora de línia',
        machineDetails: 'Veure detalls de la màquina →',
        noMachineSelected: 'Cap màquina seleccionada',
        noPathSelected: 'Cap camí seleccionat',
        directoryDoesNotExist: 'Directori no trobat',
        createDirectoryConfirm: ({ directory }: { directory: string }) => `El directori ${directory} no existeix. Vols crear-lo?`,
        sessionStarted: 'Sessió iniciada',
        sessionStartedMessage: 'La sessió s\'ha iniciat correctament.',
        sessionSpawningFailed: 'Ha fallat la creació de la sessió - no s\'ha retornat cap ID de sessió.',
        failedToStart: 'Ha fallat l\'inici de la sessió. Assegura\'t que el dimoni s\'estigui executant a la màquina de destinació.',
        sessionTimeout: 'L\'inici de la sessió ha esgotat el temps d\'espera. La màquina pot ser lenta o el dimoni pot no estar responent.',
        notConnectedToServer: 'No connectat al servidor. Comprova la teva connexió a internet.',
        startingSession: 'Iniciant la sessió...',
        startNewSessionInFolder: 'Nova sessió aquí'
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Historial de sessions',
        empty: 'No s\'han trobat sessions',
        today: 'Avui',
        yesterday: 'Ahir',
        daysAgo: ({ count }: { count: number }) => `fa ${count} ${count === 1 ? 'dia' : 'dies'}`,
        viewAll: 'Veure totes les sessions',
    },

    session: {
        inputPlaceholder: 'Escriu un missatge...',
    },

    commandPalette: {
        placeholder: 'Escriu una comanda o cerca...',
    },

    server: {
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: 'Configuració del servidor',
        enterServerUrl: 'Introdueix una URL del servidor',
        notValidHappyServer: 'No és un servidor Happy vàlid',
        changeServer: 'Canvia el servidor',
        continueWithServer: 'Continuar amb aquest servidor?',
        resetToDefault: 'Reinicia per defecte',
        resetServerDefault: 'Reiniciar el servidor per defecte?',
        validating: 'Validant...',
        validatingServer: 'Validant el servidor...',
        serverReturnedError: 'El servidor ha retornat un error',
        failedToConnectToServer: 'Ha fallat la connexió amb el servidor',
        currentlyUsingCustomServer: 'Actualment utilitzant un servidor personalitzat',
        customServerUrlLabel: 'URL del servidor personalitzat',
        advancedFeatureFooter: 'Aquesta és una funció avançada. Només canvia el servidor si saps el que fas. Hauràs de tancar la sessió i tornar-la a iniciar després de canviar els servidors.'
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Finalitza la sessió',
        killSessionConfirm: 'Segur que vols finalitzar aquesta sessió?',
        archiveSession: 'Arxiva la sessió',
        archiveSessionConfirm: 'Segur que vols arxivar aquesta sessió?',
        happySessionIdCopied: 'ID de la sessió de Happy copiat al porta-retalls',
        failedToCopySessionId: 'Ha fallat copiar l\'ID de la sessió de Happy',
        happySessionId: 'ID de la sessió de Happy',
        claudeCodeSessionId: 'ID de la sessió de Claude Code',
        claudeCodeSessionIdCopied: 'ID de la sessió de Claude Code copiat al porta-retalls',
        aiProvider: 'Proveïdor d\'IA',
        failedToCopyClaudeCodeSessionId: 'Ha fallat copiar l\'ID de la sessió de Claude Code',
        metadataCopied: 'Metadades copiades al porta-retalls',
        failedToCopyMetadata: 'Ha fallat copiar les metadades',
        failedToKillSession: 'Ha fallat finalitzar la sessió',
        failedToArchiveSession: 'Ha fallat arxivar la sessió',
        connectionStatus: 'Estat de la connexió',
        created: 'Creat',
        lastUpdated: 'Última actualització',
        sequence: 'Seqüència',
        quickActions: 'Accions ràpides',
        viewMachine: 'Veure la màquina',
        viewMachineSubtitle: 'Veure detalls de la màquina i sessions',
        killSessionSubtitle: 'Finalitzar immediatament la sessió',
        archiveSessionSubtitle: 'Arxiva aquesta sessió i atura-la',
        metadata: 'Metadades',
        host: 'Host',
        path: 'Camí',
        operatingSystem: 'Sistema operatiu',
        processId: 'ID del procés',
        happyHome: 'Directori de Happy',
        copyMetadata: 'Copia les metadades',
        agentState: 'Estat de l\'agent',
        controlledByUser: 'Controlat per l\'usuari',
        pendingRequests: 'Sol·licituds pendents',
        activity: 'Activitat',
        thinking: 'Pensant',
        thinkingSince: 'Pensant des de',
        cliVersion: 'Versió del CLI',
        cliVersionOutdated: 'Actualització del CLI requerida',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Versió ${currentVersion} instal·lada. Actualitzeu a ${requiredVersion} o posterior`,
        updateCliInstructions: 'Si us plau executeu npm install -g happy-coder@latest',
        
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Llest per programar?',
            installCli: 'Instal·la el Happy CLI',
            runIt: 'Executa\'l',
            scanQrCode: 'Escaneja el codi QR',
            openCamera: 'Obre la càmera',
        },
    },

    agentInput: {
        permissionMode: {
            title: 'MODE DE PERMISOS',
            default: 'Per defecte',
            acceptEdits: 'Accepta edicions',
            plan: 'Mode de planificació',
            bypassPermissions: 'Mode Yolo',
            badgeAcceptAllEdits: 'Accepta totes les edicions',
            badgeBypassAllPermissions: 'Omet tots els permisos',
            badgePlanMode: 'Mode de planificació',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
        },
        model: {
            title: 'MODEL',
            default: 'Utilitza la configuració del CLI',
            adaptiveUsage: 'Opus fins al 50% d\'ús, després Sonnet',
            sonnet: 'Sonnet',
            opus: 'Opus',
        },
        codexPermissionMode: {
            title: 'MODE DE PERMISOS CODEX',
            default: 'Configuració del CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            badgeReadOnly: 'Read Only Mode',
            badgeSafeYolo: 'Safe YOLO',
            badgeYolo: 'YOLO',
        },
        codexModel: {
            title: 'MODEL CODEX',
            gpt5Minimal: 'GPT-5 Mínim',
            gpt5Low: 'GPT-5 Baix',
            gpt5Medium: 'GPT-5 Mitjà',
            gpt5High: 'GPT-5 Alt',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% restant`,
        },
        suggestion: {
            fileLabel: 'FITXER',
            folderLabel: 'CARPETA',
        },
        noMachinesAvailable: 'Sense màquines',
    },

    machineLauncher: {
        showLess: 'Mostra menys',
        showAll: ({ count }: { count: number }) => `Mostra tots (${count} camins)`,
        enterCustomPath: 'Introdueix un camí personalitzat',
        offlineUnableToSpawn: 'No es pot crear una nova sessió, fora de línia',
    },

    sidebar: {
        sessionsTitle: 'Sessions',
    },

    toolView: {
        input: 'Entrada',
        output: 'Sortida',
    },

    tools: {
        fullView: {
            description: 'Descripció',
            inputParams: 'Paràmetres d\'entrada',
            output: 'Sortida',
            error: 'Error',
            completed: 'Eina completada amb èxit',
            noOutput: 'No s\'ha produït cap sortida',
            running: 'L\'eina s\'està executant...',
            rawJsonDevMode: 'JSON en brut (mode desenvolupador)',
        },
        taskView: {
            initializing: 'Inicialitzant l\'agent...',
            moreTools: ({ count }: { count: number }) => `+${count} més ${plural({ count, singular: 'eina', plural: 'eines' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Edició ${index} de ${total}`,
            replaceAll: 'Reemplaça tot',
        },
        names: {
            task: 'Tasca',
            terminal: 'Terminal',
            searchFiles: 'Cerca fitxers',
            search: 'Cerca',
            searchContent: 'Cerca contingut',
            listFiles: 'Llista fitxers',
            planProposal: 'Proposta de pla',
            readFile: 'Llegeix fitxer',
            editFile: 'Edita fitxer',
            writeFile: 'Escriu fitxer',
            fetchUrl: 'Obté URL',
            readNotebook: 'Llegeix quadern',
            editNotebook: 'Edita quadern',
            todoList: 'Llista de tasques',
            webSearch: 'Cerca web',
            reasoning: 'Raonament',
            applyChanges: 'Actualitza fitxer',
            viewDiff: 'Canvis del fitxer actual',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Cerca(patró: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Cerca(camí: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Obté URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Edita quadern(fitxer: ${path}, mode: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Llista de tasques(quantitat: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Cerca web(consulta: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(patró: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} edicions)`,
            readingFile: ({ file }: { file: string }) => `Llegint ${file}`,
            writingFile: ({ file }: { file: string }) => `Escrivint ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Modificant ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Modificant ${count} fitxers`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} i ${count} més`,
            showingDiff: 'Mostrant canvis',
        }
    },

    files: {
        searchPlaceholder: 'Cerca fitxers...',
        detachedHead: 'HEAD separat',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} preparats • ${unstaged} sense preparar`,
        notRepo: 'No és un repositori git',
        notUnderGit: 'Aquest directori no està sota control de versions git',
        searching: 'Cercant fitxers...',
        noFilesFound: 'No s\'han trobat fitxers',
        noFilesInProject: 'No hi ha fitxers al projecte',
        tryDifferentTerm: 'Prova un terme de cerca diferent',
        searchResults: ({ count }: { count: number }) => `Resultats de la cerca (${count})`,
        projectRoot: 'Arrel del projecte',
        stagedChanges: ({ count }: { count: number }) => `Canvis preparats (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Canvis sense preparar (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Carregant ${fileName}...`,
        binaryFile: 'Fitxer binari',
        cannotDisplayBinary: 'No es pot mostrar el contingut del fitxer binari',
        diff: 'Diferències',
        file: 'Fitxer',
        fileEmpty: 'El fitxer està buit',
        noChanges: 'No hi ha canvis a mostrar',
    },

    settingsVoice: {
        // Voice settings screen
        languageTitle: 'Idioma',
        languageDescription: 'Tria el teu idioma preferit per a les interaccions amb l\'assistent de veu. Aquesta configuració es sincronitza a tots els teus dispositius.',
        preferredLanguage: 'Idioma preferit',
        preferredLanguageSubtitle: 'Idioma utilitzat per a les respostes de l\'assistent de veu',
        language: {
            searchPlaceholder: 'Cerca idiomes...',
            title: 'Idiomes',
            footer: ({ count }: { count: number }) => `${count} ${plural({ count, singular: 'idioma', plural: 'idiomes' })} disponibles`,
            autoDetect: 'Detecta automàticament',
        }
    },

    settingsAccount: {
        // Account settings screen
        accountInformation: 'Informació del compte',
        status: 'Estat',
        statusActive: 'Actiu',
        statusNotAuthenticated: 'No autenticat',
        anonymousId: 'ID anònim',
        publicId: 'ID públic',
        notAvailable: 'No disponible',
        linkNewDevice: 'Enllaça un nou dispositiu',
        linkNewDeviceSubtitle: 'Escaneja el codi QR per enllaçar el dispositiu',
        profile: 'Perfil',
        name: 'Nom',
        github: 'GitHub',
        tapToDisconnect: 'Toca per desconnectar',
        server: 'Servidor',
        backup: 'Còpia de seguretat',
        backupDescription: 'La teva clau secreta és l\'única manera de recuperar el teu compte. Desa-la en un lloc segur com un gestor de contrasenyes.',
        secretKey: 'Clau secreta',
        tapToReveal: 'Toca per revelar',
        tapToHide: 'Toca per ocultar',
        secretKeyLabel: 'CLAU SECRETA (TOCA PER COPIAR)',
        secretKeyCopied: 'Clau secreta copiada al porta-retalls. Desa-la en un lloc segur!',
        secretKeyCopyFailed: 'Ha fallat copiar la clau secreta',
        privacy: 'Privadesa',
        privacyDescription: 'Ajuda a millorar l\'aplicació compartint dades d\'ús anònimes. No es recopila informació personal.',
        analytics: 'Analítiques',
        analyticsDisabled: 'No es comparteixen dades',
        analyticsEnabled: 'Es comparteixen dades d\'ús anònimes',
        dangerZone: 'Zona de perill',
        logout: 'Tanca la sessió',
        logoutSubtitle: 'Tanca la sessió i esborra les dades locals',
        logoutConfirm: 'Estàs segur que vols tancar la sessió? Assegura\'t d\'haver fet una còpia de seguretat de la teva clau secreta!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Idioma',
        description: 'Tria el teu idioma preferit per a la interfície de l\'app. Això se sincronitzarà a tots els teus dispositius.',
        currentLanguage: 'Idioma actual',
        automatic: 'Automàtic',
        automaticSubtitle: 'Detecta des de la configuració del dispositiu',
        needsRestart: 'Idioma canviat',
        needsRestartMessage: 'L\'aplicació necessita reiniciar-se per aplicar la nova configuració d\'idioma.',
        restartNow: 'Reinicia ara',
    },

    connectButton: {
        authenticate: 'Autentica el terminal',
        authenticateWithUrlPaste: 'Autentica el terminal amb enganxat d\'URL',
        pasteAuthUrl: 'Enganxa l\'URL d\'autenticació del teu terminal',
    },

    updateBanner: {
        updateAvailable: 'Actualització disponible',
        pressToApply: 'Prem per aplicar l\'actualització',
        whatsNew: 'Novetats',
        seeLatest: 'Mira les últimes actualitzacions i millores',
        nativeUpdateAvailable: 'Actualització de l\'aplicació disponible',
        tapToUpdateAppStore: 'Toca per actualitzar a l\'App Store',
        tapToUpdatePlayStore: 'Toca per actualitzar a Play Store',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Versió ${version}`,
        noEntriesAvailable: 'No hi ha entrades de registre de canvis disponibles.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Es requereix un navegador web',
        webBrowserRequiredDescription: 'Els enllaços de connexió de terminal només es poden obrir en un navegador web per raons de seguretat. Utilitza l\'escàner de codi QR o obre aquest enllaç en un ordinador.',
        processingConnection: 'Processant la connexió...',
        invalidConnectionLink: 'Enllaç de connexió no vàlid',
        invalidConnectionLinkDescription: 'L\'enllaç de connexió falta o no és vàlid. Comprova l\'URL i torna-ho a provar.',
        connectTerminal: 'Connecta el terminal',
        terminalRequestDescription: 'Un terminal està sol·licitant connectar-se al teu compte de Happy Coder. Això permetrà al terminal enviar i rebre missatges de forma segura.',
        connectionDetails: 'Detalls de la connexió',
        publicKey: 'Clau pública',
        encryption: 'Xifratge',
        endToEndEncrypted: 'Xifrat punt a punt',
        acceptConnection: 'Accepta la connexió',
        connecting: 'Connectant...',
        reject: 'Rebutja',
        security: 'Seguretat',
        securityFooter: 'Aquest enllaç de connexió s\'ha processat de forma segura al teu navegador i mai s\'ha enviat a cap servidor. Les teves dades privades es mantindran segures i només tu pots desxifrar els missatges.',
        securityFooterDevice: 'Aquesta connexió s\'ha processat de forma segura al teu dispositiu i mai s\'ha enviat a cap servidor. Les teves dades privades es mantindran segures i només tu pots desxifrar els missatges.',
        clientSideProcessing: 'Processament del costat del client',
        linkProcessedLocally: 'Enllaç processat localment al navegador',
        linkProcessedOnDevice: 'Enllaç processat localment al dispositiu',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Autentica el terminal',
        pasteUrlFromTerminal: 'Enganxa l\'URL d\'autenticació del teu terminal',
        deviceLinkedSuccessfully: 'Dispositiu enllaçat amb èxit',
        terminalConnectedSuccessfully: 'Terminal connectat amb èxit',
        invalidAuthUrl: 'URL d\'autenticació no vàlida',
        developerMode: 'Mode desenvolupador',
        developerModeEnabled: 'Mode desenvolupador activat',
        developerModeDisabled: 'Mode desenvolupador desactivat',
        disconnectGithub: 'Desconnecta GitHub',
        disconnectGithubConfirm: 'Segur que vols desconnectar el teu compte de GitHub?',
        disconnectService: ({ service }: { service: string }) => 
            `Desconnecta ${service}`,
        disconnectServiceConfirm: ({ service }: { service: string }) => 
            `Segur que vols desconnectar ${service} del teu compte?`,
        disconnect: 'Desconnecta',
        failedToConnectTerminal: 'Ha fallat connectar el terminal',
        cameraPermissionsRequiredToConnectTerminal: 'Es requereixen permisos de càmera per connectar el terminal',
        failedToLinkDevice: 'Ha fallat enllaçar el dispositiu',
        cameraPermissionsRequiredToScanQr: 'Es requereixen permisos de càmera per escanejar codis QR'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Connecta el terminal',
        linkNewDevice: 'Enllaça un nou dispositiu', 
        restoreWithSecretKey: 'Restaura amb clau secreta',
        whatsNew: 'Novetats',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Client mòbil de Codex i Claude Code',
        subtitle: 'Xifrat punt a punt i el teu compte s\'emmagatzema només al teu dispositiu.',
        createAccount: 'Crea un compte',
        linkOrRestoreAccount: 'Enllaça o restaura un compte',
        loginWithMobileApp: 'Inicia sessió amb l\'aplicació mòbil',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'T\'està agradant l\'aplicació?',
        feedbackPrompt: 'Ens encantaria conèixer la teva opinió!',
        yesILoveIt: 'Sí, m\'encanta!',
        notReally: 'No gaire'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copiat al porta-retalls`
    },

    machine: {
        offlineUnableToSpawn: 'El llançador està desactivat mentre la màquina està fora de línia',
        offlineHelp: '• Assegura\'t que l\'ordinador estigui en línia\n• Executa `happy daemon status` per diagnosticar\n• Fas servir l\'última versió del CLI? Actualitza amb `npm install -g happy-coder@latest`',
        launchNewSessionInDirectory: 'Inicia una nova sessió al directori',
        daemon: 'Dimoni',
        status: 'Estat',
        stopDaemon: 'Atura el dimoni',
        lastKnownPid: 'Últim PID conegut',
        lastKnownHttpPort: 'Últim port HTTP conegut',
        startedAt: 'Iniciat a',
        cliVersion: 'Versió del CLI',
        daemonStateVersion: 'Versió de l\'estat del dimoni',
        activeSessions: ({ count }: { count: number }) => `Sessions actives (${count})`,
        machineGroup: 'Màquina',
        host: 'Host',
        machineId: 'ID de la màquina',
        username: 'Nom d\'usuari',
        homeDirectory: 'Directori principal',
        platform: 'Plataforma',
        architecture: 'Arquitectura',
        lastSeen: 'Vist per última vegada',
        never: 'Mai',
        metadataVersion: 'Versió de les metadades',
        untitledSession: 'Sessió sense títol',
        back: 'Enrere',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `S'ha canviat al mode ${mode}`,
        unknownEvent: 'Esdeveniment desconegut',
        usageLimitUntil: ({ time }: { time: string }) => `Límit d'ús assolit fins a ${time}`,
        unknownTime: 'temps desconegut',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: 'Sí, i no preguntar per aquesta sessió',
            stopAndExplain: 'Atura, i explica què fer',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Sí, permet totes les edicions durant aquesta sessió',
            yesForTool: 'Sí, no tornis a preguntar per aquesta eina',
            noTellClaude: 'No, i digues a Claude què fer diferent',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: 'Seleccionar rang de text',
        title: 'Seleccionar text',
        noTextProvided: 'No s\'ha proporcionat text',
        textNotFound: 'Text no trobat o expirat',
        textCopied: 'Text copiat al porta-retalls',
        failedToCopy: 'No s\'ha pogut copiar el text al porta-retalls',
        noTextToCopy: 'No hi ha text disponible per copiar',
    }
} as const;

export type TranslationsCa = typeof ca;
