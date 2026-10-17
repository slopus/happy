#if canImport(UIKit)
import Foundation
import HappyCore
@testable import HappyUI
import UIKit

/// A debug app for the chat's UI tests (`Tests/HappyChatUITests`): one
/// fixture chat under the app's own root (`TabletShellViewController` over a
/// navigation), offline, signed in with a throwaway account. Gestures need a
/// separate process to drive them, and the real app can't open a chat
/// without an account.
///
/// Launch arguments: `-fixture <name>` picks the chat (`long` by default);
/// `-keyboard` opens the keyboard once the rows are in; `-scrollTo
/// <fraction>` goes that far back through the history once the rows are
/// in.
///
/// `ChatScrollProbe` reports the list to the tests as the accessibility value
/// of an element named `chat-scroll-probe`.
@main
@MainActor
final class HarnessAppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = HarnessSceneDelegate.self
        return configuration
    }
}

private struct NoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

private struct NoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection {
        throw URLError(.notConnectedToInternet)
    }
}

@MainActor
final class HarnessSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var controller: AccountController?
    private var probe: ChatScrollProbe?
    private var whatsNew: WhatsNewProbe?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        Fonts.registerBundledFonts()
        let window = HarnessWindow(windowScene: scene)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        self.window = window
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "whatsnew" {
            whatsNew = WhatsNewProbe(window: window, arguments: arguments)
            return
        }
        let fixture = arguments.firstIndex(of: "-fixture").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } ?? FixtureScenario.long.rawValue
        let scrollTo = arguments.firstIndex(of: "-scrollTo").flatMap { arguments.indices.contains($0 + 1) ? Double(arguments[$0 + 1]) : nil }
        Task {
            await self.open(
                fixture: fixture, in: window, keyboard: arguments.contains("-keyboard"),
                scrollTo: scrollTo.map { CGFloat($0) }
            )
        }
    }

    private func open(fixture: String, in window: HarnessWindow, keyboard: Bool, scrollTo: CGFloat?) async {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/harness",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: NoNetwork(),
            connector: NoSockets()
        )
        do {
            try await controller.signIn(Credentials(token: "harness", secret: Data(repeating: 7, count: 32)))
        } catch {
            fatalError("harness sign-in failed: \(error)")
        }
        guard let account = controller.session else { fatalError("harness has no session") }
        self.controller = controller
        let context = AppContext(account: controller, variant: .development, version: "harness")
        let chat = ChatViewController(context: context, session: account, sessionId: FixtureScenarios.prefix + fixture)
        let home = UIViewController()
        home.title = "Chats"
        home.view.backgroundColor = .systemBackground
        let navigation = UINavigationController(rootViewController: home)
        navigation.pushViewController(chat, animated: false)
        window.rootViewController = TabletShellViewController(context: context, detail: navigation)
        let probe = ChatScrollProbe(window: window, chat: chat)
        probe.scrollTo = scrollTo
        self.probe = probe
        if keyboard { probe.focusComposerWhenFilled() }
    }
}

/// Sees every touch before it is delivered, for the probe.
final class HarnessWindow: UIWindow {
    var onTouch: ((UITouch) -> Void)?
    /// The last touch events, as "phase x,y view", for the tests to read.
    private(set) var events: [String] = []

    override func sendEvent(_ event: UIEvent) {
        if event.type == .touches, let touch = event.allTouches?.first {
            let point = touch.location(in: self)
            let view = touch.view.map { NSStringFromClass(type(of: $0)) } ?? "nil"
            events.append("\(touch.phase.rawValue) \(Int(point.x)),\(Int(point.y)) \(view)")
            if events.count > 40 { events.removeFirst(events.count - 40) }
            onTouch?(touch)
        }
        super.sendEvent(event)
    }
}

/// The probe's element: its value is worked out when it is read, so nothing
/// runs between reads and the app can go idle for XCUITest.
private final class ProbeElement: UIView {
    var read: (() -> String)?

    override var accessibilityValue: String? {
        get { MainActor.assumeIsolated { read?() } }
        set {}
    }
}

