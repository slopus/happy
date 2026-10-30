import HappyCore

extension Strings {
    enum ChatActions {
        private static let translations: [String: [String]] = [
            "en": ["More", "Permission mode"],
            "ru": ["Ещё", "Режим разрешений"],
            "pl": ["Więcej", "Tryb uprawnień"],
            "es": ["Más", "Modo de permisos"],
            "it": ["Altro", "Modalità autorizzazioni"],
            "pt": ["Mais", "Modo de permissões"],
            "ca": ["Més", "Mode de permisos"],
            "zh-Hans": ["更多", "权限模式"],
            "zh-Hant": ["更多", "權限模式"],
            "ja": ["その他", "権限モード"],
        ]

        private static var words: [String] { translations[AppLocalization.language] ?? translations["en"]! }
        static var more: String { words[0] }
        static var permissionMode: String { words[1] }
    }
}