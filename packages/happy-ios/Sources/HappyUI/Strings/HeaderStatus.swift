import HappyCore

extension Strings {
    /// Native header copy, shared by home and chat. Every shipped language
    /// has the same states; activity is shown only once the link is online.
    enum HeaderStatus {
        /// Telegram's: "updating…" while it catches up, "connecting…" while it
        /// reaches the server, "waiting for network…" with no way out at all.
        enum State: Int, CaseIterable { case online = 0, syncing = 1, connecting = 2, offline = 3, waitingForNetwork = 7 }

        static let translations: [String: [String]] = [
            "en": ["online", "updating…", "connecting…", "offline", "Thinking", "Working", "Waiting for your answer", "waiting for network…"],
            "ru": ["в сети", "синхронизация…", "подключение…", "не в сети", "Думает", "Работает", "Ждёт вашего ответа", "ожидание сети…"],
            "pl": ["online", "synchronizacja…", "łączenie…", "offline", "Myśli", "Pracuje", "Czeka na Twoją odpowiedź", "oczekiwanie na sieć…"],
            "es": ["en línea", "sincronizando…", "conectando…", "sin conexión", "Pensando", "Trabajando", "Esperando tu respuesta", "esperando red…"],
            "it": ["online", "sincronizzazione…", "connessione…", "offline", "Sta pensando", "Al lavoro", "In attesa della tua risposta", "in attesa di rete…"],
            "pt": ["online", "sincronizando…", "conectando…", "offline", "Pensando", "Trabalhando", "Aguardando sua resposta", "aguardando rede…"],
            "ca": ["en línia", "sincronitzant…", "connectant…", "fora de línia", "Pensant", "Treballant", "Esperant la teva resposta", "esperant la xarxa…"],
            "zh-Hans": ["在线", "同步中…", "连接中…", "离线", "思考中", "工作中", "等待你的回答", "等待网络…"],
            "zh-Hant": ["在線", "同步中…", "連線中…", "離線", "思考中", "工作中", "等待你的回答", "等待網路…"],
            "ja": ["オンライン", "同期中…", "接続中…", "オフライン", "思考中", "作業中", "あなたの回答を待っています", "ネットワーク待機中…"],
        ]

        static var all: [String] { translations[AppLocalization.language] ?? translations["en"]! }
        static func text(_ state: State) -> String { all[state.rawValue] }
        static func text(_ state: State, activity: Activity?, loaded: Bool) -> String {
            guard state == .online else { return text(state) }
            guard loaded else { return text(.syncing) }
            guard let activity else { return text(.online) }
            return switch activity.phase {
            case .thinking, .waitingForModel: all[4]
            case .awaitingAnswer: all[6]
            default: all[5]
            }
        }
    }
}