/// The chat list as the UI tests read it: its offset, insets and content,
/// the keyboard and the dock, and what the last finger did, sampled every
/// frame while it was down.
@MainActor
final class ChatScrollProbe: NSObject {
    private let window: HarnessWindow
    private weak var chat: UIViewController?
    private let element = ProbeElement(frame: CGRect(x: 0, y: 0, width: 2, height: 2))
    /// Runs only while a finger is down.
    private var link: CADisplayLink?
    private var timer: Timer?
    private var finger: CGPoint?
    /// Frames sampled while the current finger is down.
    private var samples: [Sample] = []
    private var lastTouch: [String: Any] = [:]
    private var touches = 0
    private var focusWhenFilled = false

    private struct Sample {
        var time: CFTimeInterval
        var fingerY: CGFloat
        var offset: CGFloat
        var keyboardTop: CGFloat
        var contentHeight: CGFloat
        var rows: Int
        var visibleMinY: CGFloat
        var tracking: Bool
        var dragging: Bool
        /// Gesture recognizers on the list that are recognizing, by class.
        var active: [String]
    }

    init(window: HarnessWindow, chat: UIViewController) {
        self.window = window
        self.chat = chat
        super.init()
        element.isAccessibilityElement = true
        element.accessibilityIdentifier = "chat-scroll-probe"
        element.isUserInteractionEnabled = false
        element.alpha = 0.02
        element.read = { [weak self] in self?.currentReport() ?? "{}" }
        window.addSubview(element)
        window.onTouch = { [weak self] touch in self?.touched(touch) }
        // Slow enough to leave the app idle in between: the composer's focus
        // once the rows are in.
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.idleTick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func focusComposerWhenFilled() {
        focusWhenFilled = true
    }

    /// How far back through the history to go once the rows are in, as a
    /// share of all there is.
    var scrollTo: CGFloat?

    private var list: ChatListView? {
        chat.flatMap { Self.subview(ChatListView.self, in: $0.view) }
    }

    private static func subview<T: UIView>(_ type: T.Type, in view: UIView) -> T? {
        for child in view.subviews {
            if let match = child as? T { return match }
            if let match = subview(type, in: child) { return match }
        }
        return nil
    }

    private func touched(_ touch: UITouch) {
        let point = touch.location(in: window)
        switch touch.phase {
        case .began:
            finger = point
            samples = []
            sample()
            if link == nil {
                let link = CADisplayLink(target: self, selector: #selector(tick))
                link.add(to: .main, forMode: .common)
                self.link = link
            }
        case .moved, .stationary:
            finger = point
        case .ended, .cancelled:
            finger = point
            sample()
            finishTouch()
            finger = nil
            link?.invalidate()
            link = nil
        default:
            break
        }
    }

    @objc private func tick() {
        if finger != nil { sample() }
    }

    private func idleTick() {
        guard let chat, let list else { return }
        window.bringSubviewToFront(element)
        if focusWhenFilled, list.collectionView.numberOfItems(inSection: 0) > 20,
           let card = Self.subview(AgentInputCardView.self, in: chat.view) {
            focusWhenFilled = false
            card.textView.becomeFirstResponder()
        }
        if let share = scrollTo, list.collectionView.numberOfItems(inSection: 0) > 20 {
            scrollTo = nil
            let collection = list.collectionView
            let maxDistance = collection.contentSize.height + collection.contentInset.top + collection.contentInset.bottom - collection.bounds.height
            collection.contentOffset.y = max(0, maxDistance) * min(1, max(0, share)) - collection.contentInset.top
        }
    }

    private func currentReport() -> String {
        guard let chat, let list else { return "{}" }
        return report(list: list, chat: chat)
    }

    private func activeRecognizers(_ collection: UICollectionView) -> [String] {
        (collection.gestureRecognizers ?? [])
            .filter { $0.state == .began || $0.state == .changed }
            .map { NSStringFromClass(type(of: $0)) }
    }

    private func keyboardTop(_ chat: UIViewController) -> CGFloat {
        chat.view.convert(chat.view.keyboardLayoutGuide.layoutFrame, to: window).minY
    }

    private func sample() {
        guard let chat, let list, let finger else { return }
        let collection = list.collectionView
        samples.append(Sample(
            time: CACurrentMediaTime(), fingerY: finger.y, offset: collection.contentOffset.y, keyboardTop: keyboardTop(chat),
            contentHeight: collection.contentSize.height, rows: collection.numberOfItems(inSection: 0), visibleMinY: list.visibleMinY,
            tracking: collection.isTracking, dragging: collection.isDragging,
            active: activeRecognizers(collection)
        ))
    }

    /// What the finger did, from its samples: how far it, the content and
    /// the keyboard travelled, in total and over the frames where the
    /// keyboard moved.
    private func finishTouch() {
        guard let first = samples.first, let last = samples.last else { return }
        touches += 1
        var fingerWithKeyboard: CGFloat = 0
        var offsetWithKeyboard: CGFloat = 0
        for (previous, next) in zip(samples, samples.dropFirst()) where abs(next.keyboardTop - previous.keyboardTop) > 0.01 {
            fingerWithKeyboard += next.fingerY - previous.fingerY
            offsetWithKeyboard += next.offset - previous.offset
        }
        var recognizers = Set<String>()
        var tracking = false
        var dragging = false
        for sample in samples {
            recognizers.formUnion(sample.active)
            tracking = tracking || sample.tracking
            dragging = dragging || sample.dragging
        }
        var touch: [String: Any] = [:]
        touch["index"] = touches
        touch["samples"] = samples.count
        touch["fingerTravel"] = last.fingerY - first.fingerY
        touch["offsetTravel"] = last.offset - first.offset
        touch["keyboardTravel"] = last.keyboardTop - first.keyboardTop
        touch["fingerTravelWithKeyboard"] = fingerWithKeyboard
        touch["offsetTravelWithKeyboard"] = offsetWithKeyboard
        touch["rowsStart"] = first.rows
        touch["rowsEnd"] = last.rows
        touch["contentStart"] = first.contentHeight
        touch["contentEnd"] = last.contentHeight
        touch["tracking"] = tracking
        touch["dragging"] = dragging
        touch["recognizers"] = recognizers.sorted()
        lastTouch = touch
        var trace: [String] = []
        for sample in samples {
            let fields: [String] = [
                "\(sample.time)", "\(sample.fingerY)", "\(sample.offset)", "\(sample.keyboardTop)",
                "\(sample.contentHeight)", "\(sample.rows)", "\(sample.visibleMinY)",
            ]
            trace.append(fields.joined(separator: ","))
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("touch-\(touches).csv")
        try? (["time,fingerY,offset,keyboardTop,contentHeight,rows,visibleMinY"] + trace)
            .joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func rect(_ rect: CGRect?) -> [CGFloat]? {
        rect.map { [$0.minX, $0.minY, $0.width, $0.height] }
    }

    private func report(list: ChatListView, chat: UIViewController) -> String {
        let collection = list.collectionView
        let inset = collection.contentInset
        let dock = Self.subview(ChatDockView.self, in: chat.view)
        var value: [String: Any] = [:]
        value["offset"] = collection.contentOffset.y
        value["visibleMinY"] = list.visibleMinY
        // How far back the reader can go.
        value["maxDistance"] = max(0, collection.contentSize.height + inset.top + inset.bottom - list.bounds.height)
        value["contentHeight"] = collection.contentSize.height
        value["rows"] = collection.numberOfItems(inSection: 0)
        value["newestInset"] = inset.top
        value["oldestInset"] = inset.bottom
        let safe = chat.view.safeAreaInsets
        value["safeArea"] = [safe.top, safe.left, safe.bottom, safe.right]
        value["list"] = rect(list.convert(list.bounds, to: window)) as Any
        value["listSize"] = [list.bounds.width, list.bounds.height]
        value["dockMinY"] = dock.map { $0.convert($0.bounds, to: window).minY } as Any
        value["keyboardTop"] = keyboardTop(chat)
        value["window"] = [window.bounds.width, window.bounds.height]
        value["tracking"] = collection.isTracking
        value["dragging"] = collection.isDragging
        value["decelerating"] = collection.isDecelerating
        value["fingerDown"] = finger != nil
        value["lastTouch"] = lastTouch
        value["events"] = window.events
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}
#endif
