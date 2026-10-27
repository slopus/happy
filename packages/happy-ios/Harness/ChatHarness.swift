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
/// of an element named `chat-scroll-probe`. With `-hideKeyboardButton`, an
/// invisible button named `harness-end-editing` under the navigation bar's
/// right end puts the keyboard away without a gesture.
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
    #if DEBUG || HAPPY_FIXTURES
    private var homeRenderer: HomeRendererHarness?
    private var realArchive: RealArchiveHarness?
    private var qaProbe: ChatUltraQAProbe?
    private var motionScript: ChatMotionScript?
    private var qaReal: ChatUltraQAReal?
    private var stories: StoriesHarness?
    #endif

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        Fonts.registerBundledFonts()
        let window = HarnessWindow(windowScene: scene)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        self.window = window
        let arguments = ProcessInfo.processInfo.arguments
        #if DEBUG || HAPPY_FIXTURES
        if arguments.contains("-qaRealChat") {
            qaReal = ChatUltraQAReal(window: window)
            return
        }
        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "stories" {
            stories = StoriesHarness(window: window)
            return
        }
        if arguments.contains("-real-archive") {
            realArchive = RealArchiveHarness(window: window)
            return
        }
        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "home" {
            homeRenderer = HomeRendererHarness(window: window, arguments: arguments)
            return
        }
        #endif
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
        controller.localSettings.chatListRenderer = ProcessInfo.processInfo.arguments.contains("-chatUltraList") ? .ultraList : .collectionView
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
        #if DEBUG || HAPPY_FIXTURES
        if ProcessInfo.processInfo.arguments.contains("-qaProbe") { qaProbe = ChatUltraQAProbe(window: window, chat: chat) }
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "-qaScript"), arguments.indices.contains(index + 1) {
            let run = arguments.firstIndex(of: "-qaRun").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } ?? "script"
            motionScript = ChatMotionScript(chat: chat, name: arguments[index + 1], run: run)
        }
        #endif
        if keyboard { probe.focusComposerWhenFilled() }
    }
}

/// Sees every touch before it is delivered, for the probe.
final class HarnessWindow: UIWindow {
    var onTouch: ((UITouch) -> Void)?
    /// Handler completion is separate from the display frame it schedules.
    var afterTouch: ((UITouch) -> Void)?
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
        if event.type == .touches, let touch = event.allTouches?.first {
            afterTouch?(touch)
        }
    }
}

/// The probe's element: its value is worked out when it is read, so nothing
/// runs between reads and the app can go idle for XCUITest.
final class ProbeElement: UIView {
    var read: (() -> String)?

    override var accessibilityValue: String? {
        get { MainActor.assumeIsolated { read?() } }
        set {}
    }
}

