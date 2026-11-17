extension TranslationCatalog {
    /// Settings › Appearance › Group tool calls (`ToolSections`) in each
    /// language, under `native.toolSections.` keys.
    static let toolSectionsSources: [String: [String: String]] = [
        "en": [
            "native.toolSections.title": "Group tool calls",
            "native.toolSections.description": "In an agent's chat, each run of tool calls is one line: the latest call while it works, then a summary. Off, every call is a row of its own.",
        ],
        "ru": [
            "native.toolSections.title": "Группировать вызовы инструментов",
            "native.toolSections.description": "В чате агента каждая серия вызовов инструментов — одна строка: последний вызов, пока идёт работа, затем сводка. Если выключено, каждый вызов — отдельная строка.",
        ],
        "pl": [
            "native.toolSections.title": "Grupuj wywołania narzędzi",
            "native.toolSections.description": "W czacie agenta każda seria wywołań narzędzi to jeden wiersz: ostatnie wywołanie w trakcie pracy, potem podsumowanie. Po wyłączeniu każde wywołanie ma własny wiersz.",
        ],
        "es": [
            "native.toolSections.title": "Agrupar llamadas a herramientas",
            "native.toolSections.description": "En el chat de un agente, cada serie de llamadas a herramientas es una línea: la última llamada mientras trabaja y luego un resumen. Desactivado, cada llamada tiene su propia fila.",
        ],
        "it": [
            "native.toolSections.title": "Raggruppa le chiamate agli strumenti",
            "native.toolSections.description": "Nella chat di un agente, ogni serie di chiamate agli strumenti è una riga: l'ultima chiamata mentre lavora, poi un riepilogo. Disattivato, ogni chiamata ha una riga propria.",
        ],
        "pt": [
            "native.toolSections.title": "Agrupar chamadas de ferramentas",
            "native.toolSections.description": "No chat de um agente, cada série de chamadas de ferramentas é uma linha: a chamada mais recente enquanto trabalha e depois um resumo. Desativado, cada chamada tem a sua própria linha.",
        ],
        "ca": [
            "native.toolSections.title": "Agrupa les crides a eines",
            "native.toolSections.description": "Al xat d'un agent, cada sèrie de crides a eines és una línia: l'última crida mentre treballa i després un resum. Desactivat, cada crida té la seva pròpia fila.",
        ],
        "zh-Hans": [
            "native.toolSections.title": "合并工具调用",
            "native.toolSections.description": "在智能体的聊天中，每一串工具调用显示为一行：工作时显示最新的调用，结束后显示摘要。关闭后，每个调用单独一行。",
        ],
        "zh-Hant": [
            "native.toolSections.title": "合併工具呼叫",
            "native.toolSections.description": "在智慧代理的聊天中，每一串工具呼叫顯示為一行：工作時顯示最新的呼叫，結束後顯示摘要。關閉後，每個呼叫各佔一行。",
        ],
        "ja": [
            "native.toolSections.title": "ツール呼び出しをまとめる",
            "native.toolSections.description": "エージェントのチャットで、一連のツール呼び出しを1行にまとめます。作業中は最新の呼び出し、終わると要約を表示します。オフにすると、呼び出しごとに1行になります。",
        ],
    ]
}
