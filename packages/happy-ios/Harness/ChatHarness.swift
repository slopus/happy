#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import UltraView

/// A debug app for the chat's UI tests (`Tests/HappyChatUITests`): one
/// fixture chat under the app's own root (`ShellViewController` over a
/// navigation), offline, signed in with a throwaway account. Gestures need a
/// separate process to drive them, and the real app can't open a chat
/// without an account.
///
/// Launch arguments: `-fixture <name>` picks the chat (`long` by default);
/// `-keyboard` opens the keyboard once the rows are in; `-scrollTo
/// <fraction>` goes that far back through the history once the rows are
/// in; `-qaLandscape` turns the window on its side.
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
        application.isIdleTimerDisabled = true
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
    private var agent: AgentHarness?
    private var agentList: AgentListScrollHarness?
    private var composerKeyboardProbe: ComposerKeyboardProbe?
    private var realArchive: RealArchiveHarness?
    private var qaProbe: ChatUltraQAProbe?
    private var motionScript: ChatMotionScript?
    private var keyboardScript: ChatKeyboardScript?
    private var qaReal: ChatUltraQAReal?
    private var homeControllerScroll: HomeControllerScrollHarness?
    private var homeScrollDiagnostic: HomeScrollDiagnosticHarness?
    private var groupedHome: GroupedHomeHarness?
    private var chatHeader: ChatHeaderHarness?
    private var avatarSpeeds: AvatarSpeedHarness?
    private var agentChat: AgentChatHarness?
    private var agentFeed: AgentFeedHarness?
    private var agentTools: AgentToolsHarness?
    private var splitApp: SplitAppHarness?
    #endif

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        LegacyFonts.registerBundledFonts()
        let window = HarnessWindow(windowScene: scene)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        self.window = window
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("-chatDark") { window.overrideUserInterfaceStyle = .dark }
        if arguments.contains("-chatLight") { window.overrideUserInterfaceStyle = .light }
        #if DEBUG || HAPPY_FIXTURES
        if arguments.contains("-homeScrollDiagnostic") {
            homeScrollDiagnostic = HomeScrollDiagnosticHarness(window: window, arguments: arguments)
            return
        }
        if arguments.contains("-composerKeyboardProbe") {
            composerKeyboardProbe = ComposerKeyboardProbe(window: window, arguments: arguments)
        }
        if arguments.contains("-fullHomeScroll") {
            homeControllerScroll = HomeControllerScrollHarness(window: window)
            return
        }
        if arguments.contains("-qaRealChat") {
            qaReal = ChatUltraQAReal(window: window)
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
        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "agent",
           let socket = arguments.firstIndex(of: "-agentSocket").map({ arguments[$0 + 1] }),
           let token = arguments.firstIndex(of: "-agentToken").map({ arguments[$0 + 1] }) ?? ProcessInfo.processInfo.environment["HAPPY_AGENT_FIXTURE_TOKEN"] {
            agent = AgentHarness(window: window, socket: socket, token: token)
            return
        }
        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "agentList" {
            agentList = AgentListScrollHarness(window: window, arguments: arguments)
            return
        }
        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "groupedHome" {
            groupedHome = GroupedHomeHarness(window: window, arguments: arguments)
            return
        }
        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "avatarSpeeds" {
            avatarSpeeds = AvatarSpeedHarness(window: window, arguments: arguments)
            return
        }
        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "split" {
            splitApp = SplitAppHarness(window: window, arguments: arguments)
            return
        }
        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "chatHeader" {
            chatHeader = ChatHeaderHarness(window: window, arguments: arguments)
            return
        }
        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "agentTools" {
            agentTools = AgentToolsHarness(window: window, arguments: arguments)
            return
        }
        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "agentChat" {
            agentChat = AgentChatHarness(window: window, arguments: arguments)
            return
        }
        if let index = arguments.firstIndex(of: "-screen"), arguments.indices.contains(index + 1), arguments[index + 1] == "agentFeed" {
            agentFeed = AgentFeedHarness(window: window, arguments: arguments)
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
        let context = AppContext(account: controller, variant: .development, version: "harness")
        let chat = LegacyChatViewController(context: context, session: account, sessionId: FixtureScenarios.prefix + fixture)
        let home = UIViewController()
        home.title = "Chats"
        home.view.backgroundColor = .systemBackground
        let navigation = UINavigationController(rootViewController: home)
        navigation.pushViewController(chat, animated: false)
        window.rootViewController = ShellViewController(context: context, phone: navigation)
        if ProcessInfo.processInfo.arguments.contains("-qaLandscape") {
            // A run without UI automation can't turn the phone.
            window.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight))
        }
        let probe = ChatScrollProbe(window: window, chat: chat)
        probe.scrollTo = scrollTo
        self.probe = probe
        #if DEBUG || HAPPY_FIXTURES
        if ProcessInfo.processInfo.arguments.contains("-qaProbe") { qaProbe = ChatUltraQAProbe(window: window, chat: chat) }
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "-qaScript"), arguments.indices.contains(index + 1) {
            let run = arguments.firstIndex(of: "-qaRun").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } ?? "script"
            if arguments[index + 1] == "keyboard" { keyboardScript = ChatKeyboardScript(chat: chat, run: run) }
            else { motionScript = ChatMotionScript(chat: chat, name: arguments[index + 1], run: run) }
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
    /// Runs while a finger is down, after its release and through any
    /// keyboard animation that follows it.
    private var link: CADisplayLink?
    /// What happens after the finger lifts: the keyboard's release.
    private var releaseSamples: [Sample] = []
    private var releaseEnd: CFTimeInterval?
    private static let releaseDuration: CFTimeInterval = 0.6
    private var timer: Timer?
    private var finger: CGPoint?
    /// The finger itself, for the recognizers it reaches.
    private weak var currentTouch: UITouch?
    /// Every recognizer the finger reached, window to list, and each state
    /// it was seen in, in order: a pan the split view or the swipe back
    /// cancelled or held shows here.
    private var path: [(name: String, recognizer: UIGestureRecognizer, states: [String])] = []
    /// Frames sampled while the current finger is down. The first is taken
    /// as the finger lands, before the window hands it on; the second just
    /// after, once the list's pan has caught any glide.
    private var samples: [Sample] = []
    /// Where the list was drawn as the finger landed, and where its pan
    /// stopped it, in the scroll host's bounds: a glide caught under the
    /// finger runs on to the frame the screen already had in hand.
    private var landedAt: CGFloat?
    private var caughtAt: CGFloat?
    private var caughtIndex = 0
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
        /// The list had the system's hidden interactive keyboard input,
        /// whose pan runs beside the list's on every drag.
        var systemInput: Bool
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
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardMotion(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
        let previousAfter = window.afterTouch
        window.afterTouch = { [weak self] touch in
            previousAfter?(touch)
            self?.delivered(touch)
        }
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

    /// Either chat's list: the sessions' chat's `ChatListView`, or the
    /// agents' transcript.
    private var list: (any ProbedChatList)? {
        guard let chat else { return nil }
        if let agent = chat as? ChatViewController {
            return Self.subview(AgentChatUltraList.self, in: agent.view).map { AgentProbedList(chat: agent, transcript: $0) }
        }
        return Self.subview(ChatListView.self, in: chat.view)
    }

    /// The list's keyboard, in either chat.
    private func ultraKeyboard(_ chat: UIViewController) -> ChatUltraKeyboard? {
        (chat as? LegacyChatViewController)?.ultraKeyboard ?? (chat as? ChatViewController)?.ultraKeyboard
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
            currentTouch = touch
            path = []
            samples = []
            landedAt = list.map { ($0.scrollGestureView.layer.presentation() ?? $0.scrollGestureView.layer).bounds.minY }
            caughtAt = nil
            caughtIndex = 0
            sample()
            startSampling()
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

    private func startSampling() {
        guard link == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    /// The first keyboard after a simulator boots can start showing after
    /// the tap's release window has already elapsed. Observe its actual
    /// animation, retaining any controller motion sampled before it.
    @objc private func keyboardMotion(_ notification: Notification) {
        guard finger == nil, !lastTouch.isEmpty else { return }
        let duration = notification.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0
        lastTouch.removeValue(forKey: "release")
        releaseEnd = max(releaseEnd ?? 0, CACurrentMediaTime() + max(Self.releaseDuration, duration))
        startSampling()
    }

    /// The window has handed the landing finger to the recognizers: the
    /// list's pan has caught a glide by now, wherever UIKit asked it to.
    private func delivered(_ touch: UITouch) {
        guard touch.phase == .began, touch === currentTouch, caughtAt == nil else { return }
        caughtAt = list?.scrollGestureView.layer.bounds.minY
        caughtIndex = samples.count
        sample()
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
        if focusWhenFilled, list.rows > 20, list.isDisplayReady,
           let card = Self.subview(AgentInputCardView.self, in: chat.view) {
            focusWhenFilled = false
            card.textView.becomeFirstResponder()
        }
        if let share = scrollTo, list.rows > 20, list.isDisplayReady {
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
        let top = ultraKeyboard(chat)?.keyboardTop(guideTop: guideTop) ?? guideTop
        return chat.view.convert(CGPoint(x: 0, y: top), to: window).y
    }

    /// Who moves the keyboard: UltraView's controller, the list's system
    /// interactive dismissal, or the layout guide while docked.
    private func keyboardDriver(_ chat: UIViewController) -> String {
        guard let keyboard = ultraKeyboard(chat) else { return "guide" }
        return keyboard.isAvailable ? "controller" : "system"
    }

    /// What sits on the keyboard: the sessions' chat's dock, the agents'
    /// card.
    private func dockView(_ chat: UIViewController) -> UIView? {
        (chat as? ChatViewController)?.card ?? Self.subview(ChatDockView.self, in: chat.view)
    }

    private func makeSample() -> Sample? {
        guard let chat, let list else { return nil }
        let dock = dockView(chat)
        let presented = dock.map { ($0.layer.presentation() ?? $0.layer).frame.minY } ?? .nan
        return Sample(
            time: CACurrentMediaTime(), fingerY: finger?.y ?? .nan, offset: list.scrollOffset, keyboardTop: keyboardTop(chat),
            contentHeight: list.contentHeight, rows: list.rows, visibleMinY: list.visibleMinY,
            tracking: list.isTracking, dragging: list.isDragging,
            active: activeRecognizers(list.scrollGestureView),
            dockPresentedMinY: dock?.superview.map { $0.convert(CGPoint(x: 0, y: presented), to: window).y } ?? .nan,
            driving: ultraKeyboard(chat)?.isDriving ?? false,
            systemInput: list.hasKeyboardInput
        )
    }

    private func sample() {
        guard finger != nil, let sample = makeSample() else { return }
        samples.append(sample)
        notePath()
    }

    private static func name(_ state: UIGestureRecognizer.State) -> String {
        switch state {
        case .possible: "possible"
        case .began: "began"
        case .changed: "changed"
        case .ended: "ended"
        case .cancelled: "cancelled"
        case .failed: "failed"
        @unknown default: "?"
        }
    }

    private func notePath() {
        for recognizer in currentTouch?.gestureRecognizers ?? [] {
            let state = Self.name(recognizer.state)
            if let index = path.firstIndex(where: { $0.recognizer === recognizer }) {
                if path[index].states.last != state { path[index].states.append(state) }
            } else {
                let host = recognizer.view.map { NSStringFromClass(type(of: $0)) } ?? "nil"
                path.append(("\(NSStringFromClass(type(of: recognizer))) on \(host)", recognizer, [state]))
            }
        }
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
    /// keyboard moved. The finger and the content are measured from where
    /// the pan caught the list; how far a caught glide ran on, and whether
    /// the list then held still under the resting finger, separately.
    private func finishTouch() {
        guard let landed = samples.first, let last = samples.last else { return }
        let start = samples.indices.contains(caughtIndex) ? caughtIndex : 0
        let first = samples[start]
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
        touch["offsetTravelFromLanding"] = last.offset - landed.offset
        if let landedAt, let caughtAt { touch["catchTravel"] = caughtAt - landedAt }
        // Until the finger first moves, the caught list stays put.
        let resting = samples[start...].prefix { $0.fingerY == first.fingerY }
        touch["restingSamples"] = resting.count
        touch["restingDrift"] = resting.map { abs($0.offset - first.offset) }.max() ?? 0
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
        // The last states too, which the finger's lifting settles.
        for index in path.indices {
            let state = Self.name(path[index].recognizer.state)
            if path[index].states.last != state { path[index].states.append(state) }
        }
        touch["path"] = path.map { "\($0.name): \($0.states.joined(separator: ">"))" }
        touch["keyboardDriven"] = samples.contains { $0.driving }
        touch["systemInput"] = samples.contains { $0.systemInput }
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

    /// Rows hiding their drawing for a lifted copy: none once it is back.
    private func liftedRows(_ chat: UIViewController) -> Int {
        var count = 0
        func walk(_ view: UIView) {
            if let row = view as? AgentChatRowView, row.isLifted { count += 1 }
            if let row = view as? ChatUltraRowView, row.isLifted { count += 1 }
            view.subviews.forEach(walk)
        }
        walk(chat.view)
        return count
    }

    private func rect(_ rect: CGRect?) -> [CGFloat]? {
        rect.map { [$0.minX, $0.minY, $0.width, $0.height] }
    }

    private func report(list: any ProbedChatList, chat: UIViewController) -> String {
        let dock = dockView(chat)
        var value: [String: Any] = [:]
        value["offset"] = list.scrollOffset
        value["visibleMinY"] = list.visibleMinY
        // How far back the reader can go.
        value["maxDistance"] = list.maximumVisibleMinY
        value["contentHeight"] = list.contentHeight
        value["rows"] = list.isDisplayReady ? list.rows : 0
        value["renderer"] = "UltraList"
        value["chat"] = chat is ChatViewController ? "agent" : "session"
        value["newestInset"] = list.newestInset
        value["oldestInset"] = list.oldestInset
        let safe = chat.view.safeAreaInsets
        value["safeArea"] = [safe.top, safe.left, safe.bottom, safe.right]
        value["list"] = rect(list.listView.convert(list.listView.bounds, to: window)) as Any
        value["listSize"] = [list.listView.bounds.width, list.listView.bounds.height]
        value["dockMinY"] = dock.map { $0.convert($0.bounds, to: window).minY } as Any
        value["dockMaxY"] = dock.map { $0.convert($0.bounds, to: window).maxY } as Any
        // How far over the keyboard (or the safe area) the dock stands: the
        // agents' card keeps the gap under it (`ChatScreenLayout`).
        if let agent = chat as? ChatViewController {
            value["dockBelow"] = agent.meter.isHidden ? ChatScreenLayout.Metrics.paddingBottom : ContextMeterLayout.Metrics.height
        } else {
            value["dockBelow"] = 0
        }
        value["keyboardTop"] = keyboardTop(chat)
        value["keyboard"] = keyboardDriver(chat)
        value["systemInput"] = list.hasKeyboardInput
        value["window"] = [window.bounds.width, window.bounds.height]
        value["tracking"] = list.isTracking
        value["dragging"] = list.isDragging
        value["decelerating"] = list.isDecelerating
        value["fingerDown"] = finger != nil
        value["lastTouch"] = lastTouch
        value["events"] = window.events
        // A lifted message, what is selected in it, and what was copied.
        #if DEBUG || HAPPY_FIXTURES
        value["lift"] = MessageLiftOverlay.shown?.probe as Any
        #endif
        value["pasteboard"] = UIPasteboard.general.string as Any
        value["liftedRows"] = liftedRows(chat)
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

/// What the probe reads of a chat's list.
@MainActor
protocol ProbedChatList {
    var listView: UIView { get }
    var rows: Int { get }
    var isDisplayReady: Bool { get }
    /// How far the reader is from the newest message.
    var visibleMinY: CGFloat { get }
    var maximumVisibleMinY: CGFloat { get }
    var contentHeight: CGFloat { get }
    var scrollOffset: CGFloat { get }
    var newestInset: CGFloat { get }
    var oldestInset: CGFloat { get }
    var isTracking: Bool { get }
    var isDragging: Bool { get }
    var isDecelerating: Bool { get }
    var scrollGestureView: UIView { get }
    var hasKeyboardInput: Bool { get }
    func setVisibleMinY(_ distance: CGFloat)
}

extension ChatListView: ProbedChatList {
    var hasKeyboardInput: Bool { ultra.list.hasKeyboardInput }
    var listView: UIView { self }
    var rows: Int { plans.count }
    var newestInset: CGFloat { contentInsets.top }
    var oldestInset: CGFloat { contentInsets.bottom }
}

/// The agents' transcript as the probe reads it.
@MainActor
struct AgentProbedList: ProbedChatList {
    let chat: ChatViewController
    let transcript: AgentChatUltraList
    var hasKeyboardInput: Bool { transcript.list.hasKeyboardInput }
    var listView: UIView { transcript.list }
    var rows: Int { chat.plans.count }
    var isDisplayReady: Bool { !chat.plans.isEmpty && transcript.list.loadedItemView(at: 0) != nil }
    var visibleMinY: CGFloat { transcript.distanceFromNewest }
    var maximumVisibleMinY: CGFloat { transcript.distanceFromNewest + transcript.distanceFromOldest }
    var contentHeight: CGFloat { CGFloat(transcript.list.contentHeight) }
    var scrollOffset: CGFloat { visibleMinY - newestInset }
    // Upside down: the list's top inset is the card's end.
    var newestInset: CGFloat { CGFloat(transcript.list.viewportInsets.top) }
    var oldestInset: CGFloat { CGFloat(transcript.list.viewportInsets.bottom) }
    var isTracking: Bool { transcript.list.isTracking }
    var isDragging: Bool { transcript.list.isDragging }
    var isDecelerating: Bool { transcript.list.isDecelerating }
    var scrollGestureView: UIView { transcript.list.scrollGestureHostView }
    func setVisibleMinY(_ distance: CGFloat) {
        transcript.list.scrollTo(.init(index: 0, pointOffset: -Double(distance)), transition: .none)
    }
}
#endif