/// The chat list as the UI tests read it: its offset, insets and content,
/// the keyboard and the dock, and what the last finger did, sampled every
/// frame while it was down and for a moment after it lifted.
///
/// The keyboard's top is the one the dock sits on: the layout guide's, or
/// on UltraList what UltraView's keyboard controller reports, since the
/// controller moves the keyboard without the guide.
@MainActor
final class ChatScrollProbe: NSObject {
    private let window: HarnessWindow
    private weak var chat: UIViewController?
    private let element = ProbeElement(frame: CGRect(x: 0, y: 0, width: 2, height: 2))
    private let endEditing = UIButton(type: .custom)
    /// Runs only while a finger is down, and for `releaseDuration` after.
    private var link: CADisplayLink?
    /// What happens after the finger lifts: the keyboard's release.
    private var releaseSamples: [Sample] = []
    private var releaseEnd: CFTimeInterval?
    private static let releaseDuration: CFTimeInterval = 0.6
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
        /// The dock's top as drawn, while it animates too.
        var dockPresentedMinY: CGFloat
        /// UltraView's keyboard controller owned the keyboard.
        var driving: Bool
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
        if ProcessInfo.processInfo.arguments.contains("-hideKeyboardButton") {
            endEditing.frame = CGRect(x: window.bounds.width - 44, y: window.safeAreaInsets.top + 52, width: 44, height: 44)
            endEditing.alpha = 0.02
            endEditing.backgroundColor = .black
            endEditing.accessibilityIdentifier = "harness-end-editing"
            endEditing.addAction(UIAction { [weak window] _ in window?.endEditing(true) }, for: .touchUpInside)
            window.addSubview(endEditing)
        }
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
            finishRelease()
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
            releaseSamples = []
            releaseEnd = CACurrentMediaTime() + Self.releaseDuration
        default:
            break
        }
    }

    @objc private func tick() {
        if finger != nil {
            sample()
        } else if let end = releaseEnd {
            if let sample = makeSample() { releaseSamples.append(sample) }
            if CACurrentMediaTime() >= end { finishRelease() }
        }
    }

    private func idleTick() {
        guard let chat, let list else { return }
        window.bringSubviewToFront(element)
        if endEditing.superview != nil { window.bringSubviewToFront(endEditing) }
        if focusWhenFilled, list.plans.count > 20, list.isDisplayReady,
           let card = Self.subview(AgentInputCardView.self, in: chat.view) {
            focusWhenFilled = false
            card.textView.becomeFirstResponder()
        }
        if let share = scrollTo, list.plans.count > 20, list.isDisplayReady {
            scrollTo = nil
            list.setVisibleMinY(list.maximumVisibleMinY * min(1, max(0, share)))
        }
    }

    private func currentReport() -> String {
        guard let chat, let list else { return "{}" }
        return report(list: list, chat: chat)
    }

    private func activeRecognizers(_ view: UIView) -> [String] {
        (view.gestureRecognizers ?? [])
            .filter { $0.state == .began || $0.state == .changed }
            .map { NSStringFromClass(type(of: $0)) }
    }

    private func keyboardTop(_ chat: UIViewController) -> CGFloat {
        let guideTop = chat.view.keyboardLayoutGuide.layoutFrame.minY
        let top = (chat as? ChatViewController)?.ultraKeyboard?.keyboardTop(guideTop: guideTop) ?? guideTop
        return chat.view.convert(CGPoint(x: 0, y: top), to: window).y
    }

    /// Who moves the keyboard: UltraView's controller, the list's system
    /// interactive dismissal on UltraList, or the layout guide on
    /// UICollectionView.
    private func keyboardDriver(_ chat: UIViewController) -> String {
        guard let keyboard = (chat as? ChatViewController)?.ultraKeyboard else { return "guide" }
        return keyboard.isAvailable ? "controller" : "system"
    }

    private func dockView(_ chat: UIViewController) -> ChatDockView? {
        Self.subview(ChatDockView.self, in: chat.view)
    }

    private func makeSample() -> Sample? {
        guard let chat, let list else { return nil }
        let dock = dockView(chat)
        let presented = dock.map { ($0.layer.presentation() ?? $0.layer).frame.minY } ?? .nan
        return Sample(
            time: CACurrentMediaTime(), fingerY: finger?.y ?? .nan, offset: list.scrollOffset, keyboardTop: keyboardTop(chat),
            contentHeight: list.contentHeight, rows: list.plans.count, visibleMinY: list.visibleMinY,
            tracking: list.isTracking, dragging: list.isDragging,
            active: activeRecognizers(list.scrollGestureView),
            dockPresentedMinY: dock?.superview.map { $0.convert(CGPoint(x: 0, y: presented), to: window).y } ?? .nan,
            driving: (chat as? ChatViewController)?.ultraKeyboard?.isDriving ?? false
        )
    }

    private func sample() {
        guard finger != nil, let sample = makeSample() else { return }
        samples.append(sample)
    }

    /// The moment after the finger lifted: whether the keyboard's
    /// controller still owned it, and how the dock and the keyboard moved,
    /// frame by frame.
    private func finishRelease() {
        guard releaseEnd != nil else { return }
        releaseEnd = nil
        link?.invalidate()
        link = nil
        guard let first = releaseSamples.first, let last = releaseSamples.last else { return }
        var moves = 0
        for (previous, next) in zip(releaseSamples, releaseSamples.dropFirst()) where abs(next.dockPresentedMinY - previous.dockPresentedMinY) > 0.25 {
            moves += 1
        }
        func finite(_ value: CGFloat) -> Any { value.isFinite ? value : NSNull() }
        var release: [String: Any] = [:]
        release["samples"] = releaseSamples.count
        release["driving"] = releaseSamples.contains { $0.driving }
        release["dockStart"] = finite(first.dockPresentedMinY)
        release["dockEnd"] = finite(last.dockPresentedMinY)
        release["dockFramesMoved"] = moves
        release["keyboardStart"] = first.keyboardTop
        release["keyboardEnd"] = last.keyboardTop
        lastTouch["release"] = release
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
        touch["keyboardDriven"] = samples.contains { $0.driving }
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
        let inset = list.contentInsets
        let dock = dockView(chat)
        var value: [String: Any] = [:]
        value["offset"] = list.scrollOffset
        value["visibleMinY"] = list.visibleMinY
        // How far back the reader can go.
        value["maxDistance"] = list.maximumVisibleMinY
        value["contentHeight"] = list.contentHeight
        value["rows"] = list.isDisplayReady ? list.plans.count : 0
        value["renderer"] = list.renderer.rawValue
        value["newestInset"] = inset.top
        value["oldestInset"] = inset.bottom
        let safe = chat.view.safeAreaInsets
        value["safeArea"] = [safe.top, safe.left, safe.bottom, safe.right]
        value["list"] = rect(list.convert(list.bounds, to: window)) as Any
        value["listSize"] = [list.bounds.width, list.bounds.height]
        value["dockMinY"] = dock.map { $0.convert($0.bounds, to: window).minY } as Any
        value["dockMaxY"] = dock.map { $0.convert($0.bounds, to: window).maxY } as Any
        value["keyboardTop"] = keyboardTop(chat)
        value["keyboard"] = keyboardDriver(chat)
        value["window"] = [window.bounds.width, window.bounds.height]
        value["tracking"] = list.isTracking
        value["dragging"] = list.isDragging
        value["decelerating"] = list.isDecelerating
        value["fingerDown"] = finger != nil
        value["lastTouch"] = lastTouch
        value["events"] = window.events
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}
#endif
