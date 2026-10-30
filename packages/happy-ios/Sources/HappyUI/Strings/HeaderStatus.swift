import HappyCore

extension Strings {
    /// Native header copy, shared by home and chat. Every shipped language
    /// has the same states; activity is shown only once the link is online.
    enum HeaderStatus {
        enum State: Int, CaseIterable { case online, syncing, connecting, offline }

        static let translations: [String: [String]] = [
            "en": ["online", "syncing", "connecting", "offline", "Thinking", "Working", "Waiting for your answer"],
            "ru": ["в сети", "синхронизация", "подключение", "не в сети", "Думает", "Работает", "Ждёт вашего ответа"],
            "pl": ["online", "synchronizacja", "łączenie", "offline", "Myśli", "Pracuje", "Czeka na Twoją odpowiedź"],
            "es": ["en línea", "sincronizando", "conectando", "sin conexión", "Pensando", "Trabajando", "Esperando tu respuesta"],
            "it": ["online", "sincronizzazione", "connessione", "offline", "Sta pensando", "Al lavoro", "In attesa della tua risposta"],
            "pt": ["online", "sincronizando", "conectando", "offline", "Pensando", "Trabalhando", "Aguardando sua resposta"],
            "ca": ["en línia", "sincronitzant", "connectant", "fora de línia", "Pensant", "Treballant", "Esperant la teva resposta"],
            "zh-Hans": ["在线", "同步中", "连接中", "离线", "思考中", "工作中", "等待你的回答"],
            "zh-Hant": ["在線", "同步中", "連線中", "離線", "思考中", "工作中", "等待你的回答"],
            "ja": ["オンライン", "同期中", "接続中", "オフライン", "思考中", "作業中", "あなたの回答を待っています"],
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