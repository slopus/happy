#if canImport(UIKit)
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
import UIKit

/// Settings › Appearance › Language (app/(app)/settings/language.tsx):
/// Automatic and every language happy-app ships. The choice is synced, so
/// happy-app on the account's other devices follows it. After the same
/// alert, where happy-app reloads, the screens are built again from the
/// root in the new language.
public final class SettingsLanguageViewController: UIViewController {
    private let session: AccountSession
    private let list = GroupedListView()
    private var observation: StoreObservation?
    private var preferred: String?

    public init(session: AccountSession) {
        self.session = session
        super.init(nibName: nil, bundle: nil)
        followsTextSize()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    public override func loadView() {
        view = list
    }

    public override func viewDidLoad() {
        super.viewDidLoad()
        title = Strings.SettingsLanguage.title
        showsBackTitle()
        observation = session.store.observeSettings { [weak self] snapshot in
            self?.preferred = AccountSettings(snapshot).preferredLanguage
            self?.rebuild()
        }
    }

    private func rebuild() {
        let selection = AppLanguage.selection(preferred)
        let detected = AppLanguage.detectedName(deviceLanguages: Locale.preferredLanguages)
        var options: [(code: String?, title: String, subtitle: String?)] = [
            (nil, Strings.SettingsLanguage.automatic, "\(Strings.SettingsLanguage.automaticSubtitle) (\(detected))"),
        ]
        options += AppLanguage.supported.map { ($0.code, $0.nativeName, nil) }
        let rows = options.map { option in
            let row = ItemRowView(
                title: option.title,
                subtitle: option.subtitle,
                icon: ItemIcon(.ionicons("language-outline"), tint: Palette.iconBlue)
            ) { [weak self] in
                self?.choose(option.code)
            }
            row.showsChevron = false
            if option.code == selection {
                row.trailingView = SettingsCheckmark.view(tint: Palette.iconBlue)
            }
            return row
        }
        list.sections = [
            ItemGroupView(title: Strings.SettingsLanguage.currentLanguage, footer: Strings.SettingsLanguage.description, rows: rows),
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
            rebuild()
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
