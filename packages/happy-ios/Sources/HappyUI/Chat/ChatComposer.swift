#if canImport(UIKit)
import HappyCore
import UIKit

// The contract between the chat screen and its composer.
//
// The screen owns the dock: it docks it to the keyboard (and follows an
// interactive dismiss), stacks the bars above it (question banner, goal,
// rig activity), and keeps the newest message just above it. The composer
// owns everything inside its own bounds: the text, the draft, attachments,
// the mode chips, the context meter, send and stop.
//
//     ChatViewController
//       ├─ list (flipped collection view)
//       └─ dock ─┬─ accessories (the screen's)
//                └─ composer: any ChatComposerView   ← ChatComposerFactory.make
//
// Data in: `ChatComposerEnvironment` once, at creation (session id, the
// account, the sender, the controls); `ChatComposerState` on every change
// (the session record and settings, usage, outbox delivery).
// Events out: `ChatComposerDelegate` (height, focus, sent).

/// What a composer is created with. Fixed for the composer's lifetime.
@MainActor
public struct ChatComposerEnvironment {
    public var sessionId: String
    /// The signed-in account: `account.sender` has the draft, the composer
    /// state and the attachment plan; `account.sync`/`actions` the RPCs.
    public var account: AccountSession
    /// Where to send. `account.sender` for a real session; the debug
    /// fixtures substitute their own, so send through this, not the
    /// account's.
    public var sender: any ChatSending
    /// Stop (`abort`), and the permission and question answers.
    public var controls: any ChatControls
    /// Where the draft is kept. `account.sender` for a session; a chat still
    /// being started (`pending-chat:`) keeps it in its own record.
    public var draftStorage: any ComposerStorage

    public init(
        sessionId: String,
        account: AccountSession,
        sender: any ChatSending,
        controls: any ChatControls,
        draftStorage: (any ComposerStorage)? = nil
    ) {
        self.sessionId = sessionId
        self.account = account
        self.sender = sender
        self.controls = controls
        self.draftStorage = draftStorage ?? account.sender
    }
}

/// What the composer shows that comes from outside it. The screen pushes a
/// new value whenever any part changes, and only then.
public struct ChatComposerState: Equatable, Sendable {
    /// The session record (metadata, agent state, thinking, active) and the
    /// account settings.
    public var session: ChatSessionState
    /// The latest model usage, for the context meter (`ChatSnapshot.usage`).
    public var usage: ChatUsage?
    /// Unsent messages by local id (`ChatSnapshot.delivery`).
    public var delivery: [String: OutboxDelivery]
    /// The chat has been read at least once (`ChatSnapshot.isLoaded`).
    public var isLoaded: Bool
    /// The agent is waiting on a question the person can answer by typing
    /// (AskUserQuestion / request_user_input); sending answers it.
    public var hasPendingQuestion: Bool

    public init(session: ChatSessionState, usage: ChatUsage? = nil, delivery: [String: OutboxDelivery] = [:], isLoaded: Bool = false, hasPendingQuestion: Bool = false) {
        self.session = session
        self.usage = usage
        self.delivery = delivery
        self.isLoaded = isLoaded
        self.hasPendingQuestion = hasPendingQuestion
    }
}

/// The composer view the chat docks. Frames only: the screen sets the
/// composer's frame from `composerHeight(fitting:)`, and the composer lays
/// out its own subviews in `layoutSubviews`.
@MainActor
public protocol ChatComposerView: UIView {
    var composerDelegate: (any ChatComposerDelegate)? { get set }

    /// The composer's height at `width`, status rows included. Called on
    /// every screen layout, so keep it cheap (cache by width and content).
    func composerHeight(fitting width: CGFloat) -> CGFloat

    /// From the composer's top to its card's top: the status rows sit
    /// above the card. The scroll-to-newest button floats 16 above the card.
    var cardOffset: CGFloat { get }

    /// The latest session, usage and outbox state.
    func update(_ state: ChatComposerState)

    /// The chat being started arrived as a session: write there from now
    /// on. The same composer carries the text, caret, composition and
    /// keyboard across; nothing is read back over them. Call it once the
    /// pending chat has handed its draft over, then `update` with the
    /// session's state.
    func retarget(_ environment: ChatComposerEnvironment)

    /// The status rows above the card fade out while the reader is scrolled
    /// back through history and return at the newest message (ChatList's
    /// `onBottomDockVisibilityChange`). They keep their space either way.
    func setDetailsVisible(_ visible: Bool, animated: Bool)

    /// The text view is first responder. (`isFocused` is UIKit's focus engine.)
    var isTextFocused: Bool { get }
    func focus()
    func blur()
}

@MainActor
public protocol ChatComposerDelegate: AnyObject {
    /// `composerHeight(fitting:)` or `cardOffset` changed. The screen lays
    /// the dock out again at once; call it inside an animation block to
    /// animate the dock and the list's inset with the composer.
    func composerDidInvalidateHeight(_ composer: any ChatComposerView)

    /// The text view gained or lost focus.
    func composerDidChangeFocus(_ composer: any ChatComposerView)

    /// The sender accepted a message (its local id). The screen scrolls to
    /// the newest message and, as happy-app does, dismisses any question
    /// the agent was waiting on, since the message answers it.
    func composer(_ composer: any ChatComposerView, didSend localId: String)
}

/// Makes the composer the chat docks.
@MainActor
public enum ChatComposerFactory {
    public static func make(_ environment: ChatComposerEnvironment) -> any ChatComposerView {
        SessionComposerView(environment: environment)
    }
}
#endif
