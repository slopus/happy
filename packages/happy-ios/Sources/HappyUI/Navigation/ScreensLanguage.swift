#if canImport(UIKit)
import HappyCore
import UIKit

/// The language a new root's screens speak (text/index.ts at launch),
/// decided off the main thread before they are built. The window takes no
/// touches meanwhile: what is on it, the stack, the sidebar and anything
/// presented over them, belongs to the root being left, and is replaced
/// before the window takes them again, whatever the decision. A newer root
/// replaces a pending one without letting go in between.
@MainActor
final class ScreensLanguage {
    /// Only the gate that took the hold lets it go, so it lives as long as
    /// this does, which is the coordinator's whole life.
    let gate = AccountLocalizationGate<TranslationCatalog>()
    private weak var view: UIView?
    /// What the view allowed before the hold; nil while nothing is held.
    private var allowed: Bool?

    /// Holds `view`'s touches while a root is being decided: the window.
    init(holding view: UIView) {
        self.view = view
        gate.onPendingChange = { [weak self] pending in self?.hold(pending) }
    }

    /// Whether a root is being decided, so the screens on the window are
    /// the ones it replaces. Over once it is applied, which is before the
    /// window takes touches again.
    private(set) var isDeciding = false

    /// Decides the language off the main thread with `resolve` (a code of
    /// `AppLanguage.supported`), decodes it there unless the screens speak
    /// it already, then calls `install` with it in use: on a failure, in
    /// the language in use now. `install` runs before the window takes
    /// touches again, unless a newer request replaced this one.
    func request(
        resolve: @escaping @Sendable () async throws -> String,
        install: @escaping @MainActor () -> Void
    ) {
        isDeciding = true
        gate.update(
            currentLanguage: AppLocalization.language,
            resolve: resolve,
            load: { await TranslationCatalog.load($0) },
            apply: { [weak self] result in
                self?.isDeciding = false
                if case .success(.replace(let catalog)) = result { AppLocalization.use(catalog) }
                install()
            }
        )
    }

    private func hold(_ pending: Bool) {
        guard let view else { return }
        if pending {
            guard allowed == nil else { return }
            allowed = view.isUserInteractionEnabled
            view.isUserInteractionEnabled = false
        } else if let allowed {
            self.allowed = nil
            view.isUserInteractionEnabled = allowed
        }
    }
}
#endif
