#if canImport(UIKit)
import HappyCore
import HappyStore
import UIKit

// The seam between the chat screen (Chat workstream) and the composer
// (Composer workstream):
//
//     chat screen ── ComposerFactory.make(context) ──▶ ChatComposer
//     chat screen ── apply(state) on every snapshot ─▶ ChatComposer
//     ChatComposer ── onHeightChange ──▶ chat screen re-runs ChatScreenLayout
//
// The screen owns the keyboard-docked dock and places the composer at the
// dock's full width (`ChatScreenLayout.composer`); the composer only says
// how tall it is for a width (`sizeThatFits`). Keyboard tracking and
// interactive dismiss belong to the screen, never to the composer.

/// What the composer needs from the screen that hosts it.
@MainActor
public struct ComposerContext {
    public let sessionId: String
    /// The active account: `sender` (send, drafts, composer state,
    /// attachment plan), `actions` (abort), `store`.
    public let session: AccountSession
    public let app: AppContext
    /// Presents pickers, menus and alerts.
    public weak var presenter: UIViewController?

    public init(sessionId: String, session: AccountSession, app: AppContext, presenter: UIViewController?) {
        self.sessionId = sessionId
        self.session = session
        self.app = app
        self.presenter = presenter
    }
}

/// What the screen knows that the composer shows: the session (busy or
/// idle decides send vs stop, the agent decides the pickers) and the chat
/// (usage for the context meter, unsent messages).
public struct ComposerState: Equatable, Sendable {
    public var session: SessionRecord?
    public var snapshot: ChatSnapshot

    public init(session: SessionRecord?, snapshot: ChatSnapshot) {
        self.session = session
        self.snapshot = snapshot
    }
}

/// The composer view (happy-app's AgentInput and everything inside it:
/// text input, send/stop, attachment strip, autocomplete, mode pickers,
/// context meter). Its height includes whatever it shows above the text
/// field, such as suggestions.
@MainActor
public protocol ChatComposer: UIView {
    /// Called whenever `sizeThatFits` would now return a different height.
    /// The screen re-lays out the dock, animated alongside the change.
    var onHeightChange: (() -> Void)? { get set }
    /// Called after a message was accepted into the outbox, with its
    /// localId, so the screen can scroll to the newest message.
    var onSend: ((String) -> Void)? { get set }
    /// Room the composer keeps below its content while the keyboard is down
    /// (the home indicator); 0 while the keyboard is up.
    var bottomInset: CGFloat { get set }
    /// Called on the first snapshot and on every change after it.
    func apply(_ state: ComposerState)
    func focus()
    func unfocus()
}

/// How the chat screen gets its composer. The Composer workstream sets
/// `make` to its real view; until then the screen gets an empty bar.
@MainActor
public enum ComposerFactory {
    public static var make: (ComposerContext) -> any ChatComposer = { _ in EmptyComposer() }
}

/// Stands in until the real composer lands: no height, no input.
final class EmptyComposer: UIView, ChatComposer {
    var onHeightChange: (() -> Void)?
    var onSend: ((String) -> Void)?
    var bottomInset: CGFloat = 0

    func apply(_ state: ComposerState) {}
    func focus() {}
    func unfocus() {}

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: 0)
    }
}
#endif
