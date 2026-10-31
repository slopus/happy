import HappyCore

extension Strings {
    /// The chat's controls and facts that moved from its header to its
    /// profile, in iOS's own words (happy-app has no keys for them).
    enum ChatActions {
        private static let translations: [String: [String]] = [
            "en": ["Permission mode", "Branch"],
            "ru": ["Режим разрешений", "Ветка"],
            "pl": ["Tryb uprawnień", "Gałąź"],
            "es": ["Modo de permisos", "Rama"],
            "it": ["Modalità autorizzazioni", "Branch"],
            "pt": ["Modo de permissões", "Branch"],
            "ca": ["Mode de permisos", "Branca"],
            "zh-Hans": ["权限模式", "分支"],
            "zh-Hant": ["權限模式", "分支"],
            "ja": ["権限モード", "ブランチ"],
        ]

        private static var words: [String] { translations[AppLocalization.language] ?? translations["en"]! }
        static var permissionMode: String { words[0] }
        static var branch: String { words[1] }
    }
}
