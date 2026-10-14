#if canImport(UIKit)
import HappyCore
import UIKit

/// The language a new root's screens speak (text/index.ts at launch), or
/// the Language page's choice for them (language.tsx reloads the app),
/// decided off the main thread before they are built. The window takes no
/// touches and nothing on it keeps the keyboard meanwhile: what is on it,
/// the stack, the sidebar and anything presented over them, belongs to the
/// root being left, and is replaced before the window takes touches again,
/// whatever the decision. A newer root replaces a pending one without
/// letting go in between. When ending editing for the hold cancels the
/// request (or the decision is otherwise applied inside the hold), the
/// root is installed within that same call, before the window's touches
/// were ever taken, so nothing reaches the screens being left in between.
@MainActor
final class ScreensLanguage {
    /// Only the gate that took the hold lets it go, so it lives as long as
    /// this does, which is the coordinator's whole life.
    let gate = AccountLocalizationGate<TranslationCatalog>()
    private weak var view: UIView?
    /// What the view allowed before the hold; nil while nothing is held.
    private var allowed: Bool?
    /// The account the newest root is for; nil while signed out. A choice
    /// made in any other account's screens changes nothing.
    private weak var account: AnyObject?
    /// The newest root's install until it is in. A choice made meanwhile
    /// decides its language; the root is installed all the same.
    private var owed: (@MainActor () -> Void)?
    /// What builds the screens again for the Language page's choices.
    private var rebuildChosen: (@MainActor (_ changed: Bool) -> Void)?
    nonisolated(unsafe) private var choices: NSObjectProtocol?

    deinit {
        if let choices { NotificationCenter.default.removeObserver(choices) }
    }

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
        for account: AnyObject?,
        resolve: @escaping @Sendable () async throws -> String,
        install: @escaping @MainActor () -> Void
    ) {
        self.account = account
        owed = install
        decide(resolve)
    }

    /// The Language page's choice of `code` (`AppLanguage.resolve`d), made
    /// in `account`'s screens: decoded off the main thread, then
    /// `rebuild(true)` builds them again in it; `rebuild(false)` when they
    /// speak it already. Nothing at all when the screens are another
    /// account's by now, its root pending or in; a root asked for before
    /// this is applied replaces it.
    func choose(_ code: String, in account: AnyObject, rebuild: @escaping @MainActor (_ changed: Bool) -> Void) {
        guard account === self.account else { return }
        decide({ code }, then: rebuild)
    }

    /// Takes the Language page's choices (`screensLanguageChosen`) from
    /// now on, each as `choose` takes it, rebuilding with `rebuild`.
    func takeChoices(rebuild: @escaping @MainActor (_ changed: Bool) -> Void) {
        rebuildChosen = rebuild
        guard choices == nil else { return }
        choices = NotificationCenter.default.addObserver(forName: .screensLanguageChosen, object: nil, queue: .main) { [weak self] note in
            guard let choice = note.object as? ScreensLanguageChoice else { return }
            MainActor.assumeIsolated {
                guard let self, let rebuild = self.rebuildChosen else { return }
                self.choose(choice.code, in: choice.account, rebuild: rebuild)
            }
        }
    }

    private func decide(
        _ resolve: @escaping @Sendable () async throws -> String,
        then rebuild: (@MainActor (Bool) -> Void)? = nil
    ) {
        isDeciding = true
        gate.update(
            currentLanguage: AppLocalization.language,
            resolve: resolve,
            load: { await TranslationCatalog.load($0) },
            apply: { [weak self] result in
                guard let self else { return }
                self.isDeciding = false
                var changed = false
                if case .success(.replace(let catalog)) = result { changed = AppLocalization.use(catalog) }
                if let owed = self.owed {
                    self.owed = nil
                    owed()
                } else {
                    rebuild?(changed)
                }
            }
        )
    }

    private func hold(_ pending: Bool) {
        guard let view else { return }
        if pending {
            guard allowed == nil else { return }
            allowed = view.isUserInteractionEnabled
            // Typing comes from the keyboard's own window, whatever this one
            // takes: nothing on the screens being replaced keeps it. Ended
            // before the window stops taking touches: UIKit makes a
            // responder it resigned for that first responder again when the
            // window takes touches again. Ending editing can call back into
            // a request, which keeps this hold, or let go, after which
            // nothing here holds the window again.
            view.endEditing(true)
            guard allowed != nil else { return }
            view.isUserInteractionEnabled = false
        } else if allowed != nil {
            // A root installed without animating replaces the screens being
            // left only when the window is next laid out: laid out here, as
            // this turn of the run loop would anyway (no text is measured
            // for it), so they are off the window before it takes touches
            // again. Laying out can call back into a request, which keeps
            // the hold until its root is in.
            view.layoutIfNeeded()
            guard !gate.isPending, let allowed else { return }
            self.allowed = nil
            view.isUserInteractionEnabled = allowed
        }
    }
}

/// The Language page's choice, as `screensLanguageChosen`'s object: the
/// code its screens speak from now on, and the account they belong to.
struct ScreensLanguageChoice: Sendable {
    let code: String
    let account: AccountSession
}
#endif
