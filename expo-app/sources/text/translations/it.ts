import type { TranslationStructure } from '../_default';

/**
 * Italian plural helper function
 * Italian has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Italian plural rules
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

/**
 * Italian translations for the Happy app
 * Must match the exact structure of the English translations
 */
export const it: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        inbox: 'Posta',
        sessions: 'Terminali',
        settings: 'Impostazioni',
    },

    inbox: {
        // Inbox screen
        emptyTitle: 'Posta vuota',
        emptyDescription: 'Connettiti con amici per iniziare a condividere sessioni',
        updates: 'Aggiornamenti',
    },

    common: {
        // Simple string constants
        cancel: 'Annulla',
        authenticate: 'Autentica',
        save: 'Salva',
        error: 'Errore',
        success: 'Successo',
        ok: 'OK',
        continue: 'Continua',
        back: 'Indietro',
        create: 'Crea',
        rename: 'Rinomina',
        reset: 'Ripristina',
        logout: 'Esci',
        yes: 'Sì',
        no: 'No',
        discard: 'Scarta',
        version: 'Versione',
        copied: 'Copiato',
        copy: 'Copia',
        scanning: 'Scansione...',
        urlPlaceholder: 'https://esempio.com',
        home: 'Home',
        message: 'Messaggio',
        files: 'File',
        fileViewer: 'Visualizzatore file',
        loading: 'Caricamento...',
        retry: 'Riprova',
        delete: 'Elimina',
        optional: 'opzionale',
        saveAs: 'Salva con nome',
    },

    profile: {
        userProfile: 'Profilo utente',
        details: 'Dettagli',
        firstName: 'Nome',
        lastName: 'Cognome',
        username: 'Nome utente',
        status: 'Stato',
    },

    profiles: {
        title: 'Profili',
        subtitle: 'Gestisci i profili delle variabili ambiente per le sessioni',
        noProfile: 'Nessun profilo',
        noProfileDescription: 'Usa le impostazioni ambiente predefinite',
        defaultModel: 'Modello predefinito',
        addProfile: 'Aggiungi profilo',
        profileName: 'Nome profilo',
        enterName: 'Inserisci nome profilo',
        baseURL: 'URL base',
        authToken: 'Token di autenticazione',
        enterToken: 'Inserisci token di autenticazione',
        model: 'Modello',
        tmuxSession: 'Sessione Tmux',
        enterTmuxSession: 'Inserisci nome sessione tmux',
        tmuxTempDir: 'Directory temporanea Tmux',
        enterTmuxTempDir: 'Inserisci percorso directory temporanea',
        tmuxUpdateEnvironment: 'Aggiorna ambiente automaticamente',
        nameRequired: 'Il nome del profilo è obbligatorio',
        deleteConfirm: 'Sei sicuro di voler eliminare il profilo "{name}"?',
        editProfile: 'Modifica profilo',
        addProfileTitle: 'Aggiungi nuovo profilo',
        delete: {
            title: 'Elimina profilo',
            message: ({ name }: { name: string }) => `Sei sicuro di voler eliminare "${name}"? Questa azione non può essere annullata.`,
            confirm: 'Elimina',
            cancel: 'Annulla',
        },
    },

    status: {
        connected: 'connesso',
        connecting: 'connessione in corso',
        disconnected: 'disconnesso',
        error: 'errore',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `visto l'ultima volta ${time}`,
        permissionRequired: 'permesso richiesto',
        activeNow: 'Attivo ora',
        unknown: 'sconosciuto',
    },

    time: {
        justNow: 'proprio ora',
        minutesAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'minuto' : 'minuti'} fa`,
        hoursAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'ora' : 'ore'} fa`,
    },

    connect: {
        restoreAccount: 'Ripristina account',
        enterSecretKey: 'Inserisci la chiave segreta',
        invalidSecretKey: 'Chiave segreta non valida. Controlla e riprova.',
        enterUrlManually: 'Inserisci URL manualmente',
    },

    settings: {
        title: 'Impostazioni',
        connectedAccounts: 'Account collegati',
        connectAccount: 'Collega account',
        github: 'GitHub',
        machines: 'Macchine',
        features: 'Funzionalità',
        social: 'Social',
        account: 'Account',
        accountSubtitle: 'Gestisci i dettagli del tuo account',
        appearance: 'Aspetto',
        appearanceSubtitle: 'Personalizza l\'aspetto dell\'app',
        voiceAssistant: 'Assistente vocale',
        voiceAssistantSubtitle: 'Configura le preferenze vocali',
        featuresTitle: 'Funzionalità',
        featuresSubtitle: 'Abilita o disabilita le funzionalità dell\'app',
        developer: 'Sviluppatore',
        developerTools: 'Strumenti sviluppatore',
        about: 'Informazioni',
        aboutFooter: 'Happy Coder è un client mobile per Codex e Claude Code. È completamente cifrato end-to-end e il tuo account è memorizzato solo sul tuo dispositivo. Non affiliato con Anthropic.',
        whatsNew: 'Novità',
        whatsNewSubtitle: 'Scopri gli ultimi aggiornamenti e miglioramenti',
        reportIssue: 'Segnala un problema',
        privacyPolicy: 'Informativa sulla privacy',
        termsOfService: 'Termini di servizio',
        eula: 'EULA',
        supportUs: 'Sostienici',
        supportUsSubtitlePro: 'Grazie per il tuo supporto!',
        supportUsSubtitle: 'Sostieni lo sviluppo del progetto',
        scanQrCodeToAuthenticate: 'Scansiona il codice QR per autenticarti',
        githubConnected: ({ login }: { login: string }) => `Connesso come @${login}`,
        connectGithubAccount: 'Collega il tuo account GitHub',
        claudeAuthSuccess: 'Connesso a Claude con successo',
        exchangingTokens: 'Scambio dei token...',
        usage: 'Utilizzo',
        usageSubtitle: 'Vedi il tuo utilizzo API e i costi',
        profiles: 'Profili',
        profilesSubtitle: 'Gestisci i profili delle variabili ambiente per le sessioni',

        // Dynamic settings messages
        accountConnected: ({ service }: { service: string }) => `Account ${service} collegato`,
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} è ${status === 'online' ? 'online' : 'offline'}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'abilitata' : 'disabilitata'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Tema',
        themeDescription: 'Scegli lo schema di colori preferito',
        themeOptions: {
            adaptive: 'Adattivo',
            light: 'Chiaro',
            dark: 'Scuro',
        },
        themeDescriptions: {
            adaptive: 'Segui le impostazioni di sistema',
            light: 'Usa sempre il tema chiaro',
            dark: 'Usa sempre il tema scuro',
        },
        display: 'Schermo',
        displayDescription: 'Controlla layout e spaziatura',
        inlineToolCalls: 'Chiamate strumenti inline',
        inlineToolCallsDescription: 'Mostra le chiamate agli strumenti direttamente nei messaggi di chat',
        expandTodoLists: 'Espandi liste di attività',
        expandTodoListsDescription: 'Mostra tutte le attività invece dei soli cambiamenti',
        showLineNumbersInDiffs: 'Mostra numeri di riga nelle differenze',
        showLineNumbersInDiffsDescription: 'Mostra i numeri di riga nei diff del codice',
        showLineNumbersInToolViews: 'Mostra numeri di riga nelle viste strumenti',
        showLineNumbersInToolViewsDescription: 'Mostra i numeri di riga nei diff delle viste strumenti',
        wrapLinesInDiffs: 'A capo nelle differenze',
        wrapLinesInDiffsDescription: 'A capo delle righe lunghe invece dello scorrimento orizzontale nelle viste diff',
        alwaysShowContextSize: 'Mostra sempre dimensione contesto',
        alwaysShowContextSizeDescription: 'Mostra l\'uso del contesto anche quando non è vicino al limite',
        avatarStyle: 'Stile avatar',
        avatarStyleDescription: 'Scegli l\'aspetto dell\'avatar di sessione',
        avatarOptions: {
            pixelated: 'Pixelato',
            gradient: 'Gradiente',
            brutalist: 'Brutalista',
        },
        showFlavorIcons: 'Mostra icone provider IA',
        showFlavorIconsDescription: 'Mostra le icone del provider IA sugli avatar di sessione',
        compactSessionView: 'Vista sessioni compatta',
        compactSessionViewDescription: 'Mostra le sessioni attive in un layout più compatto',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Esperimenti',
        experimentsDescription: 'Abilita funzionalità sperimentali ancora in sviluppo. Queste funzionalità possono essere instabili o cambiare senza preavviso.',
        experimentalFeatures: 'Funzionalità sperimentali',
        experimentalFeaturesEnabled: 'Funzionalità sperimentali abilitate',
        experimentalFeaturesDisabled: 'Usando solo funzionalità stabili',
        webFeatures: 'Funzionalità web',
        webFeaturesDescription: 'Funzionalità disponibili solo nella versione web dell\'app.',
        enterToSend: 'Invio con Enter',
        enterToSendEnabled: 'Premi Invio per inviare (Maiusc+Invio per una nuova riga)',
        enterToSendDisabled: 'Invio inserisce una nuova riga',
        commandPalette: 'Palette comandi',
        commandPaletteEnabled: 'Premi ⌘K per aprire',
        commandPaletteDisabled: 'Accesso rapido ai comandi disabilitato',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Pressione lunga apre la finestra di copia',
        hideInactiveSessions: 'Nascondi sessioni inattive',
        hideInactiveSessionsSubtitle: 'Mostra solo le chat attive nella tua lista',
        enhancedSessionWizard: 'Wizard sessione avanzato',
        enhancedSessionWizardEnabled: 'Avvio sessioni con profili attivo',
        enhancedSessionWizardDisabled: 'Usando avvio sessioni standard',
    },

    errors: {
        networkError: 'Si è verificato un errore di rete',
        serverError: 'Si è verificato un errore del server',
        unknownError: 'Si è verificato un errore sconosciuto',
        connectionTimeout: 'Connessione scaduta',
        authenticationFailed: 'Autenticazione non riuscita',
        permissionDenied: 'Permesso negato',
        fileNotFound: 'File non trovato',
        invalidFormat: 'Formato non valido',
        operationFailed: 'Operazione non riuscita',
        tryAgain: 'Per favore riprova',
        contactSupport: 'Contatta l\'assistenza se il problema persiste',
        sessionNotFound: 'Sessione non trovata',
        voiceSessionFailed: 'Avvio della sessione vocale non riuscito',
        voiceServiceUnavailable: 'Il servizio vocale non è temporaneamente disponibile',
        oauthInitializationFailed: 'Impossibile inizializzare il flusso OAuth',
        tokenStorageFailed: 'Impossibile salvare i token di autenticazione',
        oauthStateMismatch: 'Convalida di sicurezza non riuscita. Riprova',
        tokenExchangeFailed: 'Impossibile scambiare il codice di autorizzazione',
        oauthAuthorizationDenied: 'Autorizzazione negata',
        webViewLoadFailed: 'Impossibile caricare la pagina di autenticazione',
        failedToLoadProfile: 'Impossibile caricare il profilo utente',
        userNotFound: 'Utente non trovato',
        sessionDeleted: 'La sessione è stata eliminata',
        sessionDeletedDescription: 'Questa sessione è stata rimossa definitivamente',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} deve essere tra ${min} e ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Riprova tra ${seconds} ${seconds === 1 ? 'secondo' : 'secondi'}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Errore ${code})`,
        disconnectServiceFailed: ({ service }: { service: string }) => 
            `Impossibile disconnettere ${service}`,
        connectServiceFailed: ({ service }: { service: string }) =>
            `Impossibile connettere ${service}. Riprova.`,
        failedToLoadFriends: 'Impossibile caricare la lista amici',
        failedToAcceptRequest: 'Impossibile accettare la richiesta di amicizia',
        failedToRejectRequest: 'Impossibile rifiutare la richiesta di amicizia',
        failedToRemoveFriend: 'Impossibile rimuovere l\'amico',
        searchFailed: 'Ricerca non riuscita. Riprova.',
        failedToSendRequest: 'Impossibile inviare la richiesta di amicizia',
    },

    newSession: {
        // Used by new-session screen and launch flows
        title: 'Avvia nuova sessione',
        noMachinesFound: 'Nessuna macchina trovata. Avvia prima una sessione Happy sul tuo computer.',
        allMachinesOffline: 'Tutte le macchine sembrano offline',
        machineDetails: 'Visualizza dettagli macchina →',
        directoryDoesNotExist: 'Directory non trovata',
        createDirectoryConfirm: ({ directory }: { directory: string }) => `La directory ${directory} non esiste. Vuoi crearla?`,
        sessionStarted: 'Sessione avviata',
        sessionStartedMessage: 'La sessione è stata avviata con successo.',
        sessionSpawningFailed: 'Avvio sessione non riuscito - nessun ID sessione restituito.',
        startingSession: 'Avvio sessione...',
        startNewSessionInFolder: 'Nuova sessione qui',
        failedToStart: 'Impossibile avviare la sessione. Assicurati che il daemon sia in esecuzione sulla macchina di destinazione.',
        sessionTimeout: 'Avvio sessione scaduto. La macchina potrebbe essere lenta o il daemon potrebbe non rispondere.',
        notConnectedToServer: 'Non connesso al server. Controlla la tua connessione Internet.',
        noMachineSelected: 'Seleziona una macchina per avviare la sessione',
        noPathSelected: 'Seleziona una directory in cui avviare la sessione',
        sessionType: {
            title: 'Tipo di sessione',
            simple: 'Semplice',
            worktree: 'Worktree',
            comingSoon: 'In arrivo',
        },
        worktree: {
            creating: ({ name }: { name: string }) => `Creazione worktree '${name}'...`,
            notGitRepo: 'Le worktree richiedono un repository git',
            failed: ({ error }: { error: string }) => `Impossibile creare la worktree: ${error}`,
            success: 'Worktree creata con successo',
        }
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Cronologia sessioni',
        empty: 'Nessuna sessione trovata',
        today: 'Oggi',
        yesterday: 'Ieri',
        daysAgo: ({ count }: { count: number }) => `${count} ${count === 1 ? 'giorno' : 'giorni'} fa`,
        viewAll: 'Visualizza tutte le sessioni',
    },

    session: {
        inputPlaceholder: 'Scrivi un messaggio ...',
    },

    commandPalette: {
        placeholder: 'Digita un comando o cerca...',
    },

    server: {
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: 'Configurazione server',
        enterServerUrl: 'Inserisci un URL del server',
        notValidHappyServer: 'Non è un Happy Server valido',
        changeServer: 'Cambia server',
        continueWithServer: 'Continuare con questo server?',
        resetToDefault: 'Ripristina predefinito',
        resetServerDefault: 'Ripristinare il server predefinito?',
        validating: 'Verifica...',
        validatingServer: 'Verifica del server...',
        serverReturnedError: 'Il server ha restituito un errore',
        failedToConnectToServer: 'Impossibile connettersi al server',
        currentlyUsingCustomServer: 'Attualmente si usa un server personalizzato',
        customServerUrlLabel: 'URL server personalizzato',
        advancedFeatureFooter: 'Questa è una funzionalità avanzata. Cambia il server solo se sai cosa stai facendo. Dovrai disconnetterti e accedere di nuovo dopo aver cambiato server.'
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Termina sessione',
        killSessionConfirm: 'Sei sicuro di voler terminare questa sessione?',
        archiveSession: 'Archivia sessione',
        archiveSessionConfirm: 'Sei sicuro di voler archiviare questa sessione?',
        happySessionIdCopied: 'ID sessione Happy copiato negli appunti',
        failedToCopySessionId: 'Impossibile copiare l\'ID sessione Happy',
        happySessionId: 'ID sessione Happy',
        claudeCodeSessionId: 'ID sessione Claude Code',
        claudeCodeSessionIdCopied: 'ID sessione Claude Code copiato negli appunti',
        aiProvider: 'Provider IA',
        failedToCopyClaudeCodeSessionId: 'Impossibile copiare l\'ID sessione Claude Code',
        metadataCopied: 'Metadati copiati negli appunti',
        failedToCopyMetadata: 'Impossibile copiare i metadati',
        failedToKillSession: 'Impossibile terminare la sessione',
        failedToArchiveSession: 'Impossibile archiviare la sessione',
        connectionStatus: 'Stato connessione',
        created: 'Creato',
        lastUpdated: 'Ultimo aggiornamento',
        sequence: 'Sequenza',
        quickActions: 'Azioni rapide',
        viewMachine: 'Visualizza macchina',
        viewMachineSubtitle: 'Visualizza dettagli e sessioni della macchina',
        killSessionSubtitle: 'Termina immediatamente la sessione',
        archiveSessionSubtitle: 'Archivia questa sessione e fermala',
        metadata: 'Metadati',
        host: 'Host',
        path: 'Percorso',
        operatingSystem: 'Sistema operativo',
        processId: 'ID processo',
        happyHome: 'Happy Home',
        copyMetadata: 'Copia metadati',
        agentState: 'Stato agente',
        controlledByUser: 'Controllato dall\'utente',
        pendingRequests: 'Richieste in sospeso',
        activity: 'Attività',
        thinking: 'Pensando',
        thinkingSince: 'Pensando da',
        cliVersion: 'Versione CLI',
        cliVersionOutdated: 'Aggiornamento CLI richiesto',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Versione ${currentVersion} installata. Aggiorna a ${requiredVersion} o successiva`,
        updateCliInstructions: 'Esegui npm install -g happy-coder@latest',
        deleteSession: 'Elimina sessione',
        deleteSessionSubtitle: 'Rimuovi definitivamente questa sessione',
        deleteSessionConfirm: 'Eliminare definitivamente la sessione?',
        deleteSessionWarning: 'Questa azione non può essere annullata. Tutti i messaggi e i dati associati a questa sessione verranno eliminati definitivamente.',
        failedToDeleteSession: 'Impossibile eliminare la sessione',
        sessionDeleted: 'Sessione eliminata con successo',
        
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Pronto a programmare?',
            installCli: 'Installa la CLI Happy',
            runIt: 'Avviala',
            scanQrCode: 'Scansiona il codice QR',
            openCamera: 'Apri fotocamera',
        },
    },

    agentInput: {
        permissionMode: {
            title: 'MODALITÀ PERMESSI',
            default: 'Predefinito',
            acceptEdits: 'Accetta modifiche',
            plan: 'Modalità piano',
            bypassPermissions: 'Modalità YOLO',
            badgeAcceptAllEdits: 'Accetta tutte le modifiche',
            badgeBypassAllPermissions: 'Bypassa tutti i permessi',
            badgePlanMode: 'Modalità piano',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
        },
        model: {
            title: 'MODELLO',
            configureInCli: 'Configura i modelli nelle impostazioni CLI',
        },
        codexPermissionMode: {
            title: 'MODALITÀ PERMESSI CODEX',
            default: 'Impostazioni CLI',
            readOnly: 'Modalità sola lettura',
            safeYolo: 'YOLO sicuro',
            yolo: 'YOLO',
            badgeReadOnly: 'Modalità sola lettura',
            badgeSafeYolo: 'YOLO sicuro',
            badgeYolo: 'YOLO',
        },
        codexModel: {
            title: 'MODELLO CODEX',
            gpt5CodexLow: 'gpt-5-codex basso',
            gpt5CodexMedium: 'gpt-5-codex medio',
            gpt5CodexHigh: 'gpt-5-codex alto',
            gpt5Minimal: 'GPT-5 Minimo',
            gpt5Low: 'GPT-5 Basso',
            gpt5Medium: 'GPT-5 Medio',
            gpt5High: 'GPT-5 Alto',
        },
        geminiPermissionMode: {
            title: 'MODALITÀ PERMESSI GEMINI',
            default: 'Predefinito',
            acceptEdits: 'Accetta modifiche',
            plan: 'Modalità piano',
            bypassPermissions: 'Modalità YOLO',
            badgeAcceptAllEdits: 'Accetta tutte le modifiche',
            badgeBypassAllPermissions: 'Bypassa tutti i permessi',
            badgePlanMode: 'Modalità piano',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% restante`,
        },
        suggestion: {
            fileLabel: 'FILE',
            folderLabel: 'CARTELLA',
        },
        noMachinesAvailable: 'Nessuna macchina',
    },

    machineLauncher: {
        showLess: 'Mostra meno',
        showAll: ({ count }: { count: number }) => `Mostra tutto (${count} percorsi)`,
        enterCustomPath: 'Inserisci percorso personalizzato',
        offlineUnableToSpawn: 'Impossibile avviare una nuova sessione, offline',
    },

    sidebar: {
        sessionsTitle: 'Happy',
    },

    toolView: {
        input: 'Input',
        output: 'Output',
    },

    tools: {
        fullView: {
            description: 'Descrizione',
            inputParams: 'Parametri di input',
            output: 'Output',
            error: 'Errore',
            completed: 'Strumento completato con successo',
            noOutput: 'Nessun output prodotto',
            running: 'Strumento in esecuzione...',
            rawJsonDevMode: 'JSON grezzo (Modalità sviluppatore)',
        },
        taskView: {
            initializing: 'Inizializzazione agente...',
            moreTools: ({ count }: { count: number }) => `+${count} altri ${plural({ count, singular: 'strumento', plural: 'strumenti' })}`,
        },
        askUserQuestion: {
            submit: 'Invia risposta',
            multipleQuestions: ({ count }: { count: number }) => `${count} ${plural({ count, singular: 'domanda', plural: 'domande' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Modifica ${index} di ${total}`,
            replaceAll: 'Sostituisci tutto',
        },
        names: {
            task: 'Attività',
            terminal: 'Terminale',
            searchFiles: 'Cerca file',
            search: 'Cerca',
            searchContent: 'Cerca contenuto',
            listFiles: 'Elenca file',
            planProposal: 'Proposta di piano',
            readFile: 'Leggi file',
            editFile: 'Modifica file',
            writeFile: 'Scrivi file',
            fetchUrl: 'Recupera URL',
            readNotebook: 'Leggi notebook',
            editNotebook: 'Modifica notebook',
            todoList: 'Elenco attività',
            webSearch: 'Ricerca web',
            reasoning: 'Ragionamento',
            applyChanges: 'Aggiorna file',
            viewDiff: 'Modifiche file attuali',
            question: 'Domanda',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminale(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Cerca(pattern: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Cerca(path: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Recupera URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Modifica notebook(file: ${path}, mode: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Elenco attività(count: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Ricerca web(query: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(pattern: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} modifiche)`,
            readingFile: ({ file }: { file: string }) => `Leggendo ${file}`,
            writingFile: ({ file }: { file: string }) => `Scrivendo ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Modificando ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Modificando ${count} file`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} e altri ${count}`,
            showingDiff: 'Mostrando modifiche',
        }
    },

    files: {
        searchPlaceholder: 'Cerca file...',
        detachedHead: 'HEAD scollegato',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} in stage • ${unstaged} non in stage`,
        notRepo: 'Non è un repository git',
        notUnderGit: 'Questa directory non è sotto controllo versione git',
        searching: 'Ricerca file...',
        noFilesFound: 'Nessun file trovato',
        noFilesInProject: 'Nessun file nel progetto',
        tryDifferentTerm: 'Prova un termine di ricerca diverso',
        searchResults: ({ count }: { count: number }) => `Risultati ricerca (${count})`,
        projectRoot: 'Radice progetto',
        stagedChanges: ({ count }: { count: number }) => `Modifiche in stage (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Modifiche non in stage (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Caricamento ${fileName}...`,
        binaryFile: 'File binario',
        cannotDisplayBinary: 'Impossibile mostrare il contenuto del file binario',
        diff: 'Diff',
        file: 'File',
        fileEmpty: 'File vuoto',
        noChanges: 'Nessuna modifica da mostrare',
    },

    settingsVoice: {
        // Voice settings screen
        languageTitle: 'Lingua',
        languageDescription: 'Scegli la tua lingua preferita per le interazioni dell\'assistente vocale. Questa impostazione si sincronizza su tutti i tuoi dispositivi.',
        preferredLanguage: 'Lingua preferita',
        preferredLanguageSubtitle: 'Lingua usata per le risposte dell\'assistente vocale',
        language: {
            searchPlaceholder: 'Cerca lingue...',
            title: 'Lingue',
            footer: ({ count }: { count: number }) => `${count} ${plural({ count, singular: 'lingua', plural: 'lingue' })} disponibili`,
            autoDetect: 'Rilevamento automatico',
        }
    },

    settingsAccount: {
        // Account settings screen
        accountInformation: 'Informazioni account',
        status: 'Stato',
        statusActive: 'Attivo',
        statusNotAuthenticated: 'Non autenticato',
        anonymousId: 'ID anonimo',
        publicId: 'ID pubblico',
        notAvailable: 'Non disponibile',
        linkNewDevice: 'Collega nuovo dispositivo',
        linkNewDeviceSubtitle: 'Scansiona il codice QR per collegare il dispositivo',
        profile: 'Profilo',
        name: 'Nome',
        github: 'GitHub',
        tapToDisconnect: 'Tocca per disconnettere',
        server: 'Server',
        backup: 'Backup',
        backupDescription: 'La tua chiave segreta è l\'unico modo per recuperare l\'account. Salvala in un posto sicuro come un gestore di password.',
        secretKey: 'Chiave segreta',
        tapToReveal: 'Tocca per mostrare',
        tapToHide: 'Tocca per nascondere',
        secretKeyLabel: 'CHIAVE SEGRETA (TOCCA PER COPIARE)',
        secretKeyCopied: 'Chiave segreta copiata negli appunti. Conservala in un luogo sicuro!',
        secretKeyCopyFailed: 'Impossibile copiare la chiave segreta',
        privacy: 'Privacy',
        privacyDescription: 'Aiuta a migliorare l\'app condividendo dati di utilizzo anonimi. Nessuna informazione personale viene raccolta.',
        analytics: 'Analytics',
        analyticsDisabled: 'Nessun dato condiviso',
        analyticsEnabled: 'I dati di utilizzo anonimi sono condivisi',
        dangerZone: 'Zona pericolosa',
        logout: 'Esci',
        logoutSubtitle: 'Disconnetti e cancella i dati locali',
        logoutConfirm: 'Sei sicuro di voler uscire? Assicurati di aver fatto il backup della tua chiave segreta!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Lingua',
        description: 'Scegli la tua lingua preferita per l\'interfaccia dell\'app. Questo si sincronizza su tutti i tuoi dispositivi.',
        currentLanguage: 'Lingua attuale',
        automatic: 'Automatico',
        automaticSubtitle: 'Rileva dalle impostazioni del dispositivo',
        needsRestart: 'Lingua cambiata',
        needsRestartMessage: 'L\'app deve riavviarsi per applicare la nuova impostazione della lingua.',
        restartNow: 'Riavvia ora',
    },

    connectButton: {
        authenticate: 'Autentica terminale',
        authenticateWithUrlPaste: 'Autentica terminale incollando URL',
        pasteAuthUrl: 'Incolla l\'URL di autenticazione dal terminale',
    },

    updateBanner: {
        updateAvailable: 'Aggiornamento disponibile',
        pressToApply: 'Premi per applicare l\'aggiornamento',
        whatsNew: 'Novità',
        seeLatest: 'Vedi gli ultimi aggiornamenti e miglioramenti',
        nativeUpdateAvailable: 'Aggiornamento app disponibile',
        tapToUpdateAppStore: 'Tocca per aggiornare nell\'App Store',
        tapToUpdatePlayStore: 'Tocca per aggiornare nel Play Store',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Versione ${version}`,
        noEntriesAvailable: 'Nessuna voce di changelog disponibile.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Browser web richiesto',
        webBrowserRequiredDescription: 'I link di connessione del terminale possono essere aperti solo in un browser web per motivi di sicurezza. Usa lo scanner QR o apri questo link su un computer.',
        processingConnection: 'Elaborazione connessione...',
        invalidConnectionLink: 'Link di connessione non valido',
        invalidConnectionLinkDescription: 'Il link di connessione è mancante o non valido. Controlla l\'URL e riprova.',
        connectTerminal: 'Connetti terminale',
        terminalRequestDescription: 'Un terminale richiede di connettersi al tuo account Happy Coder. Questo consentirà al terminale di inviare e ricevere messaggi in modo sicuro.',
        connectionDetails: 'Dettagli connessione',
        publicKey: 'Chiave pubblica',
        encryption: 'Cifratura',
        endToEndEncrypted: 'Crittografia end-to-end',
        acceptConnection: 'Accetta connessione',
        connecting: 'Connessione...',
        reject: 'Rifiuta',
        security: 'Sicurezza',
        securityFooter: 'Questo link di connessione è stato elaborato in modo sicuro nel tuo browser e non è mai stato inviato a nessun server. I tuoi dati privati rimarranno sicuri e solo tu potrai decifrare i messaggi.',
        securityFooterDevice: 'Questa connessione è stata elaborata in modo sicuro sul tuo dispositivo e non è mai stata inviata a nessun server. I tuoi dati privati rimarranno sicuri e solo tu potrai decifrare i messaggi.',
        clientSideProcessing: 'Elaborazione lato client',
        linkProcessedLocally: 'Link elaborato localmente nel browser',
        linkProcessedOnDevice: 'Link elaborato localmente sul dispositivo',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Autentica terminale',
        pasteUrlFromTerminal: 'Incolla l\'URL di autenticazione dal terminale',
        deviceLinkedSuccessfully: 'Dispositivo collegato con successo',
        terminalConnectedSuccessfully: 'Terminale collegato con successo',
        invalidAuthUrl: 'URL di autenticazione non valido',
        developerMode: 'Modalità sviluppatore',
        developerModeEnabled: 'Modalità sviluppatore attivata',
        developerModeDisabled: 'Modalità sviluppatore disattivata',
        disconnectGithub: 'Disconnetti GitHub',
        disconnectGithubConfirm: 'Sei sicuro di voler disconnettere il tuo account GitHub?',
        disconnectService: ({ service }: { service: string }) => 
            `Disconnetti ${service}`,
        disconnectServiceConfirm: ({ service }: { service: string }) => 
            `Sei sicuro di voler disconnettere ${service} dal tuo account?`,
        disconnect: 'Disconnetti',
        failedToConnectTerminal: 'Impossibile connettere il terminale',
        cameraPermissionsRequiredToConnectTerminal: 'Sono necessarie le autorizzazioni della fotocamera per connettere il terminale',
        failedToLinkDevice: 'Impossibile collegare il dispositivo',
        cameraPermissionsRequiredToScanQr: 'Sono necessarie le autorizzazioni della fotocamera per scansionare i codici QR'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Connetti terminale',
        linkNewDevice: 'Collega nuovo dispositivo', 
        restoreWithSecretKey: 'Ripristina con chiave segreta',
        whatsNew: 'Novità',
        friends: 'Amici',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Client mobile di Codex e Claude Code',
        subtitle: 'Crittografia end-to-end e account memorizzato solo sul tuo dispositivo.',
        createAccount: 'Crea account',
        linkOrRestoreAccount: 'Collega o ripristina account',
        loginWithMobileApp: 'Accedi con l\'app mobile',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Ti piace l\'app?',
        feedbackPrompt: 'Ci piacerebbe ricevere il tuo feedback!',
        yesILoveIt: 'Sì, mi piace!',
        notReally: 'Non proprio'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copiato negli appunti`
    },

    machine: {
        launchNewSessionInDirectory: 'Avvia nuova sessione nella directory',
        offlineUnableToSpawn: 'Avvio disabilitato quando la macchina è offline',
        offlineHelp: '• Assicurati che il tuo computer sia online\n• Esegui `happy daemon status` per diagnosticare\n• Stai usando l\'ultima versione della CLI? Aggiorna con `npm install -g happy-coder@latest`',
        daemon: 'Daemon',
        status: 'Stato',
        stopDaemon: 'Arresta daemon',
        lastKnownPid: 'Ultimo PID noto',
        lastKnownHttpPort: 'Ultima porta HTTP nota',
        startedAt: 'Avviato alle',
        cliVersion: 'Versione CLI',
        daemonStateVersion: 'Versione stato daemon',
        activeSessions: ({ count }: { count: number }) => `Sessioni attive (${count})`,
        machineGroup: 'Macchina',
        host: 'Host',
        machineId: 'ID macchina',
        username: 'Nome utente',
        homeDirectory: 'Directory home',
        platform: 'Piattaforma',
        architecture: 'Architettura',
        lastSeen: 'Ultimo accesso',
        never: 'Mai',
        metadataVersion: 'Versione metadati',
        untitledSession: 'Sessione senza titolo',
        back: 'Indietro',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Passato alla modalità ${mode}`,
        unknownEvent: 'Evento sconosciuto',
        usageLimitUntil: ({ time }: { time: string }) => `Limite di utilizzo raggiunto fino a ${time}`,
        unknownTime: 'ora sconosciuta',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: 'Sì, e non chiedere per una sessione',
            stopAndExplain: 'Fermati e spiega cosa devo fare',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Sì, consenti tutte le modifiche durante questa sessione',
            yesForTool: 'Sì, non chiedere più per questo strumento',
            noTellClaude: 'No, fornisci feedback',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: 'Seleziona intervallo di testo',
        title: 'Seleziona testo',
        noTextProvided: 'Nessun testo fornito',
        textNotFound: 'Testo non trovato o scaduto',
        textCopied: 'Testo copiato negli appunti',
        failedToCopy: 'Impossibile copiare il testo negli appunti',
        noTextToCopy: 'Nessun testo disponibile da copiare',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Codice copiato',
        copyFailed: 'Copia non riuscita',
        mermaidRenderFailed: 'Impossibile renderizzare il diagramma mermaid',
    },

    artifacts: {
        // Artifacts feature
        title: 'Artefatti',
        countSingular: '1 artefatto',
        countPlural: ({ count }: { count: number }) => `${count} artefatti`,
        empty: 'Nessun artefatto',
        emptyDescription: 'Crea il tuo primo artefatto per iniziare',
        new: 'Nuovo artefatto',
        edit: 'Modifica artefatto',
        delete: 'Elimina',
        updateError: 'Impossibile aggiornare l\'artefatto. Riprova.',
        notFound: 'Artefatto non trovato',
        discardChanges: 'Scartare le modifiche?',
        discardChangesDescription: 'Hai modifiche non salvate. Sei sicuro di volerle scartare?',
        deleteConfirm: 'Eliminare artefatto?',
        deleteConfirmDescription: 'Questa azione non può essere annullata',
        titleLabel: 'TITOLO',
        titlePlaceholder: 'Inserisci un titolo per il tuo artefatto',
        bodyLabel: 'CONTENUTO',
        bodyPlaceholder: 'Scrivi il tuo contenuto qui...',
        emptyFieldsError: 'Inserisci un titolo o un contenuto',
        createError: 'Impossibile creare l\'artefatto. Riprova.',
        save: 'Salva',
        saving: 'Salvataggio...',
        loading: 'Caricamento artefatti...',
        error: 'Impossibile caricare l\'artefatto',
    },

    friends: {
        // Friends feature
        title: 'Amici',
        manageFriends: 'Gestisci i tuoi amici e le connessioni',
        searchTitle: 'Trova amici',
        pendingRequests: 'Richieste di amicizia',
        myFriends: 'I miei amici',
        noFriendsYet: 'Non hai ancora amici',
        findFriends: 'Trova amici',
        remove: 'Rimuovi',
        pendingRequest: 'In attesa',
        sentOn: ({ date }: { date: string }) => `Inviata il ${date}`,
        accept: 'Accetta',
        reject: 'Rifiuta',
        addFriend: 'Aggiungi amico',
        alreadyFriends: 'Già amici',
        requestPending: 'Richiesta in sospeso',
        searchInstructions: 'Inserisci un nome utente per cercare amici',
        searchPlaceholder: 'Inserisci nome utente...',
        searching: 'Ricerca...',
        userNotFound: 'Utente non trovato',
        noUserFound: 'Nessun utente trovato con quel nome',
        checkUsername: 'Controlla il nome utente e riprova',
        howToFind: 'Come trovare amici',
        findInstructions: 'Cerca amici tramite il loro nome utente. Sia tu che il tuo amico dovete avere GitHub collegato per inviare richieste di amicizia.',
        requestSent: 'Richiesta di amicizia inviata!',
        requestAccepted: 'Richiesta di amicizia accettata!',
        requestRejected: 'Richiesta di amicizia rifiutata',
        friendRemoved: 'Amico rimosso',
        confirmRemove: 'Rimuovi amico',
        confirmRemoveMessage: 'Sei sicuro di voler rimuovere questo amico?',
        cannotAddYourself: 'Non puoi inviare una richiesta di amicizia a te stesso',
        bothMustHaveGithub: 'Entrambi gli utenti devono avere GitHub collegato per diventare amici',
        status: {
            none: 'Non connesso',
            requested: 'Richiesta inviata',
            pending: 'Richiesta in sospeso',
            friend: 'Amici',
            rejected: 'Rifiutata',
        },
        acceptRequest: 'Accetta richiesta',
        removeFriend: 'Rimuovi amico',
        removeFriendConfirm: ({ name }: { name: string }) => `Sei sicuro di voler rimuovere ${name} dagli amici?`,
        requestSentDescription: ({ name }: { name: string }) => `La tua richiesta di amicizia è stata inviata a ${name}`,
        requestFriendship: 'Richiedi amicizia',
        cancelRequest: 'Annulla richiesta di amicizia',
        cancelRequestConfirm: ({ name }: { name: string }) => `Annullare la tua richiesta di amicizia a ${name}?`,
        denyRequest: 'Rifiuta richiesta',
        nowFriendsWith: ({ name }: { name: string }) => `Ora sei amico di ${name}`,
    },

    usage: {
        // Usage panel strings
        today: 'Oggi',
        last7Days: 'Ultimi 7 giorni',
        last30Days: 'Ultimi 30 giorni',
        totalTokens: 'Token totali',
        totalCost: 'Costo totale',
        tokens: 'Token',
        cost: 'Costo',
        usageOverTime: 'Utilizzo nel tempo',
        byModel: 'Per modello',
        noData: 'Nessun dato di utilizzo disponibile',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
        friendRequestFrom: ({ name }: { name: string }) => `${name} ti ha inviato una richiesta di amicizia`,
        friendRequestGeneric: 'Nuova richiesta di amicizia',
        friendAccepted: ({ name }: { name: string }) => `Ora sei amico di ${name}`,
        friendAcceptedGeneric: 'Richiesta di amicizia accettata',
    }
} as const;

export type TranslationsIt = typeof it;
