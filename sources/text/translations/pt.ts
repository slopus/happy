import type { TranslationStructure } from '../_default';

/**
 * Portuguese plural helper function
 * Portuguese (Brazilian) has 2 plural forms: singular, plural
 * @param options - Object containing count, singular, and plural forms
 * @returns The appropriate form based on Portuguese plural rules
 */
function plural({ count, singular, plural }: { count: number; singular: string; plural: string }): string {
    return count === 1 ? singular : plural;
}

/**
 * Portuguese (Brazilian) translations for the Happy app
 * Must match the exact structure of the English translations
 */
export const pt: TranslationStructure = {
    common: {
        // Simple string constants
        cancel: 'Cancelar',
        authenticate: 'Autenticar',
        save: 'Salvar',
        error: 'Erro',
        success: 'Sucesso',
        ok: 'OK',
        continue: 'Continuar',
        back: 'Voltar',
        create: 'Criar',
        rename: 'Renomear',
        reset: 'Redefinir',
        logout: 'Sair',
        yes: 'Sim',
        no: 'Não',
        discard: 'Descartar',
        version: 'Versão',
        copied: 'Copiado',
        scanning: 'Escaneando...',
        urlPlaceholder: 'https://exemplo.com',
        home: 'Início',
        message: 'Mensagem',
        files: 'Arquivos',
        fileViewer: 'Visualizador de arquivos',
        loading: 'Carregando...',
        retry: 'Tentar novamente',
    },

    status: {
        connected: 'conectado',
        connecting: 'conectando',
        disconnected: 'desconectado',
        error: 'erro',
        online: 'online',
        offline: 'offline',
        lastSeen: ({ time }: { time: string }) => `visto por último ${time}`,
        permissionRequired: 'permissão necessária',
        activeNow: 'Ativo agora',
        unknown: 'desconhecido',
    },

    time: {
        justNow: 'agora mesmo',
        minutesAgo: ({ count }: { count: number }) => `há ${count} minuto${count !== 1 ? 's' : ''}`,
        hoursAgo: ({ count }: { count: number }) => `há ${count} hora${count !== 1 ? 's' : ''}`,
    },

    connect: {
        restoreAccount: 'Restaurar conta',
        enterSecretKey: 'Por favor, insira uma chave secreta',
        invalidSecretKey: 'Chave secreta inválida. Verifique e tente novamente.',
        enterUrlManually: 'Inserir URL manualmente',
    },

    settings: {
        title: 'Configurações',
        connectedAccounts: 'Contas conectadas',
        connectAccount: 'Conectar conta',
        github: 'GitHub',
        machines: 'Máquinas',
        features: 'Recursos',
        account: 'Conta',
        accountSubtitle: 'Gerencie os detalhes da sua conta',
        appearance: 'Aparência',
        appearanceSubtitle: 'Personalize a aparência do aplicativo',
        voiceAssistant: 'Assistente de voz',
        voiceAssistantSubtitle: 'Configure as preferências de interação por voz',
        featuresTitle: 'Recursos',
        featuresSubtitle: 'Ativar ou desativar recursos do aplicativo',
        developer: 'Desenvolvedor',
        developerTools: 'Ferramentas de desenvolvedor',
        about: 'Sobre',
        aboutFooter: 'Happy Coder é um cliente móvel para Codex e Claude Code. É totalmente criptografado ponta a ponta e sua conta é armazenada apenas no seu dispositivo. Não é afiliado à Anthropic.',
        whatsNew: 'Novidades',
        whatsNewSubtitle: 'Veja as atualizações e melhorias mais recentes',
        reportIssue: 'Relatar um problema',
        privacyPolicy: 'Política de privacidade',
        termsOfService: 'Termos de serviço',
        eula: 'EULA',
        supportUs: 'Nos apoie',
        supportUsSubtitlePro: 'Obrigado pelo seu apoio!',
        supportUsSubtitle: 'Apoie o desenvolvimento do projeto',
        scanQrCodeToAuthenticate: 'Escaneie o código QR para autenticar',
        githubConnected: ({ login }: { login: string }) => `Conectado como @${login}`,
        connectGithubAccount: 'Conecte sua conta GitHub',
        claudeAuthSuccess: 'Conectado ao Claude com sucesso',
        exchangingTokens: 'Trocando tokens...',

        // Dynamic settings messages
        accountConnected: ({ service }: { service: string }) => `Conta ${service} conectada`,
        machineStatus: ({ name, status }: { name: string; status: 'online' | 'offline' }) =>
            `${name} está ${status === 'online' ? 'online' : 'offline'}`,
        featureToggled: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
            `${feature} ${enabled ? 'ativado' : 'desativado'}`,
    },

    settingsAppearance: {
        // Appearance settings screen
        theme: 'Tema',
        themeDescription: 'Escolha seu esquema de cores preferido',
        themeOptions: {
            adaptive: 'Adaptativo',
            light: 'Claro', 
            dark: 'Escuro',
        },
        themeDescriptions: {
            adaptive: 'Usar configurações do sistema',
            light: 'Sempre usar tema claro',
            dark: 'Sempre usar tema escuro',
        },
        display: 'Exibição',
        displayDescription: 'Controle layout e espaçamento',
        inlineToolCalls: 'Chamadas de ferramentas inline',
        inlineToolCallsDescription: 'Exibir chamadas de ferramentas diretamente nas mensagens do chat',
        expandTodoLists: 'Expandir listas de tarefas',
        expandTodoListsDescription: 'Mostrar todas as tarefas em vez de apenas as mudanças',
        showLineNumbersInDiffs: 'Mostrar números de linha nos diffs',
        showLineNumbersInDiffsDescription: 'Exibir números de linha nos diffs de código',
        showLineNumbersInToolViews: 'Mostrar números de linha nas visualizações de ferramentas',
        showLineNumbersInToolViewsDescription: 'Exibir números de linha nos diffs das visualizações de ferramentas',
        alwaysShowContextSize: 'Sempre mostrar tamanho do contexto',
        alwaysShowContextSizeDescription: 'Exibir uso do contexto mesmo quando não estiver próximo do limite',
        avatarStyle: 'Estilo do avatar',
        avatarStyleDescription: 'Escolha a aparência do avatar da sessão',
        avatarOptions: {
            pixelated: 'Pixelizado',
            gradient: 'Gradiente',
            brutalist: 'Brutalista',
        },
        showFlavorIcons: 'Mostrar ícones de provedores de IA',
        showFlavorIconsDescription: 'Exibir ícones do provedor de IA nos avatares de sessão',
        compactSessionView: 'Visualização compacta de sessões',
        compactSessionViewDescription: 'Mostrar sessões ativas em um layout mais compacto',
    },

    settingsFeatures: {
        // Features settings screen
        experiments: 'Experimentos',
        experimentsDescription: 'Ative recursos experimentais que ainda estão em desenvolvimento. Estes recursos podem ser instáveis ou mudar sem aviso.',
        experimentalFeatures: 'Recursos experimentais',
        experimentalFeaturesEnabled: 'Recursos experimentais ativados',
        experimentalFeaturesDisabled: 'Usando apenas recursos estáveis',
        webFeatures: 'Recursos web',
        webFeaturesDescription: 'Recursos disponíveis apenas na versão web do aplicativo.',
        commandPalette: 'Paleta de comandos',
        commandPaletteEnabled: 'Pressione ⌘K para abrir',
        commandPaletteDisabled: 'Acesso rápido a comandos desativado',
        markdownCopyV2: 'Markdown Copy v2',
        markdownCopyV2Subtitle: 'Pressione e segure para abrir modal de cópia',
    },

    errors: {
        networkError: 'Ocorreu um erro de rede',
        serverError: 'Ocorreu um erro do servidor',
        unknownError: 'Ocorreu um erro desconhecido',
        connectionTimeout: 'Tempo limite da conexão esgotado',
        authenticationFailed: 'Falha na autenticação',
        permissionDenied: 'Permissão negada',
        fileNotFound: 'Arquivo não encontrado',
        invalidFormat: 'Formato inválido',
        operationFailed: 'Operação falhou',
        tryAgain: 'Por favor, tente novamente',
        contactSupport: 'Entre em contato com o suporte se o problema persistir',
        sessionNotFound: 'Sessão não encontrada',
        voiceSessionFailed: 'Falha ao iniciar sessão de voz',
        oauthInitializationFailed: 'Falha ao inicializar o fluxo OAuth',
        tokenStorageFailed: 'Falha ao armazenar tokens de autenticação',
        oauthStateMismatch: 'Falha na validação de segurança. Por favor, tente novamente',
        tokenExchangeFailed: 'Falha ao trocar código de autorização',
        oauthAuthorizationDenied: 'A autorização foi negada',
        webViewLoadFailed: 'Falha ao carregar a página de autenticação',

        // Error functions with context
        fieldError: ({ field, reason }: { field: string; reason: string }) =>
            `${field}: ${reason}`,
        validationError: ({ field, min, max }: { field: string; min: number; max: number }) =>
            `${field} deve estar entre ${min} e ${max}`,
        retryIn: ({ seconds }: { seconds: number }) =>
            `Tentar novamente em ${seconds} ${seconds === 1 ? 'segundo' : 'segundos'}`,
        errorWithCode: ({ message, code }: { message: string; code: number | string }) =>
            `${message} (Erro ${code})`,
        disconnectServiceFailed: ({ service }: { service: string }) => 
            `Falha ao desconectar ${service}`,
        connectServiceFailed: ({ service }: { service: string }) =>
            `Falha ao conectar ${service}. Por favor, tente novamente.`,
    },

    newSession: {
        // Used by new-session screen and launch flows
        title: 'Iniciar nova sessão',
        noMachinesFound: 'Nenhuma máquina encontrada. Inicie uma sessão Happy no seu computador primeiro.',
        allMachinesOffline: 'Todas as máquinas estão offline',
        machineDetails: 'Ver detalhes da máquina →',
        noMachineSelected: 'Nenhuma máquina selecionada',
        noPathSelected: 'Nenhum caminho selecionado',
        directoryDoesNotExist: 'Diretório não encontrado',
        createDirectoryConfirm: ({ directory }: { directory: string }) => `O diretório ${directory} não existe. Deseja criá-lo?`,
        sessionStarted: 'Sessão iniciada',
        sessionStartedMessage: 'A sessão foi iniciada com sucesso.',
        sessionSpawningFailed: 'Falha ao criar sessão - nenhum ID de sessão foi retornado.',
        failedToStart: 'Falha ao iniciar sessão. Certifique-se de que o daemon está rodando na máquina de destino.',
        sessionTimeout: 'Tempo limite de inicialização da sessão esgotado. A máquina pode estar lenta ou o daemon pode não estar respondendo.',
        notConnectedToServer: 'Não conectado ao servidor. Verifique sua conexão com a internet.',
        startingSession: 'Iniciando sessão...',
        startNewSessionInFolder: 'Nova sessão aqui'
    },

    sessionHistory: {
        // Used by session history screen
        title: 'Histórico de sessões',
        empty: 'Nenhuma sessão encontrada',
        today: 'Hoje',
        yesterday: 'Ontem',
        daysAgo: ({ count }: { count: number }) => `há ${count} ${count === 1 ? 'dia' : 'dias'}`,
        viewAll: 'Ver todas as sessões',
    },

    session: {
        inputPlaceholder: 'Digite uma mensagem ...',
    },

    commandPalette: {
        placeholder: 'Digite um comando ou pesquise...',
    },

    server: {
        // Used by Server Configuration screen (app/(app)/server.tsx)
        serverConfiguration: 'Configuração do servidor',
        enterServerUrl: 'Por favor, insira uma URL do servidor',
        notValidHappyServer: 'Não é um servidor Happy válido',
        changeServer: 'Alterar servidor',
        continueWithServer: 'Continuar com este servidor?',
        resetToDefault: 'Redefinir para padrão',
        resetServerDefault: 'Redefinir servidor para padrão?',
        validating: 'Validando...',
        validatingServer: 'Validando servidor...',
        serverReturnedError: 'O servidor retornou um erro',
        failedToConnectToServer: 'Falha ao conectar com o servidor',
        currentlyUsingCustomServer: 'Atualmente usando servidor personalizado',
        customServerUrlLabel: 'URL do servidor personalizado',
        advancedFeatureFooter: 'Este é um recurso avançado. Altere o servidor apenas se souber o que está fazendo. Você precisará sair e entrar novamente após alterar servidores.'
    },

    sessionInfo: {
        // Used by Session Info screen (app/(app)/session/[id]/info.tsx)
        killSession: 'Encerrar sessão',
        killSessionConfirm: 'Tem certeza de que deseja encerrar esta sessão?',
        archiveSession: 'Arquivar sessão',
        archiveSessionConfirm: 'Tem certeza de que deseja arquivar esta sessão?',
        happySessionIdCopied: 'ID da sessão Happy copiado para a área de transferência',
        failedToCopySessionId: 'Falha ao copiar ID da sessão Happy',
        happySessionId: 'ID da sessão Happy',
        claudeCodeSessionId: 'ID da sessão Claude Code',
        claudeCodeSessionIdCopied: 'ID da sessão Claude Code copiado para a área de transferência',
        aiProvider: 'Provedor de IA',
        failedToCopyClaudeCodeSessionId: 'Falha ao copiar ID da sessão Claude Code',
        metadataCopied: 'Metadados copiados para a área de transferência',
        failedToCopyMetadata: 'Falha ao copiar metadados',
        failedToKillSession: 'Falha ao encerrar sessão',
        failedToArchiveSession: 'Falha ao arquivar sessão',
        connectionStatus: 'Status da conexão',
        created: 'Criado',
        lastUpdated: 'Última atualização',
        sequence: 'Sequência',
        quickActions: 'Ações rápidas',
        viewMachine: 'Ver máquina',
        viewMachineSubtitle: 'Ver detalhes da máquina e sessões',
        killSessionSubtitle: 'Encerrar imediatamente a sessão',
        archiveSessionSubtitle: 'Arquivar esta sessão e pará-la',
        metadata: 'Metadados',
        host: 'Host',
        path: 'Caminho',
        operatingSystem: 'Sistema operacional',
        processId: 'ID do processo',
        happyHome: 'Diretório Happy',
        copyMetadata: 'Copiar metadados',
        agentState: 'Estado do agente',
        controlledByUser: 'Controlado pelo usuário',
        pendingRequests: 'Solicitações pendentes',
        activity: 'Atividade',
        thinking: 'Pensando',
        thinkingSince: 'Pensando desde',
        cliVersion: 'Versão do CLI',
        cliVersionOutdated: 'Atualização do CLI necessária',
        cliVersionOutdatedMessage: ({ currentVersion, requiredVersion }: { currentVersion: string; requiredVersion: string }) =>
            `Versão ${currentVersion} instalada. Atualize para ${requiredVersion} ou posterior`,
        updateCliInstructions: 'Por favor execute npm install -g happy-coder@latest',
        
    },

    components: {
        emptyMainScreen: {
            // Used by EmptyMainScreen component
            readyToCode: 'Pronto para programar?',
            installCli: 'Instale o Happy CLI',
            runIt: 'Execute',
            scanQrCode: 'Escaneie o código QR',
            openCamera: 'Abrir câmera',
        },
    },

    agentInput: {
        permissionMode: {
            title: 'MODO DE PERMISSÃO',
            default: 'Padrão',
            acceptEdits: 'Aceitar edições',
            plan: 'Modo de planejamento',
            bypassPermissions: 'Modo Yolo',
            badgeAcceptAllEdits: 'Aceitar todas as edições',
            badgeBypassAllPermissions: 'Ignorar todas as permissões',
            badgePlanMode: 'Modo de planejamento',
        },
        agent: {
            claude: 'Claude',
            codex: 'Codex',
        },
        model: {
            title: 'MODELO',
            default: 'Usar configurações do CLI',
            adaptiveUsage: 'Opus até 50% de uso, depois Sonnet',
            sonnet: 'Sonnet',
            opus: 'Opus',
        },
        codexPermissionMode: {
            title: 'MODO DE PERMISSÃO CODEX',
            default: 'Configurações do CLI',
            readOnly: 'Read Only Mode',
            safeYolo: 'Safe YOLO',
            yolo: 'YOLO',
            badgeReadOnly: 'Read Only Mode',
            badgeSafeYolo: 'Safe YOLO',
            badgeYolo: 'YOLO',
        },
        codexModel: {
            title: 'MODELO CODEX',
            gpt5Minimal: 'GPT-5 Mínimo',
            gpt5Low: 'GPT-5 Baixo',
            gpt5Medium: 'GPT-5 Médio',
            gpt5High: 'GPT-5 Alto',
        },
        context: {
            remaining: ({ percent }: { percent: number }) => `${percent}% restante`,
        },
        suggestion: {
            fileLabel: 'ARQUIVO',
            folderLabel: 'PASTA',
        },
        noMachinesAvailable: 'Sem máquinas',
    },

    machineLauncher: {
        showLess: 'Mostrar menos',
        showAll: ({ count }: { count: number }) => `Mostrar todos (${count} caminhos)`,
        enterCustomPath: 'Inserir caminho personalizado',
        offlineUnableToSpawn: 'Não é possível criar nova sessão, você está offline',
    },

    sidebar: {
        sessionsTitle: 'Sessões',
    },

    toolView: {
        input: 'Entrada',
        output: 'Saída',
    },

    tools: {
        fullView: {
            description: 'Descrição',
            inputParams: 'Parâmetros de entrada',
            output: 'Saída',
            error: 'Erro',
            completed: 'Ferramenta concluída com sucesso',
            noOutput: 'Nenhuma saída foi produzida',
            running: 'Ferramenta está executando...',
            rawJsonDevMode: 'JSON bruto (modo desenvolvedor)',
        },
        taskView: {
            initializing: 'Inicializando agente...',
            moreTools: ({ count }: { count: number }) => `+${count} mais ${plural({ count, singular: 'ferramenta', plural: 'ferramentas' })}`,
        },
        multiEdit: {
            editNumber: ({ index, total }: { index: number; total: number }) => `Edição ${index} de ${total}`,
            replaceAll: 'Substituir tudo',
        },
        names: {
            task: 'Tarefa',
            terminal: 'Terminal',
            searchFiles: 'Buscar arquivos',
            search: 'Buscar',
            searchContent: 'Buscar conteúdo',
            listFiles: 'Listar arquivos',
            planProposal: 'Proposta de plano',
            readFile: 'Ler arquivo',
            editFile: 'Editar arquivo',
            writeFile: 'Escrever arquivo',
            fetchUrl: 'Buscar URL',
            readNotebook: 'Ler notebook',
            editNotebook: 'Editar notebook',
            todoList: 'Lista de tarefas',
            webSearch: 'Busca web',
            reasoning: 'Raciocínio',
            applyChanges: 'Atualizar arquivo',
            viewDiff: 'Alterações do arquivo atual',
        },
        desc: {
            terminalCmd: ({ cmd }: { cmd: string }) => `Terminal(cmd: ${cmd})`,
            searchPattern: ({ pattern }: { pattern: string }) => `Buscar(padrão: ${pattern})`,
            searchPath: ({ basename }: { basename: string }) => `Buscar(caminho: ${basename})`,
            fetchUrlHost: ({ host }: { host: string }) => `Buscar URL(url: ${host})`,
            editNotebookMode: ({ path, mode }: { path: string; mode: string }) => `Editar notebook(arquivo: ${path}, modo: ${mode})`,
            todoListCount: ({ count }: { count: number }) => `Lista de tarefas(quantidade: ${count})`,
            webSearchQuery: ({ query }: { query: string }) => `Busca web(consulta: ${query})`,
            grepPattern: ({ pattern }: { pattern: string }) => `grep(padrão: ${pattern})`,
            multiEditEdits: ({ path, count }: { path: string; count: number }) => `${path} (${count} edições)`,
            readingFile: ({ file }: { file: string }) => `Lendo ${file}`,
            writingFile: ({ file }: { file: string }) => `Escrevendo ${file}`,
            modifyingFile: ({ file }: { file: string }) => `Modificando ${file}`,
            modifyingFiles: ({ count }: { count: number }) => `Modificando ${count} arquivos`,
            modifyingMultipleFiles: ({ file, count }: { file: string; count: number }) => `${file} e ${count} mais`,
            showingDiff: 'Mostrando alterações',
        }
    },

    files: {
        searchPlaceholder: 'Buscar arquivos...',
        detachedHead: 'HEAD desanexado',
        summary: ({ staged, unstaged }: { staged: number; unstaged: number }) => `${staged} preparados • ${unstaged} não preparados`,
        notRepo: 'Não é um repositório git',
        notUnderGit: 'Este diretório não está sob controle de versão git',
        searching: 'Buscando arquivos...',
        noFilesFound: 'Nenhum arquivo encontrado',
        noFilesInProject: 'Nenhum arquivo no projeto',
        tryDifferentTerm: 'Tente um termo de busca diferente',
        searchResults: ({ count }: { count: number }) => `Resultados da busca (${count})`,
        projectRoot: 'Raiz do projeto',
        stagedChanges: ({ count }: { count: number }) => `Alterações preparadas (${count})`,
        unstagedChanges: ({ count }: { count: number }) => `Alterações não preparadas (${count})`,
        // File viewer strings
        loadingFile: ({ fileName }: { fileName: string }) => `Carregando ${fileName}...`,
        binaryFile: 'Arquivo binário',
        cannotDisplayBinary: 'Não é possível exibir o conteúdo do arquivo binário',
        diff: 'Diff',
        file: 'Arquivo',
        fileEmpty: 'Arquivo está vazio',
        noChanges: 'Nenhuma alteração para exibir',
    },

    settingsVoice: {
        // Voice settings screen
        languageTitle: 'Idioma',
        languageDescription: 'Escolha seu idioma preferido para interações com o assistente de voz. Esta configuração sincroniza em todos os seus dispositivos.',
        preferredLanguage: 'Idioma preferido',
        preferredLanguageSubtitle: 'Idioma usado para respostas do assistente de voz',
        language: {
            searchPlaceholder: 'Buscar idiomas...',
            title: 'Idiomas',
            footer: ({ count }: { count: number }) => `${count} ${plural({ count, singular: 'idioma', plural: 'idiomas' })} disponíveis`,
            autoDetect: 'Detectar automaticamente',
        }
    },

    settingsAccount: {
        // Account settings screen
        accountInformation: 'Informações da conta',
        status: 'Status',
        statusActive: 'Ativo',
        statusNotAuthenticated: 'Não autenticado',
        anonymousId: 'ID anônimo',
        publicId: 'ID público',
        notAvailable: 'Não disponível',
        linkNewDevice: 'Vincular novo dispositivo',
        linkNewDeviceSubtitle: 'Escanear código QR para vincular dispositivo',
        profile: 'Perfil',
        name: 'Nome',
        github: 'GitHub',
        tapToDisconnect: 'Toque para desconectar',
        server: 'Servidor',
        backup: 'Backup',
        backupDescription: 'Sua chave secreta é a única forma de recuperar sua conta. Salve-a em um local seguro como um gerenciador de senhas.',
        secretKey: 'Chave secreta',
        tapToReveal: 'Toque para revelar',
        tapToHide: 'Toque para ocultar',
        secretKeyLabel: 'CHAVE SECRETA (TOQUE PARA COPIAR)',
        secretKeyCopied: 'Chave secreta copiada para a área de transferência. Guarde-a em um local seguro!',
        secretKeyCopyFailed: 'Falha ao copiar chave secreta',
        privacy: 'Privacidade',
        privacyDescription: 'Ajude a melhorar o aplicativo compartilhando dados de uso anônimos. Nenhuma informação pessoal é coletada.',
        analytics: 'Análises',
        analyticsDisabled: 'Nenhum dado é compartilhado',
        analyticsEnabled: 'Dados de uso anônimos são compartilhados',
        dangerZone: 'Zona perigosa',
        logout: 'Sair',
        logoutSubtitle: 'Sair e limpar dados locais',
        logoutConfirm: 'Tem certeza de que quer sair? Certifique-se de ter feito backup da sua chave secreta!',
    },

    settingsLanguage: {
        // Language settings screen
        title: 'Idioma',
        description: 'Escolher o idioma preferido para a interface do aplicativo. Isso vai ser sincronizado em todos os seus dispositivos.',
        currentLanguage: 'Idioma atual',
        automatic: 'Automático',
        automaticSubtitle: 'Detectar das configurações do dispositivo',
        needsRestart: 'Idioma alterado',
        needsRestartMessage: 'O aplicativo precisa ser reiniciado para aplicar a nova configuração de idioma.',
        restartNow: 'Reiniciar agora',
    },

    connectButton: {
        authenticate: 'Autenticar terminal',
        authenticateWithUrlPaste: 'Autenticar terminal com colagem de URL',
        pasteAuthUrl: 'Cole a URL de autenticação do seu terminal',
    },

    updateBanner: {
        updateAvailable: 'Atualização disponível',
        pressToApply: 'Pressione para aplicar a atualização',
        whatsNew: 'Novidades',
        seeLatest: 'Veja as atualizações e melhorias mais recentes',
        nativeUpdateAvailable: 'Atualização do aplicativo disponível',
        tapToUpdateAppStore: 'Toque para atualizar na App Store',
        tapToUpdatePlayStore: 'Toque para atualizar na Play Store',
    },

    changelog: {
        // Used by the changelog screen
        version: ({ version }: { version: number }) => `Versão ${version}`,
        noEntriesAvailable: 'Nenhuma entrada de changelog disponível.',
    },

    terminal: {
        // Used by terminal connection screens
        webBrowserRequired: 'Navegador web necessário',
        webBrowserRequiredDescription: 'Links de conexão de terminal só podem ser abertos em um navegador web por questões de segurança. Use o leitor de código QR ou abra este link num computador.',
        processingConnection: 'Processando conexão...',
        invalidConnectionLink: 'Link de conexão inválido',
        invalidConnectionLinkDescription: 'O link de conexão está ausente ou inválido. Verifique a URL e tente novamente.',
        connectTerminal: 'Conectar terminal',
        terminalRequestDescription: 'Um terminal está solicitando conexão à sua conta Happy Coder. Isso permitirá que o terminal envie e receba mensagens com segurança.',
        connectionDetails: 'Detalhes da conexão',
        publicKey: 'Chave pública',
        encryption: 'Criptografia',
        endToEndEncrypted: 'Criptografia ponta a ponta',
        acceptConnection: 'Aceitar conexão',
        connecting: 'Conectando...',
        reject: 'Rejeitar',
        security: 'Segurança',
        securityFooter: 'Este link de conexão foi processado com segurança no seu navegador e nunca foi enviado para nenhum servidor. Seus dados privados permanecerão seguros e apenas você pode descriptografar as mensagens.',
        securityFooterDevice: 'Esta conexão foi processada com segurança no seu dispositivo e nunca foi enviada para nenhum servidor. Seus dados privados permanecerão seguros e apenas você pode descriptografar as mensagens.',
        clientSideProcessing: 'Processamento do lado cliente',
        linkProcessedLocally: 'Link processado localmente no navegador',
        linkProcessedOnDevice: 'Link processado localmente no dispositivo',
    },

    modals: {
        // Used across connect flows and settings
        authenticateTerminal: 'Autenticar terminal',
        pasteUrlFromTerminal: 'Cole a URL de autenticação do seu terminal',
        deviceLinkedSuccessfully: 'Dispositivo vinculado com sucesso',
        terminalConnectedSuccessfully: 'Terminal conectado com sucesso',
        invalidAuthUrl: 'URL de autenticação inválida',
        developerMode: 'Modo desenvolvedor',
        developerModeEnabled: 'Modo desenvolvedor ativado',
        developerModeDisabled: 'Modo desenvolvedor desativado',
        disconnectGithub: 'Desconectar GitHub',
        disconnectGithubConfirm: 'Tem certeza de que deseja desconectar sua conta GitHub?',
        disconnectService: ({ service }: { service: string }) => 
            `Desconectar ${service}`,
        disconnectServiceConfirm: ({ service }: { service: string }) => 
            `Tem certeza de que deseja desconectar ${service} da sua conta?`,
        disconnect: 'Desconectar',
        failedToConnectTerminal: 'Falha ao conectar terminal',
        cameraPermissionsRequiredToConnectTerminal: 'Permissões de câmera são necessárias para conectar terminal',
        failedToLinkDevice: 'Falha ao vincular dispositivo',
        cameraPermissionsRequiredToScanQr: 'Permissões de câmera são necessárias para escanear códigos QR'
    },

    navigation: {
        // Navigation titles and screen headers
        connectTerminal: 'Conectar terminal',
        linkNewDevice: 'Vincular novo dispositivo', 
        restoreWithSecretKey: 'Restaurar com chave secreta',
        whatsNew: 'Novidades',
    },

    welcome: {
        // Main welcome screen for unauthenticated users
        title: 'Cliente móvel Codex e Claude Code',
        subtitle: 'Criptografado ponta a ponta e sua conta é armazenada apenas no seu dispositivo.',
        createAccount: 'Criar conta',
        linkOrRestoreAccount: 'Vincular ou restaurar conta',
        loginWithMobileApp: 'Fazer login com aplicativo móvel',
    },

    review: {
        // Used by utils/requestReview.ts
        enjoyingApp: 'Curtindo o aplicativo?',
        feedbackPrompt: 'Adoraríamos ouvir seu feedback!',
        yesILoveIt: 'Sim, eu amo!',
        notReally: 'Não muito'
    },

    items: {
        // Used by Item component for copy toast
        copiedToClipboard: ({ label }: { label: string }) => `${label} copiado para a área de transferência`
    },

    machine: {
        offlineUnableToSpawn: 'Inicializador desativado enquanto a máquina está offline',
        offlineHelp: '• Verifique se seu computador está online\n• Execute `happy daemon status` para diagnosticar\n• Você está usando a versão mais recente do CLI? Atualize com `npm install -g happy-coder@latest`',
        launchNewSessionInDirectory: 'Iniciar nova sessão no diretório',
        daemon: 'Daemon',
        status: 'Status',
        stopDaemon: 'Parar daemon',
        lastKnownPid: 'Último PID conhecido',
        lastKnownHttpPort: 'Última porta HTTP conhecida',
        startedAt: 'Iniciado em',
        cliVersion: 'Versão do CLI',
        daemonStateVersion: 'Versão do estado do daemon',
        activeSessions: ({ count }: { count: number }) => `Sessões ativas (${count})`,
        machineGroup: 'Máquina',
        host: 'Host',
        machineId: 'ID da máquina',
        username: 'Nome de usuário',
        homeDirectory: 'Diretório home',
        platform: 'Plataforma',
        architecture: 'Arquitetura',
        lastSeen: 'Visto pela última vez',
        never: 'Nunca',
        metadataVersion: 'Versão dos metadados',
        untitledSession: 'Sessão sem título',
        back: 'Voltar',
    },

    message: {
        switchedToMode: ({ mode }: { mode: string }) => `Mudou para o modo ${mode}`,
        unknownEvent: 'Evento desconhecido',
        usageLimitUntil: ({ time }: { time: string }) => `Limite de uso atingido até ${time}`,
        unknownTime: 'horário desconhecido',
    },

    codex: {
        // Codex permission dialog buttons
        permissions: {
            yesForSession: 'Sim, e não perguntar para esta sessão',
            stopAndExplain: 'Parar, e explicar o que fazer',
        }
    },

    claude: {
        // Claude permission dialog buttons
        permissions: {
            yesAllowAllEdits: 'Sim, permitir todas as edições durante esta sessão',
            yesForTool: 'Sim, não perguntar novamente para esta ferramenta',
            noTellClaude: 'Não, e dizer ao Claude o que fazer diferente',
        }
    },

    textSelection: {
        // Text selection screen
        selectText: 'Selecionar intervalo de texto',
        title: 'Selecionar texto',
        noTextProvided: 'Nenhum texto fornecido',
        textNotFound: 'Texto não encontrado ou expirado',
        textCopied: 'Texto copiado para a área de transferência',
        failedToCopy: 'Falha ao copiar o texto para a área de transferência',
        noTextToCopy: 'Nenhum texto disponível para copiar',
    },

    artifacts: {
        title: 'Artefatos',
        countSingular: '1 artefato',
        countPlural: ({ count }: { count: number }) => `${count} artefatos`,
        empty: 'Ainda não há artefatos',
        emptyDescription: 'Crie seu primeiro artefato para salvar e organizar conteúdo',
        new: 'Novo artefato',
        edit: 'Editar artefato',
        delete: 'Excluir',
        updateError: 'Falha ao atualizar artefato. Por favor, tente novamente.',
        notFound: 'Artefato não encontrado',
        discardChanges: 'Descartar alterações?',
        discardChangesDescription: 'Você tem alterações não salvas. Tem certeza de que deseja descartá-las?',
        deleteConfirm: 'Excluir artefato?',
        deleteConfirmDescription: 'Este artefato será excluído permanentemente.',
        titlePlaceholder: 'Título do artefato',
        bodyPlaceholder: 'Digite o conteúdo aqui...',
        save: 'Salvar',
        saving: 'Salvando...',
        loading: 'Carregando...',
        error: 'Falha ao carregar artefatos',
        titleLabel: 'TÍTULO',
        bodyLabel: 'CONTEÚDO',
        emptyFieldsError: 'Por favor, insira um título ou conteúdo',
        createError: 'Falha ao criar artefato. Por favor, tente novamente.',
    }
} as const;

export type TranslationsPt = typeof pt;
