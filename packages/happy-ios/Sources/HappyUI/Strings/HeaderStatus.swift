import Foundation
import HappyCore

extension Strings {
    /// Native header copy, shared by home and chat. Every shipped language
    /// has the same states; activity is shown only once the link is online.
    enum HeaderStatus {
        /// Telegram's: "updating…" while it catches up, "connecting…" while it
        /// reaches the server, "waiting for network…" with no way out at all.
        typealias State = LinkState

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
        static func text(_ state: State) -> String { all[index(state)] }

        private static func index(_ state: State) -> Int {
            switch state {
            case .online: 0
            case .syncing: 1
            case .connecting: 2
            case .offline: 3
            case .waitingForNetwork: 7
            }
        }

        /// The link on its way somewhere: said with the spinner before it.
        static func spins(_ state: State) -> Bool {
            state == .syncing || state == .connecting || state == .waitingForNetwork
        }

        /// The words said with the spinner, in the screens' language.
        static var spinning: [String] { State.allCases.filter { spins($0) }.map { text($0) } }

        /// What home's title says in the account's name's place, the same
        /// words begun with a capital as a title is ("Connecting…"); nil
        /// while the name stands. Offline isn't said there: what home lists
        /// says why (a computer that did not answer, a pairing to redo).
        static func title(_ state: State) -> String? {
            guard spins(state) else { return nil }
            let text = text(state)
            let locale = Locale(identifier: AppLocalization.language)
            return text.prefix(1).uppercased(with: locale) + text.dropFirst()
        }
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