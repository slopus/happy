#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// The title over a conversation that could not be read
/// (`Strings.Chat.loadFailed`): the screens' own English, and in every other
/// language the words Android's `conversation_load_failed` has.
@MainActor
final class ChatLoadFailedStringsTests: XCTestCase {
    override func tearDown() {
        AppLocalization.use(nil)
        super.tearDown()
    }

    func testTheTitleOverAConversationThatCouldNotBeReadFollowsTheLanguage() async {
        let words = [
            "en": "Couldn’t load this conversation",
            "ru": "Не удалось загрузить этот разговор",
            "pl": "Nie udało się wczytać tej rozmowy",
            "es": "No se pudo cargar esta conversación",
            "it": "Impossibile caricare questa conversazione",
            "pt": "Não foi possível carregar esta conversa",
            "ca": "No s’ha pogut carregar aquesta conversa",
            "zh-Hans": "无法加载此对话",
            "zh-Hant": "無法載入此對話",
            "ja": "この会話を読み込めませんでした",
        ]
        let languages = AppLanguage.supported.map(\.code)
        XCTAssertEqual(Set(languages), Set(words.keys))
        AppLocalization.use(nil)
        XCTAssertEqual(Strings.Chat.loadFailed, words["en"])
        for language in languages {
            // Decoded off the main thread, as the app decodes every catalog.
            let catalog = await TranslationCatalog.load(language)
            AppLocalization.use(catalog)
            XCTAssertEqual(Strings.Chat.loadFailed, words[language], language)
            // What the not-found chat shows as its title.
            let model = ChatPlaceholderModel(.notFound("The agent was not found."))
            XCTAssertEqual(model.lines.map(\.text), [words[language] ?? "", "The agent was not found."], language)
        }
    }
}
#endif
