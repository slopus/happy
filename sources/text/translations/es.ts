import type { TranslationStructure } from '../_types';

/**
 * Spanish plural helper function
 * Spanish has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Spanish plural rules
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

/**
 * Spanish translations for the Happy app
 * Must match the exact structure of the English translations
 */
export const es: TranslationStructure = {
    tabs: {
        // Tab navigation labels
        inbox: 'Bandeja',
        sessions: 'Terminales',
        settings: 'Configuración',
    },

    inbox: {
        // Inbox screen
        emptyTitle: 'Bandeja vacía',
        emptyDescription: 'Conéctate con amigos para empezar a compartir sesiones',
        updates: 'Actualizaciones',
    },

    common: {
        // Simple string constants
        add: 'Añadir',
        actions: 'Acciones',
        cancel: 'Cancelar',
        authenticate: 'Autenticar',
        save: 'Guardar',
        saveAs: 'Guardar como',
        error: 'Error',
        success: 'Éxito',
        ok: 'OK',
        continue: 'Continuar',
        back: 'Atrás',
        create: 'Crear',
        rename: 'Renombrar',
        reset: 'Restablecer',
        logout: 'Cerrar sesión',
        yes: 'Sí',
        no: 'No',
        discard: 'Descartar',
        discardChanges: 'Descartar cambios',
        unsavedChangesWarning: 'Tienes cambios sin guardar.',
        keepEditing: 'Seguir editando',
        version: 'Versión',
        copied: 'Copiado',
        copy: 'Copiar',
        scanning: 'Escaneando...',
        urlPlaceholder: 'https://ejemplo.com',
        home: 'Inicio',
        message: 'Mensaje',
        files: 'Archivos',
        fileViewer: 'Visor de archivos',
        loading: 'Cargando...',
        retry: 'Reintentar',
        delete: 'Eliminar',
        optional: 'opcional',
        noMatches: 'Sin coincidencias',
        all: 'All',
        machine: 'máquina',
        clearSearch: 'Clear search',
    },

    profile: {
        userProfile: 'Perfil de usuario',
        details: 'Detalles',
        firstName: 'Nombre',
        lastName: 'Apellido',
        username: 'Nombre de usuario',
        status: 'Estado',
    },


    status: {
        connected: 'conectado',
        connecting: 'conectando',
        disconnected: 'desconectado',
        error: 'error',
        online: 'en línea',
        offline: 'desconectado',
        lastSeen: ({ time }: { time: string }) => `visto por última vez ${time}`,
        permissionRequired: 'permiso requerido',
        activeNow: 'Activo ahora',
        unknown: 'desconocido',
    },

    time: {
        justNow: 'ahora mismo',
        minutesAgo: ({ count }: { count: number }) => `hace ${count} minuto${count !== 1 ? 's' : ''}`,
        hoursAgo: ({ count }: { count: number }) => `hace ${count} hora${count !== 1 ? 's' : ''}`,
    },

    connect: {
        restoreAccount: 'Restaurar cuenta',
        enterSecretKey: 'Ingresa tu clave secreta',
        invalidSecretKey: 'Clave secreta inválida. Verifica e intenta de nuevo.',
        enterUrlManually: 'Ingresar URL manualmente',
    },

    settings: {
        title: 'Configuración',
        connectedAccounts: 'Cuentas conectadas',
        connectAccount: 'Conectar cuenta',
        github: 'GitHub',
        machines: 'Máquinas',
        features: 'Características',
        social: 'Social',
        account: 'Cuenta',
        accountSubtitle: 'Gestiona los detalles de tu cuenta',
        appearance: 'Apariencia',
        appearanceSubtitle: 'Personaliza como se ve la app',
        voiceAssistant: 'Asistente de voz',
        voiceAssistantSubtitle: 'Configura las preferencias de voz',
        featuresTitle: 'Características',
        featuresSubtitle: 'Habilitar o deshabilitar funciones de la aplicación',
        developer: 'Desarrollador',
        developerTools: 'Herramientas de desarrollador',
        about: 'Acerca de',
        aboutFooter: 'Happy Coder es un cliente móvil para Codex y Claude Code. Todo está cifrado de extremo a extremo y tu cuenta se guarda solo en tu dispositivo. No está afiliado con Anthropic.',
        whatsNew: 'Novedades',
        whatsNewSubtitle: 'Ve las últimas actualizaciones y mejoras',
        reportIssue: 'Reportar un problema',
        privacyPolicy: 'Política de privacidad',
        termsOfService: 'Términos de servicio',
        eula: 'EULA',
        supportUs: 'Apóyanos',
        supportUsSubtitlePro: '¡Gracias por su apoyo!',
        supportUsSubtitle: 'Apoya el desarrollo del proyecto',
        scanQrCodeToAuthenticate: 'Escanea el código QR para autenticarte',
        githubConnected: ({ login }: { login: string }) => `Conectado como @${login}`,
        connectGithubAccount: 'Conecta tu cuenta de GitHub',
        claudeAuthSuccess: 'Conectado exitosamente con Claude',
        exchangingTokens: 'Intercambiando tokens...',
        usage: 'Uso',
        usageSubtitle: 'Ver tu uso de API y costos',
        profiles: 'Perfiles',
        profilesSubtitle: 'Gestionar perfiles de variables de entorno para sesiones',

        // Dynamic settings messages
        accountConnected: ({ service }: { service: string }) => `Cuenta de ${service} conectada`,
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} está ${status === 'online' ? 'en línea' : 'desconectado'}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'habilitada' : 'deshabilitada'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Tema',
        themeDescription: 'Elige tu esquema de colores preferido',
        themeOptions: {
            adaptive: 'Adaptativo',
            light: 'Claro', 
            dark: 'Oscuro',
        },
        themeDescriptions: {
            adaptive: 'Seguir configuración del sistema',
            light: 'Usar siempre tema claro',
            dark: 'Usar siempre tema oscuro',
        },
        display: 'Pantalla',
        displayDescription: 'Controla diseño y espaciado',
        inlineToolCalls: 'Llamadas a herramientas en línea',
        inlineToolCallsDescription: 'Mostrar llamadas a herramientas directamente en mensajes de chat',
        expandTodoLists: 'Expandir listas de tareas',
        expandTodoListsDescription: 'Mostrar todas las tareas en lugar de solo cambios',
        showLineNumbersInDiffs: 'Mostrar números de línea en diferencias',
        showLineNumbersInDiffsDescription: 'Mostrar números de línea en diferencias de código',
        showLineNumbersInToolViews: 'Mostrar números de línea en vistas de herramientas',
        showLineNumbersInToolViewsDescription: 'Mostrar números de línea en diferencias de vistas de herramientas',
        wrapLinesInDiffs: 'Ajustar líneas en diferencias',
        wrapLinesInDiffsDescription: 'Ajustar líneas largas en lugar de desplazamiento horizontal en vistas de diferencias',
        alwaysShowContextSize: 'Mostrar siempre tamaño del contexto',
        alwaysShowContextSizeDescription: 'Mostrar uso del contexto incluso cuando no esté cerca del límite',
        avatarStyle: 'Estilo de avatar',
        avatarStyleDescription: 'Elige la apariencia del avatar de sesión',
        avatarOptions: {
            pixelated: 'Pixelado',
            gradient: 'Gradiente',
            brutalist: 'Brutalista',
        },
        showFlavorIcons: 'Mostrar íconos de proveedor de IA',
        showFlavorIconsDescription: 'Mostrar íconos del proveedor de IA en los avatares de sesión',
        compactSessionView: 'Vista compacta de sesiones',
        compactSessionViewDescription: 'Mostrar sesiones activas en un diseño más compacto',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Experimentos',
        experimentsDescription: 'Habilitar características experimentales que aún están en desarrollo. Estas características pueden ser inestables o cambiar sin aviso.',
        experimentalFeatures: 'Características experimentales',
        experimentalFeaturesEnabled: 'Características experimentales habilitadas',
        experimentalFeaturesDisabled: 'Usando solo características estables',
        webFeatures: 'Características web',
        webFeaturesDescription: 'Características disponibles solo en la versión web de la aplicación.',
        enterToSend: 'Enter para enviar',
        enterToSendEnabled: 'Presiona Enter para enviar (Shift+Enter para una nueva línea)',
        enterToSendDisabled: 'Enter inserta una nueva línea',
        commandPalette: 'Paleta de comandos',
        commandPaletteEnabled: 'Presione ⌘K para abrir',
        commandPaletteDisabled: 'Acceso rápido a comandos deshabilitado',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Pulsación larga abre modal de copiado',
        hideInactiveSessions: 'Ocultar sesiones inactivas',
        hideInactiveSessionsSubtitle: 'Muestra solo los chats activos en tu lista',
        enhancedSessionWizard: 'Asistente de sesión mejorado',
        enhancedSessionWizardEnabled: 'Lanzador de sesión con perfil activo',
        enhancedSessionWizardDisabled: 'Usando el lanzador de sesión estándar',
        profiles: 'Perfiles de IA',
        profilesEnabled: 'Selección de perfiles habilitada',
        profilesDisabled: 'Selección de perfiles deshabilitada',
        pickerSearch: 'Búsqueda en selectores',
        pickerSearchSubtitle: 'Mostrar un campo de búsqueda en los selectores de máquina y ruta',
        machinePickerSearch: 'Búsqueda de máquinas',
        machinePickerSearchSubtitle: 'Mostrar un campo de búsqueda en los selectores de máquinas',
        pathPickerSearch: 'Búsqueda de rutas',
        pathPickerSearchSubtitle: 'Mostrar un campo de búsqueda en los selectores de rutas',
    },

    errors: {
        networkError: 'Error de conexión',
        serverError: 'Error del servidor',
        unknownError: 'Error desconocido',
        connectionTimeout: 'Se agotó el tiempo de conexión',
        authenticationFailed: 'Falló la autenticación',
        permissionDenied: 'Permiso denegado',
        fileNotFound: 'Archivo no encontrado',
        invalidFormat: 'Formato inválido',
        operationFailed: 'Operación falló',
        tryAgain: 'Intenta de nuevo',
        contactSupport: 'Contacta soporte si el problema persiste',
        sessionNotFound: 'Sesión no encontrada',
        voiceSessionFailed: 'Falló al iniciar sesión de voz',
        voiceServiceUnavailable: 'El servicio de voz no está disponible temporalmente',
        oauthInitializationFailed: 'Falló al inicializar el flujo OAuth',
        tokenStorageFailed: 'Falló al almacenar los tokens de autenticación',
        oauthStateMismatch: 'Falló la validación de seguridad. Inténtalo de nuevo',
        tokenExchangeFailed: 'Falló al intercambiar el código de autorización',
        oauthAuthorizationDenied: 'La autorización fue denegada',
        webViewLoadFailed: 'Falló al cargar la página de autenticación',
        failedToLoadProfile: 'No se pudo cargar el perfil de usuario',
        userNotFound: 'Usuario no encontrado',
        sessionDeleted: 'La sesión ha sido eliminada',
        sessionDeletedDescription: 'Esta sesión ha sido eliminada permanentemente',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} debe estar entre ${min} y ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Intenta en ${seconds} ${seconds === 1 ? 'segundo' : 'segundos'}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Error ${code})`,
        disconnectServiceFailed: ({ service }: { service: string }) => 
            `Falló al desconectar ${service}`,
        connectServiceFailed: ({ service }: { service: string }) =>
            `No se pudo conectar ${service}. Por favor, inténtalo de nuevo.`,
        failedToLoadFriends: 'No se pudo cargar la lista de amigos',
        failedToAcceptRequest: 'No se pudo aceptar la solicitud de amistad',
        failedToRejectRequest: 'No se pudo rechazar la solicitud de amistad',
        failedToRemoveFriend: 'No se pudo eliminar al amigo',
        searchFailed: 'La búsqueda falló. Por favor, intenta de nuevo.',
        failedToSendRequest: 'No se pudo enviar la solicitud de amistad',
    },

    newSession: {
        // Used by new-session screen and launch flows
        title: 'Iniciar nueva sesión',
        selectMachineTitle: 'Seleccionar máquina',
        selectPathTitle: 'Seleccionar ruta',
        searchPathsPlaceholder: 'Buscar rutas...',
        noMachinesFound: 'No se encontraron máquinas. Inicia una sesión de Happy en tu computadora primero.',
        allMachinesOffline: 'Todas las máquinas están desconectadas',
        machineDetails: 'Ver detalles de la máquina →',
        directoryDoesNotExist: 'Directorio no encontrado',
        createDirectoryConfirm: ({ directory }: { directory: string }) => `El directorio ${directory} no existe. ¿Deseas crearlo?`,
        sessionStarted: 'Sesión iniciada',
        sessionStartedMessage: 'La sesión se ha iniciado correctamente.',
        sessionSpawningFailed: 'Falló la creación de sesión - no se devolvió ID de sesión.',
        failedToStart: 'Falló al iniciar sesión. Asegúrate de que el daemon esté ejecutándose en la máquina objetivo.',
        sessionTimeout: 'El inicio de sesión expiró. La máquina puede ser lenta o el daemon puede no estar respondiendo.',
        notConnectedToServer: 'No conectado al servidor. Verifica tu conexión a internet.',
        startingSession: 'Iniciando sesión...',
        startNewSessionInFolder: 'Nueva sesión aquí',
        noMachineSelected: 'Por favor, selecciona una máquina para iniciar la sesión',
        noPathSelected: 'Por favor, selecciona un directorio para iniciar la sesión',
        machinePicker: {
            searchPlaceholder: 'Buscar máquinas...',
            recentTitle: 'Recientes',
            favoritesTitle: 'Favoritos',
            allTitle: 'Todas',
            emptyMessage: 'No hay máquinas disponibles',
        },
        pathPicker: {
            enterPathTitle: 'Ingresar ruta',
            enterPathPlaceholder: 'Ingresa una ruta...',
            customPathTitle: 'Ruta personalizada',
            recentTitle: 'Recientes',
            favoritesTitle: 'Favoritos',
            suggestedTitle: 'Sugeridas',
            allTitle: 'Todas',
            emptyRecent: 'No hay rutas recientes',
            emptyFavorites: 'No hay rutas favoritas',
            emptySuggested: 'No hay rutas sugeridas',
            emptyAll: 'No hay rutas',
        },
        sessionType: {
            title: 'Tipo de sesión',
            simple: 'Simple',
            worktree: 'Worktree',
            comingSoon: 'Próximamente',
        },
        worktree: {
            creating: ({ name }: { name: string }) => `Creando worktree '${name}'...`,
            notGitRepo: 'Los worktrees requieren un repositorio git',
            failed: ({ error }: { error: string }) => `Error al crear worktree: ${error}`,
            success: 'Worktree creado exitosamente',
        }
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Historial de sesiones',
        empty: 'No se encontraron sesiones',
        today: 'Hoy',
        yesterday: 'Ayer',
        daysAgo: ({ count }: { count: number }) => `hace ${count} ${count === 1 ? 'día' : 'días'}`,
        viewAll: 'Ver todas las sesiones',
    },

    session: {
        inputPlaceholder: 'Escriba un mensaje ...',
    },

    commandPalette: {
        placeholder: 'Escriba un comando o busque...',
    },

    server: {
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: 'Configuración del servidor',
        enterServerUrl: 'Ingresa una URL de servidor',
        notValidHappyServer: 'No es un servidor Happy válido',
        changeServer: 'Cambiar servidor',
        continueWithServer: '¿Continuar con este servidor?',
        resetToDefault: 'Restablecer por defecto',
        resetServerDefault: '¿Restablecer servidor por defecto?',
        validating: 'Validando...',
        validatingServer: 'Validando servidor...',
        serverReturnedError: 'El servidor devolvió un error',
        failedToConnectToServer: 'Falló al conectar con el servidor',
        currentlyUsingCustomServer: 'Actualmente usando servidor personalizado',
        customServerUrlLabel: 'URL del servidor personalizado',
        advancedFeatureFooter: 'Esta es una característica avanzada. Solo cambia el servidor si sabes lo que haces. Necesitarás cerrar sesión e iniciarla nuevamente después de cambiar servidores.'
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Terminar sesión',
        killSessionConfirm: '¿Seguro que quieres terminar esta sesión?',
        archiveSession: 'Archivar sesión',
        archiveSessionConfirm: '¿Seguro que quieres archivar esta sesión?',
        happySessionIdCopied: 'ID de sesión de Happy copiado al portapapeles',
        failedToCopySessionId: 'Falló al copiar ID de sesión de Happy',
        happySessionId: 'ID de sesión de Happy',
        claudeCodeSessionId: 'ID de sesión de Claude Code',
        claudeCodeSessionIdCopied: 'ID de sesión de Claude Code copiado al portapapeles',
        aiProfile: 'Perfil de IA',
        aiProvider: 'Proveedor de IA',
        failedToCopyClaudeCodeSessionId: 'Falló al copiar ID de sesión de Claude Code',
        metadataCopied: 'Metadatos copiados al portapapeles',
        failedToCopyMetadata: 'Falló al copiar metadatos',
        failedToKillSession: 'Falló al terminar sesión',
        failedToArchiveSession: 'Falló al archivar sesión',
        connectionStatus: 'Estado de conexión',
        created: 'Creado',
        lastUpdated: 'Última actualización',
        sequence: 'Secuencia',
        quickActions: 'Acciones rápidas',
        viewMachine: 'Ver máquina',
        viewMachineSubtitle: 'Ver detalles de máquina y sesiones',
        killSessionSubtitle: 'Terminar inmediatamente la sesión',
        archiveSessionSubtitle: 'Archivar esta sesión y detenerla',
        metadata: 'Metadatos',
        host: 'Host',
        path: 'Ruta',
        operatingSystem: 'Sistema operativo',
        processId: 'ID del proceso',
        happyHome: 'Directorio de Happy',
        copyMetadata: 'Copiar metadatos',
        agentState: 'Estado del agente',
        controlledByUser: 'Controlado por el usuario',
        pendingRequests: 'Solicitudes pendientes',
        activity: 'Actividad',
        thinking: 'Pensando',
        thinkingSince: 'Pensando desde',
        cliVersion: 'Versión del CLI',
        cliVersionOutdated: 'Actualización de CLI requerida',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Versión ${currentVersion} instalada. Actualice a ${requiredVersion} o posterior`,
        updateCliInstructions: 'Por favor ejecute npm install -g happy-coder@latest',
        deleteSession: 'Eliminar sesión',
        deleteSessionSubtitle: 'Eliminar permanentemente esta sesión',
        deleteSessionConfirm: '¿Eliminar sesión permanentemente?',
        deleteSessionWarning: 'Esta acción no se puede deshacer. Todos los mensajes y datos asociados con esta sesión se eliminarán permanentemente.',
        failedToDeleteSession: 'Error al eliminar la sesión',
        sessionDeleted: 'Sesión eliminada exitosamente',
        
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: '¿Listo para programar?',
            installCli: 'Instale el Happy CLI',
            runIt: 'Ejecútelo',
            scanQrCode: 'Escanee el código QR',
            openCamera: 'Abrir cámara',
        },
    },

    agentInput: {
        envVars: {
            title: 'Variables de entorno',
            titleWithCount: ({ count }: { count: number }) => `Variables de entorno (${count})`,
        },
        permissionMode: {
            title: 'MODO DE PERMISOS',
            default: 'Por defecto',
            acceptEdits: 'Aceptar ediciones',
            plan: 'Modo de planificación',
            bypassPermissions: 'Modo Yolo',
            badgeAcceptAllEdits: 'Aceptar todas las ediciones',
            badgeBypassAllPermissions: 'Omitir todos los permisos',
            badgePlanMode: 'Modo de planificación',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
            gemini: 'Gemini',
        },
        model: {
            title: 'MODELO',
            configureInCli: 'Configurar modelos en la configuración del CLI',
        },
        codexPermissionMode: {
            title: 'MODO DE PERMISOS CODEX',
            default: 'Configuración del CLI',
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
            title: 'MODO DE PERMISOS GEMINI',
            default: 'Por defecto',
            readOnly: 'Solo lectura',
            safeYolo: 'YOLO seguro',
            yolo: 'YOLO',
            badgeReadOnly: 'Solo lectura',
            badgeSafeYolo: 'YOLO seguro',
            badgeYolo: 'YOLO',
        },
        geminiModel: {
            title: 'MODELO GEMINI',
            gemini25Pro: {
                label: 'Gemini 2.5 Pro',
                description: 'Más capaz',
            },
            gemini25Flash: {
                label: 'Gemini 2.5 Flash',
                description: 'Rápido y eficiente',
            },
            gemini25FlashLite: {
                label: 'Gemini 2.5 Flash Lite',
                description: 'Más rápido',
            },
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% restante`,
        },
        suggestion: {
            fileLabel: 'ARCHIVO',
            folderLabel: 'CARPETA',
        },
        noMachinesAvailable: 'Sin máquinas',
    },

    machineLauncher: {
        showLess: 'Mostrar menos',
        showAll: ({ count }: { count: number }) => `Mostrar todos (${count} rutas)`,
        enterCustomPath: 'Ingresar ruta personalizada',
        offlineUnableToSpawn: 'No se puede crear nueva sesión, desconectado',
    },

    sidebar: {
        sessionsTitle: 'Happy',
    },

    toolView: {
        input: 'Entrada',
        output: 'Salida',
    },

    tools: {
        fullView: {
            description: 'Descripción',
            inputParams: 'Parámetros de entrada',
            output: 'Salida',
            error: 'Error',
            completed: 'Herramienta completada exitosamente',
            noOutput: 'No se produjo salida',
            running: 'La herramienta está ejecutándose...',
            rawJsonDevMode: 'JSON crudo (modo desarrollador)',
        },
        taskView: {
            initializing: 'Inicializando agente...',
            moreTools: ({ count }: { count: number }) => `+${count} más ${plural({ count, singular: 'herramienta', plural: 'herramientas' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Edición ${index} de ${total}`,
            replaceAll: 'Reemplazar todo',
        },
        names: {
            task: 'Tarea',
            terminal: 'Terminal',
            searchFiles: 'Buscar archivos',
            search: 'Buscar',
            searchContent: 'Buscar contenido',
            listFiles: 'Listar archivos',
            planProposal: 'Propuesta de plan',
            readFile: 'Leer archivo',
            editFile: 'Editar archivo',
            writeFile: 'Escribir archivo',
            fetchUrl: 'Obtener URL',
            readNotebook: 'Leer cuaderno',
            editNotebook: 'Editar cuaderno',
            todoList: 'Lista de tareas',
            webSearch: 'Búsqueda web',
            reasoning: 'Razonamiento',
            applyChanges: 'Actualizar archivo',
            viewDiff: 'Cambios del archivo actual',
            question: 'Pregunta',
            changeTitle: 'Cambiar título',
        },
        geminiExecute: {
            cwd: ({ cwd }: { cwd: string }) => `📁 ${cwd}`,
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Buscar(patrón: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Buscar(ruta: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Obtener URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Editar cuaderno(archivo: ${path}, modo: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Lista de tareas(cantidad: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Búsqueda web(consulta: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(patrón: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} ediciones)`,
            readingFile: ({ file }: { file: string }) => `Leyendo ${file}`,
            writingFile: ({ file }: { file: string }) => `Escribiendo ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Modificando ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Modificando ${count} archivos`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} y ${count} más`,
            showingDiff: 'Mostrando cambios',
        },
        askUserQuestion: {
            submit: 'Enviar respuesta',
            multipleQuestions: ({ count }: { count: number }) => `${count} ${plural({ count, singular: 'pregunta', plural: 'preguntas' })}`,
        }
    },

    files: {
        searchPlaceholder: 'Buscar archivos...',
        detachedHead: 'HEAD separado',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} preparados • ${unstaged} sin preparar`,
        notRepo: 'No es un repositorio git',
        notUnderGit: 'Este directorio no está bajo control de versiones git',
        searching: 'Buscando archivos...',
        noFilesFound: 'No se encontraron archivos',
        noFilesInProject: 'No hay archivos en el proyecto',
        tryDifferentTerm: 'Intente un término de búsqueda diferente',
        searchResults: ({ count }: { count: number }) => `Resultados de búsqueda (${count})`,
        projectRoot: 'Raíz del proyecto',
        stagedChanges: ({ count }: { count: number }) => `Cambios preparados (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Cambios sin preparar (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Cargando ${fileName}...`,
        binaryFile: 'Archivo binario',
        cannotDisplayBinary: 'No se puede mostrar el contenido del archivo binario',
        diff: 'Diferencias',
        file: 'Archivo',
        fileEmpty: 'El archivo está vacío',
        noChanges: 'No hay cambios que mostrar',
    },

    settingsVoice: {
        // Voice settings screen
        languageTitle: 'Idioma',
        languageDescription: 'Elige tu idioma preferido para las interacciones con el asistente de voz. Esta configuración se sincroniza en todos tus dispositivos.',
        preferredLanguage: 'Idioma preferido',
        preferredLanguageSubtitle: 'Idioma usado para respuestas del asistente de voz',
        language: {
            searchPlaceholder: 'Buscar idiomas...',
            title: 'Idiomas',
            footer: ({ count }: { count: number }) => `${count} ${plural({ count, singular: 'idioma', plural: 'idiomas' })} disponibles`,
            autoDetect: 'Detectar automáticamente',
        }
    },

    settingsAccount: {
        // Account settings screen
        accountInformation: 'Información de la cuenta',
        status: 'Estado',
        statusActive: 'Activo',
        statusNotAuthenticated: 'No autenticado',
        anonymousId: 'ID anónimo',
        publicId: 'ID público',
        notAvailable: 'No disponible',
        linkNewDevice: 'Vincular nuevo dispositivo',
        linkNewDeviceSubtitle: 'Escanear código QR para vincular dispositivo',
        profile: 'Perfil',
        name: 'Nombre',
        github: 'GitHub',
        tapToDisconnect: 'Toque para desconectar',
        server: 'Servidor',
        backup: 'Copia de seguridad',
        backupDescription: 'Tu clave secreta es la única forma de recuperar tu cuenta. Guárdala en un lugar seguro como un administrador de contraseñas.',
        secretKey: 'Clave secreta',
        tapToReveal: 'Toca para revelar',
        tapToHide: 'Toca para ocultar',
        secretKeyLabel: 'CLAVE SECRETA (TOCA PARA COPIAR)',
        secretKeyCopied: 'Clave secreta copiada al portapapeles. ¡Guárdala en un lugar seguro!',
        secretKeyCopyFailed: 'Falló al copiar la clave secreta',
        privacy: 'Privacidad',
        privacyDescription: 'Ayude a mejorar la aplicación compartiendo datos de uso anónimos. No se recopila información personal.',
        analytics: 'Analíticas',
        analyticsDisabled: 'No se comparten datos',
        analyticsEnabled: 'Se comparten datos de uso anónimos',
        dangerZone: 'Zona peligrosa',
        logout: 'Cerrar sesión',
        logoutSubtitle: 'Cerrar sesión y limpiar datos locales',
        logoutConfirm: '¿Seguro que quieres cerrar sesión? ¡Asegúrate de haber guardado tu clave secreta!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Idioma',
        description: 'Elige tu idioma preferido para la interfaz de la aplicación. Esto se sincronizará en todos tus dispositivos.',
        currentLanguage: 'Idioma actual',
        automatic: 'Automático',
        automaticSubtitle: 'Detectar desde configuración del dispositivo',
        needsRestart: 'Idioma cambiado',
        needsRestartMessage: 'La aplicación necesita reiniciarse para aplicar la nueva configuración de idioma.',
        restartNow: 'Reiniciar ahora',
    },

    connectButton: {
        authenticate: 'Autenticar terminal',
        authenticateWithUrlPaste: 'Autenticar terminal con pegado de URL',
        pasteAuthUrl: 'Pega la URL de autenticación de tu terminal',
    },

    updateBanner: {
        updateAvailable: 'Actualización disponible',
        pressToApply: 'Presione para aplicar la actualización',
        whatsNew: 'Novedades',
        seeLatest: 'Ver las últimas actualizaciones y mejoras',
        nativeUpdateAvailable: 'Actualización de la aplicación disponible',
        tapToUpdateAppStore: 'Toque para actualizar en App Store',
        tapToUpdatePlayStore: 'Toque para actualizar en Play Store',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Versión ${version}`,
        noEntriesAvailable: 'No hay entradas de registro de cambios disponibles.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Se requiere navegador web',
        webBrowserRequiredDescription: 'Los enlaces de conexión de terminal solo pueden abrirse en un navegador web por razones de seguridad. Usa el escáner de código QR o abre este enlace en una computadora.',
        processingConnection: 'Procesando conexión...',
        invalidConnectionLink: 'Enlace de conexión inválido',
        invalidConnectionLinkDescription: 'El enlace de conexión falta o es inválido. Verifica la URL e intenta nuevamente.',
        connectTerminal: 'Conectar terminal',
        terminalRequestDescription: 'Un terminal está solicitando conectarse a tu cuenta de Happy Coder. Esto permitirá al terminal enviar y recibir mensajes de forma segura.',
        connectionDetails: 'Detalles de conexión',
        publicKey: 'Clave pública',
        encryption: 'Cifrado',
        endToEndEncrypted: 'Cifrado de extremo a extremo',
        acceptConnection: 'Aceptar conexión',
        connecting: 'Conectando...',
        reject: 'Rechazar',
        security: 'Seguridad',
        securityFooter: 'Este enlace de conexión fue procesado de forma segura en tu navegador y nunca fue enviado a ningún servidor. Tus datos privados permanecerán seguros y solo tú puedes descifrar los mensajes.',
        securityFooterDevice: 'Esta conexión fue procesada de forma segura en tu dispositivo y nunca fue enviada a ningún servidor. Tus datos privados permanecerán seguros y solo tú puedes descifrar los mensajes.',
        clientSideProcessing: 'Procesamiento del lado del cliente',
        linkProcessedLocally: 'Enlace procesado localmente en el navegador',
        linkProcessedOnDevice: 'Enlace procesado localmente en el dispositivo',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Autenticar terminal',
        pasteUrlFromTerminal: 'Pega la URL de autenticación de tu terminal',
        deviceLinkedSuccessfully: 'Dispositivo vinculado exitosamente',
        terminalConnectedSuccessfully: 'Terminal conectado exitosamente',
        invalidAuthUrl: 'URL de autenticación inválida',
        developerMode: 'Modo desarrollador',
        developerModeEnabled: 'Modo desarrollador habilitado',
        developerModeDisabled: 'Modo desarrollador deshabilitado',
        disconnectGithub: 'Desconectar GitHub',
        disconnectGithubConfirm: '¿Seguro que quieres desconectar tu cuenta de GitHub?',
        disconnectService: ({ service }: { service: string }) => 
            `Desconectar ${service}`,
        disconnectServiceConfirm: ({ service }: { service: string }) => 
            `¿Seguro que quieres desconectar ${service} de tu cuenta?`,
        disconnect: 'Desconectar',
        failedToConnectTerminal: 'Falló al conectar terminal',
        cameraPermissionsRequiredToConnectTerminal: 'Se requieren permisos de cámara para conectar terminal',
        failedToLinkDevice: 'Falló al vincular dispositivo',
        cameraPermissionsRequiredToScanQr: 'Se requieren permisos de cámara para escanear códigos QR'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Conectar terminal',
        linkNewDevice: 'Vincular nuevo dispositivo', 
        restoreWithSecretKey: 'Restaurar con clave secreta',
        whatsNew: 'Novedades',
        friends: 'Amigos',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Cliente móvil de Codex y Claude Code',
        subtitle: 'Cifrado de extremo a extremo y tu cuenta se guarda solo en tu dispositivo.',
        createAccount: 'Crear cuenta',
        linkOrRestoreAccount: 'Vincular o restaurar cuenta',
        loginWithMobileApp: 'Iniciar sesión con aplicación móvil',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: '¿Disfrutando la aplicación?',
        feedbackPrompt: '¡Nos encantaría escuchar tus comentarios!',
        yesILoveIt: '¡Sí, me encanta!',
        notReally: 'No realmente'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copiado al portapapeles`
    },

    machine: {
        offlineUnableToSpawn: 'El lanzador está deshabilitado mientras la máquina está desconectada',
        offlineHelp: '• Asegúrate de que tu computadora esté en línea\n• Ejecuta `happy daemon status` para diagnosticar\n• ¿Estás usando la última versión del CLI? Actualiza con `npm install -g happy-coder@latest`',
        launchNewSessionInDirectory: 'Iniciar nueva sesión en directorio',
        daemon: 'Daemon',
        status: 'Estado',
        stopDaemon: 'Detener daemon',
        lastKnownPid: 'Último PID conocido',
        lastKnownHttpPort: 'Último puerto HTTP conocido',
        startedAt: 'Iniciado en',
        cliVersion: 'Versión del CLI',
        daemonStateVersion: 'Versión del estado del daemon',
        activeSessions: ({ count }: { count: number }) => `Sesiones activas (${count})`,
        machineGroup: 'Máquina',
        host: 'Host',
        machineId: 'ID de máquina',
        username: 'Nombre de usuario',
        homeDirectory: 'Directorio principal',
        platform: 'Plataforma',
        architecture: 'Arquitectura',
        lastSeen: 'Visto por última vez',
        never: 'Nunca',
        metadataVersion: 'Versión de metadatos',
        untitledSession: 'Sesión sin título',
        back: 'Atrás',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Cambiado al modo ${mode}`,
        unknownEvent: 'Evento desconocido',
        usageLimitUntil: ({ time }: { time: string }) => `Límite de uso alcanzado hasta ${time}`,
        unknownTime: 'tiempo desconocido',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: 'Sí, y no preguntar por esta sesión',
            stopAndExplain: 'Detener, y explicar qué hacer',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Sí, permitir todas las ediciones durante esta sesión',
            yesForTool: 'Sí, no volver a preguntar para esta herramienta',
            noTellClaude: 'No, proporcionar comentarios',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: 'Seleccionar rango de texto',
        title: 'Seleccionar texto',
        noTextProvided: 'No se proporcionó texto',
        textNotFound: 'Texto no encontrado o expirado',
        textCopied: 'Texto copiado al portapapeles',
        failedToCopy: 'Error al copiar el texto al portapapeles',
        noTextToCopy: 'No hay texto disponible para copiar',
    },

    markdown: {
        // Markdown copy functionality
        codeCopied: 'Código copiado',
        copyFailed: 'Error al copiar',
        mermaidRenderFailed: 'Error al renderizar el diagrama mermaid',
    },

    artifacts: {
        // Artifacts feature
        title: 'Artefactos',
        countSingular: '1 artefacto',
        countPlural: ({ count }: { count: number }) => `${count} artefactos`,
        empty: 'No hay artefactos aún',
        emptyDescription: 'Crea tu primer artefacto para comenzar',
        new: 'Nuevo artefacto',
        edit: 'Editar artefacto',
        delete: 'Eliminar',
        updateError: 'No se pudo actualizar el artefacto. Por favor, intenta de nuevo.',
        notFound: 'Artefacto no encontrado',
        discardChanges: '¿Descartar cambios?',
        discardChangesDescription: 'Tienes cambios sin guardar. ¿Estás seguro de que quieres descartarlos?',
        deleteConfirm: '¿Eliminar artefacto?',
        deleteConfirmDescription: 'Esta acción no se puede deshacer',
        titleLabel: 'TÍTULO',
        titlePlaceholder: 'Ingresa un título para tu artefacto',
        bodyLabel: 'CONTENIDO',
        bodyPlaceholder: 'Escribe tu contenido aquí...',
        emptyFieldsError: 'Por favor, ingresa un título o contenido',
        createError: 'No se pudo crear el artefacto. Por favor, intenta de nuevo.',
        save: 'Guardar',
        saving: 'Guardando...',
        loading: 'Cargando artefactos...',
        error: 'Error al cargar el artefacto',
    },

    friends: {
        // Friends feature
        title: 'Amigos',
        manageFriends: 'Administra tus amigos y conexiones',
        searchTitle: 'Buscar amigos',
        pendingRequests: 'Solicitudes de amistad',
        myFriends: 'Mis amigos',
        noFriendsYet: 'Aún no tienes amigos',
        findFriends: 'Buscar amigos',
        remove: 'Eliminar',
        pendingRequest: 'Pendiente',
        sentOn: ({ date }: { date: string }) => `Enviado el ${date}`,
        accept: 'Aceptar',
        reject: 'Rechazar',
        addFriend: 'Agregar amigo',
        alreadyFriends: 'Ya son amigos',
        requestPending: 'Solicitud pendiente',
        searchInstructions: 'Ingresa un nombre de usuario para buscar amigos',
        searchPlaceholder: 'Ingresa nombre de usuario...',
        searching: 'Buscando...',
        userNotFound: 'Usuario no encontrado',
        noUserFound: 'No se encontró ningún usuario con ese nombre',
        checkUsername: 'Por favor, verifica el nombre de usuario e intenta de nuevo',
        howToFind: 'Cómo encontrar amigos',
        findInstructions: 'Busca amigos por su nombre de usuario. Tanto tú como tu amigo deben tener GitHub conectado para enviar solicitudes de amistad.',
        requestSent: '¡Solicitud de amistad enviada!',
        requestAccepted: '¡Solicitud de amistad aceptada!',
        requestRejected: 'Solicitud de amistad rechazada',
        friendRemoved: 'Amigo eliminado',
        confirmRemove: 'Eliminar amigo',
        confirmRemoveMessage: '¿Estás seguro de que quieres eliminar a este amigo?',
        cannotAddYourself: 'No puedes enviarte una solicitud de amistad a ti mismo',
        bothMustHaveGithub: 'Ambos usuarios deben tener GitHub conectado para ser amigos',
        status: {
            none: 'No conectado',
            requested: 'Solicitud enviada',
            pending: 'Solicitud pendiente',
            friend: 'Amigos',
            rejected: 'Rechazada',
        },
        acceptRequest: 'Aceptar solicitud',
        removeFriend: 'Eliminar de amigos',
        removeFriendConfirm: ({ name }: { name: string }) => `¿Estás seguro de que quieres eliminar a ${name} de tus amigos?`,
        requestSentDescription: ({ name }: { name: string }) => `Tu solicitud de amistad ha sido enviada a ${name}`,
        requestFriendship: 'Solicitar amistad',
        cancelRequest: 'Cancelar solicitud de amistad',
        cancelRequestConfirm: ({ name }: { name: string }) => `¿Cancelar tu solicitud de amistad a ${name}?`,
        denyRequest: 'Rechazar solicitud',
        nowFriendsWith: ({ name }: { name: string }) => `Ahora eres amigo de ${name}`,
    },

    usage: {
        // Usage panel strings
        today: 'Hoy',
        last7Days: 'Últimos 7 días',
        last30Days: 'Últimos 30 días',
        totalTokens: 'Tokens totales',
        totalCost: 'Costo total',
        tokens: 'Tokens',
        cost: 'Costo',
        usageOverTime: 'Uso a lo largo del tiempo',
        byModel: 'Por modelo',
        noData: 'No hay datos de uso disponibles',
    },

    feed: {
        // Feed notifications for friend requests and acceptances
        friendRequestFrom: ({ name }: { name: string }) => `${name} te envió una solicitud de amistad`,
        friendRequestGeneric: 'Nueva solicitud de amistad',
        friendAccepted: ({ name }: { name: string }) => `Ahora eres amigo de ${name}`,
        friendAcceptedGeneric: 'Solicitud de amistad aceptada',
    },

    profiles: {
        // Profile management feature
        title: 'Perfiles',
        subtitle: 'Gestionar perfiles de variables de entorno para sesiones',
        noProfile: 'Sin Perfil',
        noProfileDescription: 'Usar configuración de entorno predeterminada',
        defaultModel: 'Modelo Predeterminado',
        addProfile: 'Agregar Perfil',
        profileName: 'Nombre del Perfil',
        enterName: 'Ingrese el nombre del perfil',
        baseURL: 'URL Base',
        authToken: 'Token de Autenticación',
        enterToken: 'Ingrese el token de autenticación',
        model: 'Modelo',
        tmuxSession: 'Sesión Tmux',
        enterTmuxSession: 'Ingrese el nombre de la sesión tmux',
        tmuxTempDir: 'Directorio Temporal de Tmux',
        enterTmuxTempDir: 'Ingrese la ruta del directorio temporal',
        tmuxUpdateEnvironment: 'Actualizar entorno automáticamente',
        nameRequired: 'El nombre del perfil es requerido',
        deleteConfirm: ({ name }: { name: string }) => `¿Estás seguro de que quieres eliminar el perfil "${name}"?`,
        editProfile: 'Editar Perfil',
        addProfileTitle: 'Agregar Nuevo Perfil',
        builtIn: 'Integrado',
        builtInNames: {
            anthropic: 'Anthropic (Default)',
            deepseek: 'DeepSeek (Reasoner)',
            zai: 'Z.AI (GLM-4.6)',
            openai: 'OpenAI (GPT-5)',
            azureOpenai: 'Azure OpenAI',
        },
        groups: {
            favorites: 'Favoritos',
            custom: 'Tus perfiles',
            builtIn: 'Perfiles integrados',
        },
        actions: {
            viewEnvironmentVariables: 'Variables de entorno',
            addToFavorites: 'Agregar a favoritos',
            removeFromFavorites: 'Quitar de favoritos',
            editProfile: 'Editar perfil',
            duplicateProfile: 'Duplicar perfil',
            deleteProfile: 'Eliminar perfil',
        },
        copySuffix: '(Copy)',
        duplicateName: 'Ya existe un perfil con este nombre',
        setupInstructions: {
            title: 'Instrucciones de configuración',
            viewOfficialGuide: 'Ver la guía oficial de configuración',
        },
        defaultSessionType: 'Tipo de sesión predeterminado',
        defaultPermissionMode: {
            title: 'Modo de permisos predeterminado',
            descriptions: {
                default: 'Pedir permisos',
                acceptEdits: 'Aprobar ediciones automáticamente',
                plan: 'Planificar antes de ejecutar',
                bypassPermissions: 'Omitir todos los permisos',
            },
        },
        aiBackend: {
            title: 'Backend de IA',
            selectAtLeastOneError: 'Selecciona al menos un backend de IA.',
            claudeSubtitle: 'CLI de Claude',
            codexSubtitle: 'CLI de Codex',
            geminiSubtitleExperimental: 'CLI de Gemini (experimental)',
        },
        tmux: {
            title: 'Tmux',
            spawnSessionsTitle: 'Iniciar sesiones en Tmux',
            spawnSessionsEnabledSubtitle: 'Las sesiones se abren en nuevas ventanas de tmux.',
            spawnSessionsDisabledSubtitle: 'Las sesiones se abren en una shell normal (sin integración con tmux)',
            sessionNamePlaceholder: 'Vacío = sesión actual/más reciente',
            tempDirPlaceholder: '/tmp (opcional)',
        },
        previewMachine: {
            title: 'Vista previa de la máquina',
            selectMachine: 'Seleccionar máquina',
            resolveSubtitle: 'Resolver variables de entorno de la máquina para este perfil.',
            selectSubtitle: 'Selecciona una máquina para previsualizar los valores resueltos.',
        },
        environmentVariables: {
            title: 'Variables de entorno',
            addVariable: 'Añadir variable',
            namePlaceholder: 'Nombre de variable (p. ej., MY_CUSTOM_VAR)',
            valuePlaceholder: 'Valor (p. ej., mi-valor o ${MY_VAR})',
            validation: {
                nameRequired: 'Introduce un nombre de variable.',
                invalidNameFormat: 'Los nombres de variables deben ser letras mayúsculas, números y guiones bajos, y no pueden empezar por un número.',
                duplicateName: 'Esa variable ya existe.',
            },
            card: {
                valueLabel: 'Valor:',
                fallbackValueLabel: 'Valor de respaldo:',
                valueInputPlaceholder: 'Valor',
                defaultValueInputPlaceholder: 'Valor predeterminado',
                secretNotRetrieved: 'Valor secreto: no se recupera por seguridad',
                overridingDefault: ({ expectedValue }: { expectedValue: string }) =>
                    `Sobrescribiendo el valor documentado: ${expectedValue}`,
                useMachineEnvToggle: 'Usar valor del entorno de la máquina',
                resolvedOnSessionStart: 'Se resuelve al iniciar la sesión en la máquina seleccionada.',
                sourceVariableLabel: 'Variable de origen',
                sourceVariablePlaceholder: 'Nombre de variable de origen (p. ej., Z_AI_MODEL)',
                checkingMachine: ({ machine }: { machine: string }) => `Verificando ${machine}...`,
                emptyOnMachine: ({ machine }: { machine: string }) => `Vacío en ${machine}`,
                emptyOnMachineUsingFallback: ({ machine }: { machine: string }) => `Vacío en ${machine} (usando respaldo)`,
                notFoundOnMachine: ({ machine }: { machine: string }) => `No encontrado en ${machine}`,
                notFoundOnMachineUsingFallback: ({ machine }: { machine: string }) => `No encontrado en ${machine} (usando respaldo)`,
                valueFoundOnMachine: ({ machine }: { machine: string }) => `Valor encontrado en ${machine}`,
                differsFromDocumented: ({ expectedValue }: { expectedValue: string }) =>
                    `Difiere del valor documentado: ${expectedValue}`,
            },
            preview: {
                secretValueHidden: ({ value }: { value: string }) => `${value} - oculto por seguridad`,
                hiddenValue: '***oculto***',
                emptyValue: '(vacío)',
                sessionWillReceive: ({ name, value }: { name: string; value: string }) =>
                    `La sesión recibirá: ${name} = ${value}`,
            },
            previewModal: {
                titleWithProfile: ({ profileName }: { profileName: string }) => `Vars de entorno · ${profileName}`,
                descriptionPrefix: 'Estas variables de entorno se envían al iniciar la sesión. Los valores se resuelven usando el daemon en',
                descriptionFallbackMachine: 'la máquina seleccionada',
                descriptionSuffix: '.',
                emptyMessage: 'No hay variables de entorno configuradas para este perfil.',
                checkingSuffix: '(verificando…)',
                detail: {
                    fixed: 'Fijo',
                    machine: 'Máquina',
                    checking: 'Verificando',
                    fallback: 'Respaldo',
                    missing: 'Falta',
                },
            },
        },
        delete: {
            title: 'Eliminar Perfil',
            message: ({ name }: { name: string }) => `¿Estás seguro de que quieres eliminar "${name}"? Esta acción no se puede deshacer.`,
            confirm: 'Eliminar',
            cancel: 'Cancelar',
        },
    }
} as const;

export type TranslationsEs = typeof es;
