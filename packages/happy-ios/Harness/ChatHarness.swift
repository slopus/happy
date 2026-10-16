#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit

/// A debug app for the chat's UI tests (`Tests/HappyChatUITests`): one
/// fixture chat under the app's own root (`TabletShellViewController` over a
/// navigation), offline, signed in with a throwaway account. Gestures need a
/// separate process to drive them, and the real app can't open a chat
/// without an account.
///
/// Launch arguments: `-fixture <name>` picks the chat (`long` by default);
/// `-keyboard` opens the keyboard once the rows are in; `-flash` keeps the
/// scroll indicator showing while no finger is down, so a test can press on
/// it.
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

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        Fonts.registerBundledFonts()
        let window = HarnessWindow(windowScene: scene)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        self.window = window
        let arguments = ProcessInfo.processInfo.arguments
        let fixture = arguments.firstIndex(of: "-fixture").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } ?? FixtureScenario.long.rawValue
        Task { await self.open(fixture: fixture, in: window, keyboard: arguments.contains("-keyboard"), flash: arguments.contains("-flash")) }
    }

    private func open(fixture: String, in window: HarnessWindow, keyboard: Bool, flash: Bool) async {
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
        let probe = ChatScrollProbe(window: window, chat: chat, flash: flash)
        self.probe = probe
        if keyboard { probe.focusComposerWhenFilled() }
    }
}

/// Sees every touch before it is delivered, for the probe.
final class HarnessWindow: UIWindow {
    var onTouch: ((UITouch) -> Void)?

    override func sendEvent(_ event: UIEvent) {
        if event.type == .touches, let touch = event.allTouches?.first {
            onTouch?(touch)
        }
        super.sendEvent(event)
    }
}

