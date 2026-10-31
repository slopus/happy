import HappyCore

extension Strings {
    enum ChatActions {
        private static let translations: [String: String] = [
            "en": "Permission mode",
            "ru": "Режим разрешений",
            "pl": "Tryb uprawnień",
            "es": "Modo de permisos",
            "it": "Modalità autorizzazioni",
            "pt": "Modo de permissões",
            "ca": "Mode de permisos",
            "zh-Hans": "权限模式",
            "zh-Hant": "權限模式",
            "ja": "権限モード",
        ]

        static var permissionMode: String { translations[AppLocalization.language] ?? translations["en"]! }
    }
}
