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

    /// The opening draft is read and `composerHeight(fitting:)` at the
    /// width last asked for is its measured height (measured off the main
    /// thread), or the wait for that ran out (`ChatComposerRestore.timeout`
    /// after the composer was made), or the person reached the composer
    /// first (a focus or a send). Until then the height is a guess: keep
    /// the dock hidden and lay it out anyway, so the first frame shown is
    /// the restored one. It turns true once and stays true, `retarget`
    /// included. It may turn true inside `composerHeight(fitting:)`: read
    /// it after; the delegate hears `composerDidRestore` too, then on the
    /// next turn of the main queue.
    var isRestored: Bool { get }

    /// Moves when a `retarget` finds the composer not yet restored: a
    /// `composerDidRestore` carrying an older one is stale.
    var restoreGeneration: Int { get }

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

    /// `isRestored` turned true. The dock's height is already laid out
    /// (`composerDidInvalidateHeight` came first if it moved): show it, at
    /// once and unanimated. `generation` is the `restoreGeneration` it was
    /// reached in.
    func composerDidRestore(_ composer: any ChatComposerView, generation: Int)

    /// The sender accepted a message (its local id). The screen scrolls to
    /// the newest message and, as happy-app does, dismisses any question
    /// the agent was waiting on, since the message answers it.
    func composer(_ composer: any ChatComposerView, didSend localId: String)
}

extension ChatComposerDelegate {
    public func composerDidRestore(_ composer: any ChatComposerView, generation: Int) {}
}

/// How long the chat waits for its composer's opening draft.
public enum ChatComposerRestore {
    /// From the composer's making to its showing at the latest, at the
    /// height known then; nothing is measured on the main thread when it
    /// runs out. Not happy-app's (its draft is in memory as the chat
    /// opens): the read and the measurement take a few milliseconds, so
    /// this only bounds a stalled read. Not tuned on a device.
    public static let timeout: Duration = .milliseconds(300)
}

/// Makes the composer the chat docks.
@MainActor
public enum ChatComposerFactory {
    public static func make(_ environment: ChatComposerEnvironment) -> any ChatComposerView {
        SessionComposerView(environment: environment)
    }
}
#endif