/// The chat list as the UI tests read it, sampled every frame: its offset,
/// insets and content, UIKit's indicator and where `ChatScrollIndicatorLayout`
/// says it must be, the keyboard and the dock, and what the last finger did.
@MainActor
final class ChatScrollProbe: NSObject {
    private let window: HarnessWindow
    private weak var chat: UIViewController?
    private let flash: Bool
    private let element = UIView(frame: CGRect(x: 0, y: 0, width: 2, height: 2))
    private var link: CADisplayLink?
    private var finger: CGPoint?
    private var lastFlash = CACurrentMediaTime()
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
        var indicator: CGRect?
        var tracking: Bool
        var dragging: Bool
        /// Gesture recognizers on the list and its indicators that are
        /// recognizing, by class.
        var active: [String]
    }

    init(window: HarnessWindow, chat: UIViewController, flash: Bool) {
        self.window = window
        self.chat = chat
        self.flash = flash
        super.init()
        element.isAccessibilityElement = true
        element.accessibilityIdentifier = "chat-scroll-probe"
        element.isUserInteractionEnabled = false
        element.alpha = 0.02
        window.addSubview(element)
        window.onTouch = { [weak self] touch in self?.touched(touch) }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func focusComposerWhenFilled() {
        focusWhenFilled = true
    }

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
        case .moved, .stationary:
            finger = point
        case .ended, .cancelled:
            finger = point
            sample()
            finishTouch()
            finger = nil
        default:
            break
        }
    }

    @objc private func tick() {
        guard let chat, let list else { return }
        window.bringSubviewToFront(element)
        if focusWhenFilled, list.collectionView.numberOfItems(inSection: 0) > 20,
           let card = Self.subview(AgentInputCardView.self, in: chat.view) {
            focusWhenFilled = false
            card.textView.becomeFirstResponder()
        }
        if finger != nil {
            sample()
        } else if flash, CACurrentMediaTime() - lastFlash > 0.4 {
            lastFlash = CACurrentMediaTime()
            list.collectionView.flashScrollIndicators()
        }
        element.accessibilityValue = report(list: list, chat: chat)
    }

    /// UIKit's vertical indicator, as it shows on screen in `view`.
    private func indicator(_ list: ChatListView, in view: UIView) -> (frame: CGRect, alpha: CGFloat)? {
        let found = list.collectionView.subviews
            .filter { NSStringFromClass(type(of: $0)).contains("ScrollIndicator") }
            .first { $0.bounds.height > $0.bounds.width }
        return found.map { (view.convert($0.bounds, from: $0), $0.alpha) }
    }

    private func activeRecognizers(_ collection: UICollectionView) -> [String] {
        var views: [UIView] = [collection]
        for view in collection.subviews where NSStringFromClass(type(of: view)).contains("Indicator") {
            views.append(view)
        }
        var names: [String] = []
        for view in views {
            for recognizer in view.gestureRecognizers ?? [] where recognizer.state == .began || recognizer.state == .changed {
                names.append(NSStringFromClass(type(of: recognizer)))
            }
        }
        return names
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
            indicator: indicator(list, in: window)?.frame,
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
        var maxIndicatorGap: CGFloat = 0
        if let grab = samples.first(where: { $0.indicator != nil }), let grabFrame = grab.indicator {
            // How far the indicator strayed from the finger once it had it.
            let hold = grabFrame.midY - grab.fingerY
            for sample in samples where sample.time - grab.time > 0.7 {
                if let frame = sample.indicator {
                    maxIndicatorGap = max(maxIndicatorGap, abs(frame.midY - sample.fingerY - hold))
                }
            }
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
        touch["maxIndicatorGap"] = maxIndicatorGap
        touch["tracking"] = tracking
        touch["dragging"] = dragging
        touch["recognizers"] = recognizers.sorted()
        lastTouch = touch
        var trace: [String] = []
        for sample in samples {
            let indicator = sample.indicator.map { "\($0.minY),\($0.height)" } ?? ","
            let fields: [String] = [
                "\(sample.time)", "\(sample.fingerY)", "\(sample.offset)", "\(sample.keyboardTop)",
                "\(sample.contentHeight)", "\(sample.rows)", "\(sample.visibleMinY)", indicator,
            ]
            trace.append(fields.joined(separator: ","))
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("touch-\(touches).csv")
        try? (["time,fingerY,offset,keyboardTop,contentHeight,rows,visibleMinY,indicatorY,indicatorHeight"] + trace)
            .joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    }

    private func rect(_ rect: CGRect?) -> [CGFloat]? {
        rect.map { [$0.minX, $0.minY, $0.width, $0.height] }
    }

    private func report(list: ChatListView, chat: UIViewController) -> String {
        let collection = list.collectionView
        let indicatorInsets = collection.verticalScrollIndicatorInsets
        let model = ChatScrollIndicatorLayout(.init(
            viewport: list.bounds.size, contentHeight: collection.contentSize.height,
            newestInset: collection.contentInset.top, oldestInset: collection.contentInset.bottom,
            // Flipped: the collection view's top is the screen's bottom.
            indicatorInsets: ChatIndicatorInsets(newest: indicatorInsets.top, oldest: indicatorInsets.bottom, side: indicatorInsets.right),
            distanceFromNewest: list.visibleMinY, scale: list.traitCollection.displayScale
        ))
        let actual = indicator(list, in: list)
        let dock = Self.subview(ChatDockView.self, in: chat.view)
        var value: [String: Any] = [:]
        value["offset"] = collection.contentOffset.y
        value["visibleMinY"] = list.visibleMinY
        value["maxDistance"] = model.maxDistance
        value["contentHeight"] = collection.contentSize.height
        value["rows"] = collection.numberOfItems(inSection: 0)
        value["newestInset"] = collection.contentInset.top
        value["oldestInset"] = collection.contentInset.bottom
        value["indicatorInsets"] = [indicatorInsets.top, indicatorInsets.bottom, indicatorInsets.right]
        value["autoIndicatorInsets"] = collection.automaticallyAdjustsScrollIndicatorInsets
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
        value["expected"] = rect(model.frame) as Any
        value["lastTouch"] = lastTouch
        if let actual {
            value["actual"] = rect(actual.frame)
            value["actualAlpha"] = actual.alpha
            value["actualInWindow"] = rect(list.convert(actual.frame, to: window))
            value["distanceForActual"] = model.distanceFromNewest(indicatorMinY: actual.frame.minY)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}
#endif
