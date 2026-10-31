#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
import UIKit

/// Settings › Language (app/(app)/settings/language.tsx) in settings'
/// cards: Automatic and every language happy-app ships, the chosen one
/// ticked. The choice is synced, so happy-app on the account's other
/// devices follows it. After the same alert, where happy-app reloads, the
/// screens are built again from the root in the new language.
final class SettingsLanguageViewController: SettingsPageViewController {
    private let session: AccountSession
    private var observation: StoreObservation?
    private var preferred: String?

    init(session: AccountSession) {
        self.session = session
        super.init(title: Strings.SettingsLanguage.title)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = session.store.observeSettings { [weak self] snapshot in
            let preferred = AccountSettings(snapshot).preferredLanguage
            guard let self, preferred != self.preferred else { return }
            self.preferred = preferred
            reload()
        }
    }

    override func makeRows() -> [[SettingsRow]] {
        typealias Text = Strings.SettingsLanguage
        let selection = AppLanguage.selection(preferred)
        let detected = AppLanguage.detectedName(deviceLanguages: Locale.preferredLanguages)
        func row(_ code: String?, _ title: String, icon: (String, SettingsRow.Tile)? = nil, value: String? = nil) -> SettingsRow {
            SettingsRow(id: "app-language:\(code ?? "auto")", title: title, icon: icon, value: code == selection ? "✓" : value, accessory: .none, action: { [weak self] in self?.choose(code) })
        }
        return [
            [row(nil, Text.automatic, icon: ("language-outline", .green), value: detected)].withFooter("\(Text.automaticSubtitle) (\(detected))"),
            AppLanguage.supported.map { row($0.code, $0.nativeName) }.withFooter(Text.description),
        ]
    }

    private func choose(_ code: String?) {
        guard code != AppLanguage.selection(preferred) else { return }
        Task { @MainActor in
            let confirmed = await Alerts.confirm(
                Strings.SettingsLanguage.needsRestart,
                Strings.SettingsLanguage.needsRestartMessage,
                confirmTitle: Strings.Common.ok,
                on: self
            )
            guard confirmed else { return }
            preferred = code
            session.updateSettings(["preferredLanguage": code.map(JSONValue.string) ?? .null])
            reload()
            // language.tsx reloads 100 ms after saving; the window decodes
            // the catalog off the main thread meanwhile, for this account's
            // screens only.
            let language = AppLanguage.resolve(preferred: code, deviceLanguages: Locale.preferredLanguages)
            NotificationCenter.default.post(
                name: .screensLanguageChosen,
                object: ScreensLanguageChoice(code: language, account: session)
            )
        }
    }
}
#endif
