extension TranslationCatalog {
    /// The title over a conversation that could not be read at all
    /// (`Strings.Chat.loadFailed`) in each language, under `native.chat.`
    /// keys. The words are Android's `conversation_load_failed`.
    static let chatSources: [String: [String: String]] = [
        "en": ["native.chat.loadFailed": "Couldn’t load this conversation"],
        "ru": ["native.chat.loadFailed": "Не удалось загрузить этот разговор"],
        "pl": ["native.chat.loadFailed": "Nie udało się wczytać tej rozmowy"],
        "es": ["native.chat.loadFailed": "No se pudo cargar esta conversación"],
        "it": ["native.chat.loadFailed": "Impossibile caricare questa conversazione"],
        "pt": ["native.chat.loadFailed": "Não foi possível carregar esta conversa"],
        "ca": ["native.chat.loadFailed": "No s’ha pogut carregar aquesta conversa"],
        "zh-Hans": ["native.chat.loadFailed": "无法加载此对话"],
        "zh-Hant": ["native.chat.loadFailed": "無法載入此對話"],
        "ja": ["native.chat.loadFailed": "この会話を読み込めませんでした"],
    ]
}
