extension TranslationCatalog {
    /// What Authenticate Terminal asks, naming the Happy account a
    /// computer's code goes to (`Strings.TerminalLink`), in each language,
    /// under `native.terminalLink.` keys.
    static let terminalLinkSources: [String: [String: String]] = [
        "en": ["native.terminalLink.connectTo": "Connect this terminal to ${name}?"],
        "ru": ["native.terminalLink.connectTo": "Подключить этот терминал к ${name}?"],
        "pl": ["native.terminalLink.connectTo": "Połączyć ten terminal z ${name}?"],
        "es": ["native.terminalLink.connectTo": "¿Conectar esta terminal a ${name}?"],
        "it": ["native.terminalLink.connectTo": "Collegare questo terminale a ${name}?"],
        "pt": ["native.terminalLink.connectTo": "Conectar este terminal a ${name}?"],
        "ca": ["native.terminalLink.connectTo": "Vols connectar aquest terminal a ${name}?"],
        "zh-Hans": ["native.terminalLink.connectTo": "将此终端连接到 ${name}？"],
        "zh-Hant": ["native.terminalLink.connectTo": "將此終端機連接到 ${name}？"],
        "ja": ["native.terminalLink.connectTo": "このターミナルを ${name} に接続しますか？"],
    ]
}
