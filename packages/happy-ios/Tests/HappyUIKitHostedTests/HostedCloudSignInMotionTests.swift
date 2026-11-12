#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The accounts service as Happy Cloud's steps call it: each answer given
/// by `METHOD path`.
private actor SignInHTTP: HTTPTransport {
    var answers: [String: (Int, String)] = [:]
    func answer(_ path: String, _ status: Int, _ body: String) { answers[path] = (status, body) }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let (status, body) = answers["\(request.method) \(request.url.path)"] ?? (404, #"{"code":"not_found","error":"Not found."}"#)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}

/// A cloud server's daemon with no profile for the member yet.
private actor NamelessDaemon: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        if path == "/v0/health" { return HTTP1Response(status: 200, body: Data(#"{"ready":true}"#.utf8)) }
        if path == "/v0/profile" { return HTTP1Response(status: 200, body: Data(#"{"profile":{"name":"Steve K","updatedAt":0,"version":"v0"}}"#.utf8)) }
        return HTTP1Response(status: 200, body: Data("{}".utf8))
    }
    func browserConnection() async throws -> any BrowserStream { throw BrowserError.unavailable }
    func close() async {}
}

private func accessToken(for audience: String) -> String {
    func encode(_ object: [String: Any]) -> String {
        try! JSONSerialization.data(withJSONObject: object).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    return encode(["alg": "RS256", "typ": "JWT"]) + "." + encode(["aud": audience, "sub": "steve"]) + ".c2ln"
}

/// What a Cloud step draws on every display frame, read from the
/// presentation layers (what is on the glass): the keyboard's top and each
/// named view, in the window's coordinates, and which screen is on top.
/// With `HAPPY_STRIPS` set it also keeps each frame's picture, for strips
/// with the keyboard's top drawn in.
@MainActor
private final class CloudFrames: NSObject {
    struct Frame {
        var time: CFTimeInterval
        /// The keyboard host's top, or the window's bottom without one.
        var keyboard: CGFloat
        var rects: [String: CGRect]
        var top: UIViewController?
        var picture: UIImage?
    }

    let window: UIWindow
    var views: [String: () -> UIView?]
    weak var navigation: UINavigationController?
    private var link: CADisplayLink?
    private(set) var frames: [Frame] = []
    private(set) var sawKeyboard = false
    let keepsPictures = ProcessInfo.processInfo.environment["HAPPY_STRIPS"] != nil

    init(window: UIWindow, navigation: UINavigationController?, views: [String: () -> UIView?]) {
        self.window = window
        self.navigation = navigation
        self.views = views
    }

    /// The keyboard's notifications while sampling: when, how long, where to.
    private(set) var notes: [(time: CFTimeInterval, line: String)] = []

    @objc private func noted(_ note: Notification) {
        let duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? -1
        let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect)?.minY ?? -1
        notes.append((CACurrentMediaTime(), "\(note.name.rawValue.replacingOccurrences(of: "UIKeyboard", with: "")) duration=\(duration) endTop=\(end)"))
    }

    /// When sampling started, on the wall clock: where it is in a recording.
    private(set) var startedAt: TimeInterval = 0

    func start() {
        frames = []
        notes = []
        startedAt = Date().timeIntervalSince1970
        NotificationCenter.default.removeObserver(self)
        for name in [UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardDidChangeFrameNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(noted(_:)), name: name, object: nil)
        }
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
        tick()
    }

    func stop() {
        tick()
        link?.invalidate()
        link = nil
        NotificationCenter.default.removeObserver(self)
    }

    /// Samples while `action` runs and for `seconds` after it.
    func sample(seconds: Double = 1.2, _ action: () async -> Void) async {
        start()
        try? await Task.sleep(for: .milliseconds(50))
        await action()
        try? await Task.sleep(for: .milliseconds(Int(seconds * 1000)))
        stop()
    }

    @objc private func tick() {
        var rects: [String: CGRect] = [:]
        for (name, view) in views {
            if let view = view(), view.window === window, !view.isHidden, let rect = presented(view) { rects[name] = rect }
        }
        var picture: UIImage?
        if keepsPictures {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            picture = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
            }
        }
        frames.append(Frame(time: CACurrentMediaTime(), keyboard: keyboardTop(), rects: rects, top: navigation?.topViewController, picture: picture))
    }

    /// Nil until it has been drawn: a view just added has no presentation yet.
    private func presented(_ view: UIView) -> CGRect? {
        guard let layer = view.layer.presentation(), let root = window.layer.presentation() else { return nil }
        return layer.convert(layer.bounds, to: root)
    }

    private func keyboardTop() -> CGFloat {
        guard let host = KeyboardMotionSampler.keyboardHost(in: window.windowScene),
              let layer = host.layer.presentation(), let root = host.window?.layer.presentation() else { return window.bounds.maxY }
        sawKeyboard = true
        let inKeyboardWindow = layer.convert(layer.bounds, to: root)
        let onScreen = inKeyboardWindow.offsetBy(dx: host.window?.frame.minX ?? 0, dy: host.window?.frame.minY ?? 0)
        return min(onScreen.minY - window.frame.minY, window.bounds.maxY)
    }

    // MARK: Reading the frames

    private func moved(_ a: CGFloat, _ b: CGFloat) -> Bool { abs(a - b) > 0.5 }

    /// The first and last frames the keyboard moved on.
    var keyboardMotion: ClosedRange<Int>? {
        let moving = frames.indices.dropFirst().filter { moved(frames[$0 - 1].keyboard, frames[$0].keyboard) }
        guard let first = moving.first, let last = moving.last else { return nil }
        return first...last
    }

    /// `name`'s frames, where it was on screen.
    func track(_ name: String) -> [(index: Int, rect: CGRect)] {
        frames.indices.compactMap { index in frames[index].rects[name].map { (index, $0) } }
    }

    /// How far `name` strayed from where it first was, in y and height.
    func drift(_ name: String) -> CGFloat {
        let track = track(name)
        guard let first = track.first?.rect else { return 0 }
        return track.map { max(abs($0.rect.minY - first.minY), abs($0.rect.height - first.height)) }.max() ?? 0
    }

    /// How far `name`'s top strayed from where it first was.
    func topDrift(_ name: String) -> CGFloat {
        let track = track(name)
        guard let first = track.first?.rect else { return 0 }
        return track.map { abs($0.rect.minY - first.minY) }.max() ?? 0
    }

    /// The first frame `name` moved on, sideways (a push or a pop) or up and down.
    func firstMove(_ name: String, sideways: Bool = false) -> Int? {
        let track = track(name)
        return track.indices.dropFirst().first { index in
            let a = track[index - 1].rect, b = track[index].rect
            return sideways ? moved(a.minX, b.minX) : moved(a.minY, b.minY)
        }.map { track[$0].index }
    }

    /// How far `name`'s bottom strayed from the keyboard's curve: on each
    /// frame it has come as much of its way as the keyboard has of its own,
    /// as one animation on the keyboard's curve and duration does. Zero
    /// while the keyboard is still.
    func offKeyboard(_ name: String) -> CGFloat {
        let track = track(name)
        guard let first = track.first, let last = track.last else { return 0 }
        let kb0 = frames[first.index].keyboard, kb1 = frames[last.index].keyboard
        let way = last.rect.maxY - first.rect.maxY
        guard abs(kb1 - kb0) > 10 else { return 0 }
        // A frame's slack: the keyboard's own animation may start a frame
        // before the step's, committed in the transaction before.
        func progress(_ index: Int) -> CGFloat { (frames[index].keyboard - kb0) / (kb1 - kb0) }
        return track.map { sample in
            let now = progress(sample.index), before = progress(max(first.index, sample.index - 1))
            let low = first.rect.maxY + way * min(now, before), high = first.rect.maxY + way * max(now, before)
            let y = sample.rect.maxY
            return y < min(low, high) ? min(low, high) - y : y > max(low, high) ? y - max(low, high) : 0
        }.max() ?? 0
    }

    /// Frames `name` still moved on after the keyboard stopped: a late snap.
    func lateMoves(_ name: String) -> Int {
        guard let motion = keyboardMotion else { return 0 }
        let track = track(name)
        return track.indices.dropFirst().filter { index in
            track[index].index > motion.upperBound + 1 && moved(track[index - 1].rect.minY, track[index].rect.minY)
        }.count
    }

    /// Times `name` turned back on its way up or down: a double animation.
    func reversals(_ name: String) -> Int {
        let ys = track(name).map(\.rect.minY)
        var direction: CGFloat = 0, turns = 0
        for (a, b) in zip(ys, ys.dropFirst()) where abs(b - a) > 0.5 {
            let now: CGFloat = b > a ? 1 : -1
            if direction != 0, now != direction { turns += 1 }
            direction = now
        }
        return turns
    }

    /// The keyboard's lowest point, against where it started and ended:
    /// above zero, it went down on the way and came back.
    var keyboardDip: CGFloat {
        guard let first = frames.first?.keyboard, let last = frames.last?.keyboard else { return 0 }
        return (frames.map(\.keyboard).max() ?? 0) - max(first, last)
    }

    /// Whether the keyboard started moving with `name`'s push or pop: no
    /// later than a frame after it, and no earlier than a frame before.
    func keyboardStartsWith(_ name: String) -> Bool {
        guard let push = firstMove(name, sideways: true), let keyboard = keyboardMotion else { return false }
        return abs(seconds(from: push, to: keyboard.lowerBound)) <= 0.05
    }

    /// The measures, one line, for the log: the keyboard's start against
    /// `moving`'s push or pop, and each of `names`' stray, late moves and
    /// turns.
    func summary(_ test: String, moving: String? = nil, _ names: [String]) -> String {
        var parts = [test, String(format: "at=%.2f", startedAt)]
        if let moving, let push = firstMove(moving, sideways: true), let keyboard = keyboardMotion {
            parts.append(String(format: "keyboardAfterPush=%.0fms", seconds(from: push, to: keyboard.lowerBound) * 1000))
        }
        parts.append(String(format: "keyboardDip=%.0f", keyboardDip))
        for name in names {
            parts.append(String(format: "%@: off=%.1f late=%d turns=%d drift=%.1f", name, offKeyboard(name), lateMoves(name), reversals(name), drift(name)))
        }
        return "CLOUD-MOTION " + parts.joined(separator: " ")
    }

    /// Seconds between frames `a` and `b`.
    func seconds(from a: Int, to b: Int) -> Double { frames[b].time - frames[a].time }

    /// Every frame as a line, for a failure's message.
    func log(_ names: [String]) -> String {
        guard let start = frames.first?.time else { return "" }
        let lines = frames.map { frame in
            let rects = names.map { name in frame.rects[name].map { String(format: "%@=%.1f,%.1f", name, $0.minX, $0.minY) } ?? "\(name)=-" }
            return (frame.time, "kb=\(String(format: "%.1f", frame.keyboard)) " + rects.joined(separator: " "))
        } + notes.map { ($0.time, "note " + $0.line) }
        return lines.sorted { $0.0 < $1.0 }.map { "\(Int((($0.0 - start) * 1000).rounded()))ms \($0.1)" }.joined(separator: "\n")
    }

    /// Up to `count` frames across the motion side by side, a quarter
    /// size, the keyboard's top a red line, each with its time; attached
    /// to the test and written to `HAPPY_RECORDING_DIR` when set.
    func attachStrip(_ name: String, to test: XCTestCase, count: Int = 10) {
        guard keepsPictures, let start = frames.first?.time else { return }
        let range: ClosedRange<Int>
        if let motion = keyboardMotion {
            range = max(0, motion.lowerBound - 2)...min(frames.count - 1, motion.upperBound + 3)
        } else {
            range = 0...(frames.count - 1)
        }
        let picked = stride(from: 0, to: count, by: 1).map { range.lowerBound + (range.count - 1) * $0 / max(1, count - 1) }
        let scale: CGFloat = 0.3
        let size = CGSize(width: window.bounds.width * scale, height: window.bounds.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let strip = UIGraphicsImageRenderer(size: CGSize(width: size.width * CGFloat(picked.count) + CGFloat(picked.count - 1) * 4, height: size.height + 18), format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: context.format.bounds.size))
            for (slot, index) in picked.enumerated() {
                let frame = frames[index]
                let origin = CGPoint(x: CGFloat(slot) * (size.width + 4), y: 18)
                frame.picture?.draw(in: CGRect(origin: origin, size: size))
                UIColor.red.setFill()
                context.fill(CGRect(x: origin.x, y: origin.y + frame.keyboard * scale - 1, width: size.width, height: 2))
                let label = "\(Int(((frame.time - start) * 1000).rounded()))ms" as NSString
                label.draw(at: CGPoint(x: origin.x + 2, y: 2), withAttributes: [.font: UIFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium), .foregroundColor: UIColor.black])
            }
        }
        let attachment = XCTAttachment(image: strip)
        attachment.name = name
        attachment.lifetime = .keepAlways
        test.add(attachment)
        if let root = ProcessInfo.processInfo.environment["HAPPY_RECORDING_DIR"] {
            let directory = URL(fileURLWithPath: root).appendingPathComponent("cloud-strips")
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? strip.pngData()?.write(to: directory.appendingPathComponent("\(name).png"))
        }
    }
}

/// Happy Cloud's sign-in, every display frame read from what is drawn,
/// as Steve saw it on the iPhone:
///
/// - status, error and helper lines (a failure, a countdown, "Checking…",
///   a taken name) coming and going move nothing else on the step;
/// - a step that types comes in with its keyboard: the push and the
///   keyboard start together, and the step rides the keyboard on its own
///   curve, with no late snap and no second animation; going between two
///   steps that type, the keyboard never goes down and up; back to one
///   that doesn't, it goes down with the pop;
/// - once a step is done for good the stack is replaced: Back never returns
///   to a sign-in step, and after Create your profile the server opens from
///   it, with nothing popped back.
///
/// The keyboard is the system's own; a simulator with a hardware keyboard
/// connected shows none, and the tests that need it fail saying so.
@MainActor
final class HostedCloudSignInMotionTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
        CloudScreens.account = nil
    }

    override func tearDown() {
        CloudScreens.account = nil
        super.tearDown()
    }

    private func context() -> AppContext {
        let account = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) })
        return AppContext(account: account, variant: .preview, version: "test")
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    /// Happy Cloud as it is presented: full screen, `root` wearing Close.
    private func present(_ root: UIViewController) async throws -> (UIWindow, CloudNavigationController) {
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let navigation = CloudNavigationController(rootViewController: root)
        root.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.endEditing(true)
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        return (window, navigation)
    }

    /// Settled: no transition, and the keyboard where it is going.
    private func settle(_ navigation: UINavigationController) async throws {
        _ = try await until { navigation.transitionCoordinator == nil }
        try await Task.sleep(for: .milliseconds(700))
    }

    private func stepViews(_ step: @escaping () -> CloudStageViewController?) -> [String: () -> UIView?] {
        [
            "step": { step()?.view },
            "title": { step()?.titleLabel },
            "body": { step()?.bodyLabel },
            "content": { step()?.content },
            "primary": { step()?.primary },
            "secondary": { step()?.secondary },
        ]
    }

    private struct NoKeyboard: Error {}

    /// These tests never skip: without the software keyboard they fail.
    private func requireKeyboard(_ frames: CloudFrames, file: StaticString = #filePath, line: UInt = #line) throws {
        guard frames.sawKeyboard else {
            XCTFail("no software keyboard: turn off the simulator's hardware keyboard (I/O › Keyboard › Connect Hardware Keyboard)", file: file, line: line)
            throw NoKeyboard()
        }
    }

    // MARK: The keyboard

    /// Continue with email: the address step comes in with its keyboard.
    /// The keyboard starts with the push, not after it, and the step rides
    /// it up on its curve: no late snap, no turning back.
    func testTheAddressStepComesInWithItsKeyboard() async throws {
        let welcome = CloudWelcomeViewController(context: context())
        welcome.http = SignInHTTP()
        let (window, navigation) = try await present(welcome)
        try await settle(navigation)
        let frames = CloudFrames(window: window, navigation: navigation, views: stepViews { navigation.topViewController as? CloudEmailViewController })
        await frames.sample(seconds: 1.4) { welcome.email.tapped() }
        try requireKeyboard(frames)
        frames.attachStrip("email-push", to: self)
        print(frames.summary("email-push", moving: "step", ["title", "primary"]))
        let names = ["step", "title", "primary"]
        XCTAssertTrue(frames.keyboardStartsWith("step"), "the keyboard starts with the push, not after it\n" + frames.log(names))
        for name in ["title", "primary"] {
            XCTAssertLessThanOrEqual(frames.offKeyboard(name), 2, "\(name) rides the keyboard's curve\n" + frames.log(names))
            XCTAssertEqual(frames.lateMoves(name), 0, "\(name) never moves after the keyboard has stopped\n" + frames.log(names))
            XCTAssertEqual(frames.reversals(name), 0, "\(name) never turns back\n" + frames.log(names))
        }
        let step = try XCTUnwrap(navigation.topViewController as? CloudEmailViewController)
        XCTAssertTrue(step.field.text.isFirstResponder)
        XCTAssertEqual(step.primary.convert(step.primary.bounds, to: window).maxY, (frames.frames.last?.keyboard ?? 0) - 16, accuracy: 1, "Send code rests 16 over the keyboard")
    }

    /// Send code: the code step comes in over the keyboard already up; the
    /// keyboard never goes down on the way, only changes to digits, and
    /// the step's buttons ride its change. Change email goes back the same
    /// way.
    func testBetweenTheTwoEmailStepsTheKeyboardStaysUp() async throws {
        let http = SignInHTTP()
        await http.answer("POST /v1/auth/email/start", 202, "{}")
        let welcome = CloudWelcomeViewController(context: context())
        welcome.http = http
        let (window, navigation) = try await present(welcome)
        try await settle(navigation)
        welcome.email.tapped()
        try await settle(navigation)
        let address = try XCTUnwrap(navigation.topViewController as? CloudEmailViewController)
        address.field.text.text = "steve@example.com"
        address.edited()

        let code = CloudFrames(window: window, navigation: navigation, views: stepViews { navigation.topViewController as? CloudEmailCodeViewController })
        await code.sample(seconds: 1.4) {
            address.primary.tapped()
            _ = try? await until { navigation.topViewController is CloudEmailCodeViewController }
        }
        try requireKeyboard(code)
        code.attachStrip("email-to-code", to: self)
        print(code.summary("email-to-code", moving: "step", ["title", "primary"]))
        let names = ["step", "title", "primary", "secondary"]
        XCTAssertLessThanOrEqual(code.keyboardDip, 1, "the keyboard never goes down between the steps\n" + code.log(names))
        for name in ["title", "primary", "secondary"] {
            XCTAssertEqual(code.lateMoves(name), 0, "\(name) never moves after the keyboard has stopped\n" + code.log(names))
            XCTAssertLessThanOrEqual(code.reversals(name), 0, "\(name) never turns back\n" + code.log(names))
        }
        let step = try XCTUnwrap(navigation.topViewController as? CloudEmailCodeViewController)
        XCTAssertTrue(step.field.text.isFirstResponder)
        try await settle(navigation)

        let back = CloudFrames(window: window, navigation: navigation, views: stepViews { navigation.topViewController as? CloudEmailViewController })
        await back.sample(seconds: 1.4) { step.change.tapped() }
        back.attachStrip("change-email", to: self)
        print(back.summary("change-email", moving: "step", ["title", "primary"]))
        XCTAssertLessThanOrEqual(back.keyboardDip, 1, "Change email keeps the keyboard up\n" + back.log(names))
        for name in ["title", "primary"] {
            XCTAssertEqual(back.lateMoves(name), 0, "\(name) never moves after the keyboard has stopped\n" + back.log(names))
        }
        XCTAssertTrue(address.field.text.isFirstResponder, "the address has the keyboard again")
    }

    /// Back to the welcome from the address: the keyboard goes down with
    /// the pop, not once it is over.
    func testBackToTheWelcomeTakesTheKeyboardDownWithThePop() async throws {
        let welcome = CloudWelcomeViewController(context: context())
        welcome.http = SignInHTTP()
        let (window, navigation) = try await present(welcome)
        try await settle(navigation)
        welcome.email.tapped()
        try await settle(navigation)
        let address = try XCTUnwrap(navigation.topViewController as? CloudEmailViewController)
        let frames = CloudFrames(window: window, navigation: navigation, views: stepViews { address })
        await frames.sample(seconds: 1.4) { navigation.popViewController(animated: true) }
        try requireKeyboard(frames)
        frames.attachStrip("back-to-welcome", to: self)
        print(frames.summary("back-to-welcome", moving: "step", ["title", "primary"]))
        XCTAssertTrue(frames.keyboardStartsWith("step"), "the keyboard goes with the pop\n" + frames.log(["step", "title"]))
        XCTAssertEqual(frames.frames.last?.keyboard ?? 0, window.bounds.maxY, accuracy: 1, "and is down")
    }

    /// A server that wants a name: Create your profile comes in with its
    /// keyboard over Connecting, which has none.
    func testTheProfileComesInWithItsKeyboard() async throws {
        let origin = HappyCloud.server(named: "acme")
        let http = SignInHTTP()
        await http.answer("POST /v1/servers/s1/token", 200, #"{"access_token":"\#(accessToken(for: origin + "/"))","token_type":"Bearer","expires_in":3600}"#)
        await http.answer("GET /v0/authentication", 200, #"{"authenticated":true,"userId":null,"methods":[]}"#)
        let connecting = CloudConnectingViewController(context: context(), account: CloudAccount.preview(token: "account", http: http),
                                                       server: CloudServer(id: "s1", name: "acme", url: origin + "/", role: .member), startsAtOnce: false)
        let daemon = NamelessDaemon()
        connecting.makeFlow = { try ServerSignInFlow.cloud($0, http: http, makeTransport: { _ in daemon }) }
        let (window, navigation) = try await present(connecting)
        try await settle(navigation)
        let frames = CloudFrames(window: window, navigation: navigation, views: stepViews { navigation.topViewController as? CloudProfileViewController })
        await frames.sample(seconds: 1.6) {
            connecting.primary.tapped()
            _ = try? await until { navigation.topViewController is CloudProfileViewController }
        }
        try requireKeyboard(frames)
        frames.attachStrip("profile-push", to: self)
        print(frames.summary("profile-push", moving: "step", ["title", "primary"]))
        let names = ["step", "title", "primary"]
        XCTAssertTrue(frames.keyboardStartsWith("step"), "the keyboard starts with the push, not after it\n" + frames.log(names))
        for name in ["title", "primary"] {
            XCTAssertLessThanOrEqual(frames.offKeyboard(name), 2, "\(name) rides the keyboard's curve\n" + frames.log(names))
            XCTAssertEqual(frames.lateMoves(name), 0, "\(name) never moves after the keyboard has stopped\n" + frames.log(names))
            XCTAssertEqual(frames.reversals(name), 0, "\(name) never turns back\n" + frames.log(names))
        }
    }

    /// Join a server's Bootstrap a new one comes in with its keyboard.
    func testBootstrapComesInWithItsKeyboard() async throws {
        let http = SignInHTTP()
        await http.answer("GET /v1/servers", 200, #"{"servers":[{"id":"s1","name":"acme","url":"","role":"owner"}]}"#)
        let account = CloudAccount.preview(token: "account", http: http)
        let servers = CloudServersViewController(context: context(), account: account)
        let (window, navigation) = try await present(servers)
        _ = try await until { servers.content.subviews.contains { $0 is CloudServerRow } }
        try await settle(navigation)
        let names = ["step", "title", "primary"]
        let create = CloudFrames(window: window, navigation: navigation, views: stepViews { navigation.topViewController as? CloudCreateViewController })
        await create.sample(seconds: 1.4) { servers.bootstrap.tapped() }
        try requireKeyboard(create)
        create.attachStrip("bootstrap-push", to: self)
        print(create.summary("bootstrap-push", moving: "step", ["title", "primary"]))
        XCTAssertTrue(create.keyboardStartsWith("step"), "the keyboard starts with the push, not after it\n" + create.log(names))
        for name in ["title", "primary"] {
            XCTAssertLessThanOrEqual(create.offKeyboard(name), 2, "\(name) rides the keyboard's curve\n" + create.log(names))
            XCTAssertEqual(create.lateMoves(name), 0, "\(name) never moves after the keyboard has stopped\n" + create.log(names))
            XCTAssertEqual(create.reversals(name), 0, "\(name) never turns back\n" + create.log(names))
        }
    }

    /// Turned to landscape and back with the keyboard up: Send code stays
    /// over the keyboard, and back in portrait everything is where it was.
    func testTurningThePhoneKeepsTheStepOverTheKeyboard() async throws {
        let welcome = CloudWelcomeViewController(context: context())
        welcome.http = SignInHTTP()
        let (window, navigation) = try await present(welcome)
        try await settle(navigation)
        welcome.email.tapped()
        try await settle(navigation)
        let address = try XCTUnwrap(navigation.topViewController as? CloudEmailViewController)
        let scene = try XCTUnwrap(window.windowScene)
        let frames = CloudFrames(window: window, navigation: navigation, views: stepViews { address })
        frames.start()
        try await Task.sleep(for: .milliseconds(100))
        frames.stop()
        try requireKeyboard(frames)
        let before = try XCTUnwrap(frames.frames.last)
        for orientation in [UIInterfaceOrientationMask.landscapeRight, .portrait] {
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: orientation))
            navigation.setNeedsUpdateOfSupportedInterfaceOrientations()
            try await Task.sleep(for: .milliseconds(1500))
            XCTAssertEqual(window.bounds.width > window.bounds.height, orientation == .landscapeRight, "the host turned")
            frames.start()
            try await Task.sleep(for: .milliseconds(100))
            frames.stop()
            let now = try XCTUnwrap(frames.frames.last)
            frames.attachStrip("rotated-\(orientation == .portrait ? "portrait" : "landscape")", to: self, count: 1)
            let primary = try XCTUnwrap(now.rects["primary"])
            XCTAssertLessThanOrEqual(primary.maxY, now.keyboard - 15, "Send code over the keyboard (\(orientation.rawValue))")
            XCTAssertTrue(address.field.text.isFirstResponder)
        }
        let after = try XCTUnwrap(frames.frames.last)
        for name in ["title", "content", "primary"] {
            XCTAssertEqual(after.rects[name]?.minY ?? 0, before.rects[name]?.minY ?? -1, accuracy: 0.5, "\(name) back where it was")
        }
    }

    // MARK: Lines that come and go

    /// The address step, keyboard up and down: a failure in one line and in
    /// two, gone again, and Send code counting down move nothing.
    func testTheAddressStepsLinesMoveNothing() async throws {
        let welcome = CloudWelcomeViewController(context: context())
        welcome.http = SignInHTTP()
        let (window, navigation) = try await present(welcome)
        try await settle(navigation)
        welcome.email.tapped()
        try await settle(navigation)
        let address = try XCTUnwrap(navigation.topViewController as? CloudEmailViewController)
        for keyboardUp in [true, false] {
            if !keyboardUp {
                window.endEditing(true)
                try await settle(navigation)
            }
            let frames = CloudFrames(window: window, navigation: navigation, views: stepViews { address })
            await frames.sample(seconds: 0.4) {
                for line in [Strings.CloudEmail.invalidEmail, Strings.CloudEmail.failure(CloudAccountError.refused(status: 400, code: "unsupported_provider", message: nil)), "", Strings.CloudEmail.emailMissing] {
                    address.say(line.isEmpty ? nil : line)
                    try? await Task.sleep(for: .milliseconds(250))
                }
                address.primary.title = Strings.CloudEmail.send(in: 59)
                address.relayout()
                try? await Task.sleep(for: .milliseconds(250))
                address.say(nil)
            }
            frames.attachStrip("address-lines-\(keyboardUp ? "keyboard" : "no-keyboard")", to: self)
            print(frames.summary("address-lines-\(keyboardUp ? "keyboard" : "no-keyboard")", ["title", "content", "primary"]))
            for name in ["title", "body", "content", "primary"] {
                XCTAssertLessThanOrEqual(frames.drift(name), 0.5, "\(name) stays put (keyboard \(keyboardUp ? "up" : "down"))\n" + frames.log(["title", "content", "primary"]))
            }
        }
    }

    /// The code step: a wrong code, a wait, We sent a new code, and the
    /// countdowns on Verify and Resend code move nothing.
    func testTheCodeStepsLinesMoveNothing() async throws {
        let welcome = CloudWelcomeViewController(context: context())
        let (window, navigation) = try await present(welcome)
        let step = CloudEmailCodeViewController(context: context(), email: "steve@example.com", http: SignInHTTP(), sentAt: Date())
        navigation.pushViewController(step, animated: false)
        try await settle(navigation)
        var views = stepViews { step }
        views["change"] = { step.change }
        let frames = CloudFrames(window: window, navigation: navigation, views: views)
        await frames.sample(seconds: 0.4) {
            for line in [Strings.CloudEmail.failure(CloudAccountError.refused(status: 400, code: "invalid_code", message: nil)),
                         Strings.CloudEmail.failure(CloudAccountError.rateLimited(retryAfter: 600, message: nil)), Strings.CloudEmail.resent, ""] {
                step.say(line.isEmpty ? nil : line, problem: line != Strings.CloudEmail.resent)
                try? await Task.sleep(for: .milliseconds(300))
            }
        }
        frames.attachStrip("code-lines", to: self)
        print(frames.summary("code-lines", ["title", "content", "primary", "secondary"]))
        for name in ["title", "body", "content", "primary", "secondary", "change"] {
            XCTAssertLessThanOrEqual(frames.drift(name), 0.5, "\(name) stays put\n" + frames.log(["title", "content", "primary", "secondary", "change"]))
        }
    }

    /// Bootstrap a server: Checking…, available, taken, and the rule a
    /// name breaks (two lines) under the field move nothing.
    func testTheServerNamesHintMovesNothing() async throws {
        let create = CloudCreateViewController(context: context(), account: CloudAccount.preview(token: "account", http: SignInHTTP()), first: true)
        let (window, navigation) = try await present(create)
        try await settle(navigation)
        var views = stepViews { create }
        views["field"] = { create.field }
        let frames = CloudFrames(window: window, navigation: navigation, views: views)
        await frames.sample(seconds: 0.4) {
            for line in [Strings.CloudConnect.checking, Strings.CloudConnect.available("acme"),
                         Strings.CloudConnect.unavailable(.taken, name: "acme") ?? "", Strings.CloudConnect.invalidName, ""] {
                create.status.string = line
                create.relayout()
                try? await Task.sleep(for: .milliseconds(300))
            }
        }
        frames.attachStrip("server-name-hint", to: self)
        print(frames.summary("server-name-hint", ["title", "field", "primary"]))
        for name in ["title", "body", "field", "primary"] {
            XCTAssertLessThanOrEqual(frames.drift(name), 0.5, "\(name) stays put\n" + frames.log(["title", "field", "primary"]))
        }
    }

    /// Create your profile: a name that isn't saved says so and moves nothing.
    func testTheProfilesFailureMovesNothing() async throws {
        let profile = CloudProfileViewController(context: context(), handle: "@acme", prefill: "Steve", seed: "acme") { _, _ in true }
        let (window, navigation) = try await present(profile)
        try await settle(navigation)
        var views = stepViews { profile }
        views["avatar"] = { profile.avatar }
        let frames = CloudFrames(window: window, navigation: navigation, views: views)
        await frames.sample(seconds: 0.4) {
            for line in [Strings.CloudConnect.nameFailed, ""] {
                profile.status.string = line
                profile.relayout()
                try? await Task.sleep(for: .milliseconds(300))
            }
        }
        frames.attachStrip("profile-failure", to: self)
        print(frames.summary("profile-failure", ["avatar", "title", "primary"]))
        for name in ["avatar", "title", "content", "primary"] {
            XCTAssertLessThanOrEqual(frames.drift(name), 0.5, "\(name) stays put\n" + frames.log(["avatar", "title", "primary"]))
        }
    }

    /// The welcome: a sign-in's failure over the buttons, and the note an
    /// ended pass shows, move neither the slides nor the buttons.
    func testTheWelcomesNoteMovesNothing() async throws {
        let welcome = CloudWelcomeViewController(context: context())
        let (window, navigation) = try await present(welcome)
        try await settle(navigation)
        let frames = CloudFrames(window: window, navigation: navigation, views: [
            "gallery": { welcome.gallery }, "apple": { welcome.appleButton }, "google": { welcome.google },
            "github": { welcome.github }, "email": { welcome.email },
        ])
        await frames.sample(seconds: 0.4) {
            for line in [Strings.CloudConnect.expired, Strings.HappyCloud.failure(CloudAccountError.refused(status: 400, code: "unsupported_provider", message: nil)), ""] {
                welcome.note.string = line
                welcome.view.setNeedsLayout()
                try? await Task.sleep(for: .milliseconds(300))
            }
        }
        frames.attachStrip("welcome-note", to: self)
        print(frames.summary("welcome-note", ["gallery", "apple", "github"]))
        for name in ["gallery", "apple", "google", "github", "email"] {
            XCTAssertLessThanOrEqual(frames.drift(name), 0.5, "\(name) stays put\n" + frames.log(["gallery", "apple", "github"]))
        }
    }

    /// Join a server: the list arriving where the spinner was, a join's
    /// failure and Continue coming move nothing above them.
    func testTheServersListMovesNothingAbove() async throws {
        let http = SignInHTTP()
        await http.answer("GET /v1/servers", 200, #"{"servers":[{"id":"s1","name":"acme","url":"","role":"owner"},{"id":"s2","name":"globex","url":"","role":"member"}]}"#)
        let gate = AsyncGate()
        let account = CloudAccount.preview(token: "account", http: http)
        let servers = CloudServersViewController(context: context(), account: account) {
            await gate.wait()
            return try await account.servers()
        }
        let (window, navigation) = try await present(servers)
        try await settle(navigation)
        var views = stepViews { servers }
        views["bootstrap"] = { servers.bootstrap }
        let frames = CloudFrames(window: window, navigation: navigation, views: views)
        await frames.sample(seconds: 0.6) {
            await gate.open()
            try? await Task.sleep(for: .milliseconds(400))
            servers.status.string = Strings.ServerSignIn.nameNeeded
            servers.relayout()
            try? await Task.sleep(for: .milliseconds(300))
            servers.status.string = ""
            servers.primary.isHidden = false
            servers.relayout()
        }
        frames.attachStrip("servers-list", to: self)
        print(frames.summary("servers-list", ["title", "content", "primary"]))
        for name in ["title", "body", "content"] {
            XCTAssertLessThanOrEqual(frames.topDrift(name), 0.5, "\(name)'s top stays put\n" + frames.log(["title", "content", "bootstrap", "primary"]))
        }
        XCTAssertLessThanOrEqual(frames.drift("primary"), 0.5, "Continue comes where its room was\n" + frames.log(["title", "content", "bootstrap", "primary"]))
    }

    // MARK: The stack

    /// Signed in (the code here; Apple's, Google's and GitHub's end the same
    /// way, `CloudScreens.signedIn`): the servers take the place of the
    /// welcome and every step, wearing the flow's Close; the keyboard goes
    /// down with the push.
    func testSignedInTheServersReplaceEverySignInStep() async throws {
        let http = SignInHTTP()
        await http.answer("POST /v1/auth/email/start", 202, "{}")
        let pass = accessToken(for: HappyCloud.accounts + "/")
        await http.answer("POST /v1/auth/email/verify", 200, #"{"access_token":"\#(pass)","refresh_token":"r1","token_type":"Bearer","expires_in":3600}"#)
        await http.answer("GET /v1/servers", 200, #"{"servers":[{"id":"s1","name":"acme","url":"","role":"owner"}]}"#)
        let welcome = CloudWelcomeViewController(context: context())
        welcome.http = http
        let (window, navigation) = try await present(welcome)
        let close = welcome.navigationItem.leftBarButtonItem
        try await settle(navigation)
        welcome.email.tapped()
        try await settle(navigation)
        let address = try XCTUnwrap(navigation.topViewController as? CloudEmailViewController)
        address.field.text.text = "steve@example.com"
        address.edited()
        address.primary.tapped()
        _ = try await until { navigation.topViewController is CloudEmailCodeViewController }
        try await settle(navigation)
        let code = try XCTUnwrap(navigation.topViewController as? CloudEmailCodeViewController)
        let frames = CloudFrames(window: window, navigation: navigation, views: ["code": { code.view }])
        await frames.sample(seconds: 1.4) {
            code.field.text.text = "123456"
            code.edited()
            _ = try? await until { navigation.topViewController is CloudServersViewController }
        }
        frames.attachStrip("verified", to: self)
        print(frames.summary("verified", moving: "code", []))
        XCTAssertTrue(navigation.topViewController is CloudServersViewController)
        XCTAssertEqual(navigation.viewControllers.count, 1, "nothing to go back to: no welcome, no email steps")
        XCTAssertTrue(navigation.topViewController?.navigationItem.leftBarButtonItem === close, "the flow's Close came with it")
        XCTAssertTrue(frames.keyboardStartsWith("code"), "the keyboard goes down with the push\n" + frames.log(["code"]))
    }

    /// Create your profile saved: the server opens from it. Nothing pops
    /// back to Connecting on the way.
    func testAfterTheProfileNothingPopsBack() async throws {
        let origin = HappyCloud.server(named: "acme")
        let http = SignInHTTP()
        await http.answer("POST /v1/servers/s1/token", 200, #"{"access_token":"\#(accessToken(for: origin + "/"))","token_type":"Bearer","expires_in":3600}"#)
        await http.answer("GET /v0/authentication", 200, #"{"authenticated":true,"userId":null,"methods":[]}"#)
        let connecting = CloudConnectingViewController(context: context(), account: CloudAccount.preview(token: "account", http: http),
                                                       server: CloudServer(id: "s1", name: "acme", url: origin + "/", role: .member), startsAtOnce: false)
        let daemon = NamelessDaemon()
        connecting.makeFlow = { try ServerSignInFlow.cloud($0, http: http, makeTransport: { _ in daemon }) }
        let (window, navigation) = try await present(connecting)
        try await settle(navigation)
        connecting.primary.tapped()
        _ = try await until { navigation.topViewController is CloudProfileViewController }
        try await settle(navigation)
        let profile = try XCTUnwrap(navigation.topViewController as? CloudProfileViewController)
        await http.answer("GET /v0/authentication", 200, #"{"authenticated":true,"userId":"u1","methods":[]}"#)
        let frames = CloudFrames(window: window, navigation: navigation, views: ["profile": { profile.view }])
        await frames.sample(seconds: 1.0) {
            profile.primary.tapped()
            _ = try? await until { !profile.primary.isLoading }
        }
        frames.attachStrip("profile-saved", to: self)
        print(frames.summary("profile-saved", []))
        XCTAssertFalse(frames.frames.contains { $0.top === connecting }, "never back on Connecting")
        XCTAssertEqual(connecting.context.account.agentConnections.accounts.count, 1, "the server is kept")
    }
}

/// Holds a load until the test lets it go.
private actor AsyncGate {
    private var opened = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiting.append($0) }
    }
    func open() {
        opened = true
        waiting.forEach { $0.resume() }
        waiting = []
    }
}
#endif
