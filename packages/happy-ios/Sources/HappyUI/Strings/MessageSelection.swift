import HappyCore

extension Strings {
    /// A lifted message's menu and its selection's menu, in iOS's own
    /// words as Telegram words them (happy-app has no keys for them). Copy
    /// is `common.copy`.
    enum MessageSelection {
        private static let translations: [String: [String]] = [
            "en": ["Select", "Select All", "Share"],
            "ru": ["Выбрать", "Выбрать все", "Поделиться"],
            "pl": ["Zaznacz", "Zaznacz wszystko", "Udostępnij"],
            "es": ["Seleccionar", "Seleccionar todo", "Compartir"],
            "it": ["Seleziona", "Seleziona tutto", "Condividi"],
            "pt": ["Selecionar", "Selecionar tudo", "Compartilhar"],
            "ca": ["Selecciona", "Selecciona-ho tot", "Comparteix"],
            "zh-Hans": ["选择", "全选", "分享"],
            "zh-Hant": ["選取", "全選", "分享"],
            "ja": ["選択", "すべてを選択", "共有"],
        ]

        private static var words: [String] { translations[AppLocalization.language] ?? translations["en"]! }
        static var select: String { words[0] }
        static var selectAll: String { words[1] }
        static var share: String { words[2] }
    }
}
