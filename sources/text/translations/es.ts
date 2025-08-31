import type { TranslationStructure } from '../_default';

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
    common: {
        // Simple string constants
        cancel: 'Cancelar',
        authenticate: 'Autenticar',
        save: 'Guardar',
        error: 'Error',
        success: 'Éxito',
        ok: 'OK',
        continue: 'Continuar',
        back: 'Atrás',
        rename: 'Renombrar',
        reset: 'Restablecer',
        logout: 'Cerrar sesión',
        yes: 'Sí',
        no: 'No',
        version: 'Versión',
        copied: 'Copiado',
        scanning: 'Escaneando...',
        urlPlaceholder: 'https://ejemplo.com',
        home: 'Inicio',
        message: 'Mensaje',
        files: 'Archivos',
        fileViewer: 'Visor de archivos',
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
        enterSecretKey: 'Por favor ingrese una clave secreta',
        invalidSecretKey: 'Clave secreta inválida. Verifique e intente nuevamente.',
        enterUrlManually: 'Ingresar URL manualmente',
    },

    settings: {
        title: 'Configuración',
        connectedAccounts: 'Cuentas conectadas',
        github: 'GitHub',
        machines: 'Máquinas',
        features: 'Características',
        account: 'Cuenta',
        accountSubtitle: 'Gestionar detalles de su cuenta',
        appearance: 'Apariencia',
        appearanceSubtitle: 'Personalizar la apariencia de la aplicación',
        voiceAssistant: 'Asistente de voz',
        voiceAssistantSubtitle: 'Configurar preferencias de interacción por voz',
        featuresTitle: 'Características',
        featuresSubtitle: 'Habilitar o deshabilitar funciones de la aplicación',
        developer: 'Desarrollador',
        developerTools: 'Herramientas de desarrollador',
        about: 'Acerca de',
        aboutFooter: 'Happy Coder es un cliente móvil para Claude Code. Está completamente cifrado de extremo a extremo y su cuenta se almacena únicamente en su dispositivo. No está afiliado con Anthropic.',
        whatsNew: 'Novedades',
        whatsNewSubtitle: 'Ver las últimas actualizaciones y mejoras',
        reportIssue: 'Reportar un problema',
        privacyPolicy: 'Política de privacidad',
        termsOfService: 'Términos de servicio',
        eula: 'EULA',
        supportUs: 'Apóyanos',
        supportUsSubtitlePro: '¡Gracias por su apoyo!',
        supportUsSubtitle: 'Apoyar el desarrollo del proyecto',
        scanQrCodeToAuthenticate: 'Escanee el código QR para autenticarse',
        githubConnected: ({ login }: { login: string }) => `Conectado como @${login}`,
        connectGithubAccount: 'Conectar su cuenta de GitHub',

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
        themeDescription: 'Elija su esquema de colores preferido',
        themeOptions: {
            adaptive: 'Adaptativo',
            light: 'Claro', 
            dark: 'Oscuro',
        },
        themeDescriptions: {
            adaptive: 'Coincidir con configuración del sistema',
            light: 'Usar siempre tema claro',
            dark: 'Usar siempre tema oscuro',
        },
        display: 'Pantalla',
        displayDescription: 'Controlar diseño y espaciado',
        inlineToolCalls: 'Llamadas a herramientas en línea',
        inlineToolCallsDescription: 'Mostrar llamadas a herramientas directamente en mensajes de chat',
        expandTodoLists: 'Expandir listas de tareas',
        expandTodoListsDescription: 'Mostrar todas las tareas en lugar de solo cambios',
        showLineNumbersInDiffs: 'Mostrar números de línea en diferencias',
        showLineNumbersInDiffsDescription: 'Mostrar números de línea en diferencias de código',
        showLineNumbersInToolViews: 'Mostrar números de línea en vistas de herramientas',
        showLineNumbersInToolViewsDescription: 'Mostrar números de línea en diferencias de vistas de herramientas',
        alwaysShowContextSize: 'Mostrar siempre tamaño del contexto',
        alwaysShowContextSizeDescription: 'Mostrar uso del contexto incluso cuando no esté cerca del límite',
        avatarStyle: 'Estilo de avatar',
        avatarStyleDescription: 'Elegir apariencia del avatar de sesión',
        avatarOptions: {
            pixelated: 'Pixelado',
            gradient: 'Gradiente',
            brutalist: 'Brutalista',
        },
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
        commandPalette: 'Paleta de comandos',
        commandPaletteEnabled: 'Presione ⌘K para abrir',
        commandPaletteDisabled: 'Acceso rápido a comandos deshabilitado',
    },

    errors: {
        networkError: 'Ocurrió un error de red',
        serverError: 'Ocurrió un error del servidor',
        unknownError: 'Ocurrió un error desconocido',
        connectionTimeout: 'La conexión expiró',
        authenticationFailed: 'Falló la autenticación',
        permissionDenied: 'Permiso denegado',
        fileNotFound: 'Archivo no encontrado',
        invalidFormat: 'Formato inválido',
        operationFailed: 'Operación falló',
        tryAgain: 'Por favor intente nuevamente',
        contactSupport: 'Contacte al soporte si el problema persiste',
        sessionNotFound: 'Sesión no encontrada',
        voiceSessionFailed: 'Falló al iniciar sesión de voz',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} debe estar entre ${min} y ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Reintentar en ${seconds} ${seconds === 1 ? 'segundo' : 'segundos'}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Error ${code})`,
    },

    newSession: {
        // Used by new-session screen and launch flows
        title: 'Iniciar nueva sesión',
        noMachinesFound: 'No se encontraron máquinas. Inicie una sesión de Happy en su computadora primero.',
        allMachinesOffline: 'Todas las máquinas están desconectadas',
        machineOfflineHelp: {
            computerOnline: '• ¿Está su computadora en línea?',
            daemonRunning: '• ¿Está ejecutándose el daemon de Happy? Verifique con `happy daemon status`'
        },
        machineDetails: 'Ver detalles de la máquina →',
        sessionStarted: 'Sesión iniciada',
        sessionStartedMessage: 'La sesión fue iniciada pero puede tardar un momento en aparecer.',
        sessionSpawningFailed: 'Falló la creación de sesión - no se devolvió ID de sesión.',
        failedToStart: 'Falló al iniciar sesión. Asegúrese de que el daemon esté ejecutándose en la máquina objetivo.',
        sessionTimeout: 'El inicio de sesión expiró. La máquina puede ser lenta o el daemon puede no estar respondiendo.',
        notConnectedToServer: 'No conectado al servidor. Verifique su conexión a internet.',
        startingSession: 'Iniciando sesión...',
        startNewSessionInFolder: 'Iniciar nueva sesión en esta carpeta'
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
        enterServerUrl: 'Por favor ingrese una URL de servidor',
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
        advancedFeatureFooter: 'Esta es una característica avanzada. Solo cambie el servidor si sabe lo que está haciendo. Necesitará cerrar sesión e iniciarla nuevamente después de cambiar servidores.'
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Terminar sesión',
        killSessionConfirm: '¿Está seguro de que quiere terminar esta sesión?',
        happySessionIdCopied: 'ID de sesión de Happy copiado al portapapeles',
        failedToCopySessionId: 'Falló al copiar ID de sesión de Happy',
        happySessionId: 'ID de sesión de Happy',
        claudeCodeSessionId: 'ID de sesión de Claude Code',
        claudeCodeSessionIdCopied: 'ID de sesión de Claude Code copiado al portapapeles',
        failedToCopyClaudeCodeSessionId: 'Falló al copiar ID de sesión de Claude Code',
        metadataCopied: 'Metadatos copiados al portapapeles',
        failedToCopyMetadata: 'Falló al copiar metadatos',
        failedToKillSession: 'Falló al terminar sesión',
        connectionStatus: 'Estado de conexión',
        created: 'Creado',
        lastUpdated: 'Última actualización',
        sequence: 'Secuencia',
        quickActions: 'Acciones rápidas',
        viewMachine: 'Ver máquina',
        viewMachineSubtitle: 'Ver detalles de máquina y sesiones',
        killSessionSubtitle: 'Terminar inmediatamente la sesión',
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
        model: {
            title: 'MODELO',
            default: 'Usar configuración del CLI',
            adaptiveUsage: 'Opus hasta 50% de uso, luego Sonnet',
            sonnet: 'Sonnet',
            opus: 'Opus',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% restante`,
        },
        suggestion: {
            fileLabel: 'ARCHIVO',
            folderLabel: 'CARPETA',
        }
    },

    machineLauncher: {
        showLess: 'Mostrar menos',
        showAll: ({ count }: { count: number }) => `Mostrar todos (${count} rutas)`,
        enterCustomPath: 'Ingresar ruta personalizada',
        offlineUnableToSpawn: 'No se puede crear nueva sesión, desconectado',
    },

    sidebar: {
        sessionsTitle: 'Sesiones',
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
        languageDescription: 'Elija su idioma preferido para las interacciones con el asistente de voz. Esta configuración se sincroniza en todos sus dispositivos.',
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
        backupDescription: 'Su clave secreta es la única forma de recuperar su cuenta. Guárdela en un lugar seguro como un administrador de contraseñas.',
        secretKey: 'Clave secreta',
        tapToReveal: 'Toque para revelar',
        tapToHide: 'Toque para ocultar',
        secretKeyLabel: 'CLAVE SECRETA (TOQUE PARA COPIAR)',
        secretKeyCopied: 'Clave secreta copiada al portapapeles. ¡Guárdela en un lugar seguro!',
        secretKeyCopyFailed: 'Falló al copiar la clave secreta',
        privacy: 'Privacidad',
        privacyDescription: 'Ayude a mejorar la aplicación compartiendo datos de uso anónimos. No se recopila información personal.',
        analytics: 'Analíticas',
        analyticsDisabled: 'No se comparten datos',
        analyticsEnabled: 'Se comparten datos de uso anónimos',
        dangerZone: 'Zona peligrosa',
        logout: 'Cerrar sesión',
        logoutSubtitle: 'Cerrar sesión y limpiar datos locales',
        logoutConfirm: '¿Está seguro de que quiere cerrar sesión? ¡Asegúrese de haber respaldado su clave secreta!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Idioma',
        description: 'Elija su idioma preferido para la interfaz de la aplicación. Esto se sincronizará en todos sus dispositivos.',
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
        pasteAuthUrl: 'Pegue la URL de autenticación de su terminal',
    },

    updateBanner: {
        updateAvailable: 'Actualización disponible',
        pressToApply: 'Presione para aplicar la actualización',
        whatsNew: 'Novedades',
        seeLatest: 'Ver las últimas actualizaciones y mejoras',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Versión ${version}`,
        noEntriesAvailable: 'No hay entradas de registro de cambios disponibles.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Se requiere navegador web',
        webBrowserRequiredDescription: 'Los enlaces de conexión de terminal solo pueden abrirse en un navegador web por razones de seguridad. Use el escáner de código QR o abra este enlace en una computadora.',
        processingConnection: 'Procesando conexión...',
        invalidConnectionLink: 'Enlace de conexión inválido',
        invalidConnectionLinkDescription: 'El enlace de conexión falta o es inválido. Verifique la URL e intente nuevamente.',
        connectTerminal: 'Conectar terminal',
        terminalRequestDescription: 'Un terminal está solicitando conectarse a su cuenta de Happy Coder. Esto permitirá al terminal enviar y recibir mensajes de forma segura.',
        connectionDetails: 'Detalles de conexión',
        publicKey: 'Clave pública',
        encryption: 'Cifrado',
        endToEndEncrypted: 'Cifrado de extremo a extremo',
        acceptConnection: 'Aceptar conexión',
        connecting: 'Conectando...',
        reject: 'Rechazar',
        security: 'Seguridad',
        securityFooter: 'Este enlace de conexión fue procesado de forma segura en su navegador y nunca fue enviado a ningún servidor. Sus datos privados permanecerán seguros y solo usted puede descifrar los mensajes.',
        securityFooterDevice: 'Esta conexión fue procesada de forma segura en su dispositivo y nunca fue enviada a ningún servidor. Sus datos privados permanecerán seguros y solo usted puede descifrar los mensajes.',
        clientSideProcessing: 'Procesamiento del lado del cliente',
        linkProcessedLocally: 'Enlace procesado localmente en el navegador',
        linkProcessedOnDevice: 'Enlace procesado localmente en el dispositivo',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Autenticar terminal',
        pasteUrlFromTerminal: 'Pegue la URL de autenticación de su terminal',
        deviceLinkedSuccessfully: 'Dispositivo vinculado exitosamente',
        terminalConnectedSuccessfully: 'Terminal conectado exitosamente',
        invalidAuthUrl: 'URL de autenticación inválida',
        developerMode: 'Modo desarrollador',
        developerModeEnabled: 'Modo desarrollador habilitado',
        developerModeDisabled: 'Modo desarrollador deshabilitado',
        disconnectGithub: 'Desconectar GitHub',
        disconnectGithubConfirm: '¿Está seguro de que quiere desconectar su cuenta de GitHub?',
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
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Cliente móvil de Claude Code',
        subtitle: 'Cifrado de extremo a extremo y su cuenta se almacena únicamente en su dispositivo.',
        createAccount: 'Crear cuenta',
        linkOrRestoreAccount: 'Vincular o restaurar cuenta',
        loginWithMobileApp: 'Iniciar sesión con aplicación móvil',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: '¿Disfrutando la aplicación?',
        feedbackPrompt: '¡Nos encantaría escuchar sus comentarios!',
        yesILoveIt: '¡Sí, me encanta!',
        notReally: 'No realmente'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copiado al portapapeles`
    },

    machine: {
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
    }
} as const;

export type TranslationsEs = typeof es;