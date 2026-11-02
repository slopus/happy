#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import UltraView
import XCTest

private struct ResizeOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct ResizeNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A computer with 60 finished turns on agent `a`: a request, a command
/// and three paragraphs of answer each.
private actor ResizeComputer: AgentTransport {
    static func text(_ text: String) -> JSONValue { .object(["type": .string("text"), "text": .string(text)]) }

    static func message(_ id: String, role: String, _ content: [JSONValue]) -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(1), "metadata": .object([:]), "content": .array(content)])
    }

    static let runs: [JSONValue] = (0..<60).map { index in
        let answer = (0..<3).map { paragraph in
            "Paragraph \(paragraph) of answer \(index): the cache keeps **every** entry it read, `Cache.swift` evicts the oldest past its limit, and the test now waits for the write before it reads the file back."
        }.joined(separator: "\n\n")
        let blocks: [JSONValue] = [
            text("I'll run the tests first."),
            .object(["type": .string("tool_call"), "id": .string("\(index)-1"), "name": .string("exec_command"), "status": .string("completed"),
                     "presentation": .object(["type": .string("exec_command"), "command": .string("pnpm test --filter happy-ios")])]),
            text(answer),
        ]
        return .object(["id": .string("r\(index)"), "status": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(2_000),
                        "reason": .string("completed"), "messages": .array([
                            message("u\(index)", role: "user", [text("Turn \(index): fix the failing cache test")]),
                            message("m\(index)", role: "agent", blocks),
                        ])])
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        let value: JSONValue
        if path.contains("/agents/a/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(Self.runs)])
        } else if path.hasSuffix("/agents/a/bootstrap") {
            value = .object(["agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string("idle")]), "pending": .array([])])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}
}

/// Width changes through every list, frame by frame: a phone turned on
/// either side and back upright, which puts the camera on the left or on
/// the right; a tablet's window narrowed below the split's 768 and widened
/// again, and its main panel losing and getting back the sidebar's 320. In
/// the frame of the change and in every frame of its animation, each row on
/// screen is drawn and drawn at the new width (no blank row, no row showing
/// its old width's drawing), rows of a fixed height keep their places, a
/// chat that rests on its newest row stays on it, a chat read up into
/// history keeps the row being read where it was, and nothing that reads
/// or takes a touch crosses into the safe area's sides. `RESIZE_REPORT`
/// lines give the main thread's time per change.
@MainActor
final class HostedListResizeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
        // A test that failed on its side leaves the phone upright again.
        addTeardownBlock { @MainActor in
            guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene, scene.interfaceOrientation != .portrait else { return }
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait))
            let deadline = ContinuousClock.now + .seconds(5)
            while scene.interfaceOrientation != .portrait, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        }
    }

    private static let animation: TimeInterval = 0.3

    private func until(seconds: Double = 10, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    private static func find<View: UIView>(_ type: View.Type, in view: UIView) -> View? {
        if let view = view as? View, view.window != nil, !view.isHidden { return view }
        for child in view.subviews { if let found = find(type, in: child) { return found } }
        return nil
    }

    /// A width change: the window resized, as a split or Stage Manager
    /// does, or the phone turned, which moves the safe area's sides too.
    enum Change {
        case size(CGSize)
        case turn(UIInterfaceOrientation)
    }

    /// The width changes this device goes through, each from the one
    /// before, ending where it started.
    private static func sizes(of window: UIWindow) -> [(name: String, change: Change)] {
        let size = window.bounds.size
        if UIDevice.current.userInterfaceIdiom == .pad {
            return [
                ("window narrowed below the split", .size(CGSize(width: 700, height: size.height))),
                ("window widened back", .size(size)),
                ("sidebar's width taken", .size(CGSize(width: size.width - 320, height: size.height))),
                ("sidebar's width given back", .size(size)),
            ]
        }
        return [
            ("turned on its left side", .turn(.landscapeLeft)),
            ("turned upright", .turn(.portrait)),
            ("turned on its right side", .turn(.landscapeRight)),
            ("turned upright again", .turn(.portrait)),
        ]
    }

    /// Whether `window` stands as `change` leaves it.
    private static func done(_ change: Change, _ window: UIWindow) -> Bool {
        switch change {
        case .size(let size): return window.bounds.size == size
        case .turn(let orientation):
            return window.windowScene?.interfaceOrientation == orientation && (window.bounds.width > window.bounds.height) == orientation.isLandscape
        }
    }

    /// What reads or takes a touch on screen in `window` and crosses into
    /// the safe area's sides: text, controls, pictures and list rows. The
    /// bars, which UIKit keeps clear itself, are left out, and so is what
    /// only shades the screen, which runs edge to edge.
    private static func intoSides(_ window: UIWindow) -> [String] {
        let safe = window.safeAreaInsets
        guard safe.left > 0 || safe.right > 0 else { return [] }
        let minX = safe.left - 0.5, maxX = window.bounds.width - safe.right + 0.5
        var found: [String] = []
        func walk(_ view: UIView) {
            guard !view.isHidden, view.alpha > 0.01, !(view is UINavigationBar), !(view is UIToolbar) else { return }
            let frame = view.convert(view.bounds, to: window)
            let reads = view is UILabel || view is UITextView || view is UITextField || view is UIControl || view is UIImageView || view is ListRowView
            if reads, frame.width > 1, frame.height > 1, frame.intersects(window.bounds), frame.minX < minX || frame.maxX > maxX {
                found.append("\(type(of: view)) \(view.accessibilityIdentifier ?? "") at \(frame.integral) crosses the sides \(safe.left), \(safe.right)")
            }
            // A row's drawing and views stand inside it.
            if view is ListRowView { return }
            view.subviews.forEach(walk)
        }
        walk(window)
        return found
    }

    /// The bitmaps drawn under `layer`, in layers that show.
    private static func bitmaps(_ layer: CALayer) -> [CGImage] {
        guard !layer.isHidden, layer.opacity > 0 else { return [] }
        var found: [CGImage] = []
        if let contents = layer.contents, CFGetTypeID(contents as CFTypeRef) == CGImage.typeID {
            found.append(contents as! CGImage)
        }
        for sublayer in layer.sublayers ?? [] { found += bitmaps(sublayer) }
        return found
    }

    /// The rows on screen in `list`, by index.
    private static func shown(_ list: UltraListView) -> [Int] {
        list.loadedIndexRange.filter { index in
            guard let frame = list.settledFrame(at: index) else { return false }
            return frame.maxY > 1 && frame.minY < list.bounds.height - 1 && frame.height > 1
        }
    }

    /// Each row on screen in `list` drawn, at the list's width: its drawing,
    /// the widest bitmap in it, is that many pixels wide.
    private static func drawnAtWidth(_ list: UltraListView, skip: (String) -> Bool = { _ in false }) -> [String] {
        let width = list.bounds.width, scale = list.traitCollection.displayScale
        var problems: [String] = []
        for index in shown(list) {
            let id = list.items[index].identity
            guard !skip(id), let view = list.loadedItemView(at: index) else { continue }
            guard view.isDisplayReady else { problems.append("\(id) is blank"); continue }
            guard let widest = bitmaps(view.layer).map(\.width).max() else { problems.append("\(id) has no drawing"); continue }
            if abs(CGFloat(widest) - width * scale) > 1 {
                problems.append("\(id) shows a drawing \(CGFloat(widest) / scale) wide in a list \(width) wide")
            }
        }
        return problems
    }

    /// Resizes `window` in an animation as a split does, or turns the
    /// phone, then runs `check` in the turn of the change, which the first
    /// frame at the new size shows, and on every frame until the motion is
    /// over and the screens have planned their rows again; every frame,
    /// nothing may cross into the safe area's sides either. Fails with the
    /// problems found, by frame.
    private func resize(_ window: UIWindow, to change: Change, _ label: String, check: @escaping () -> [String]) async throws {
        var frames: [[String]] = []
        var ticks: [CFTimeInterval] = [CACurrentMediaTime()]
        switch change {
        case .size(let size):
            UIView.animate(withDuration: Self.animation) {
                window.frame = CGRect(origin: window.frame.origin, size: size)
                window.layoutIfNeeded()
            }
        case .turn(let orientation):
            let mask: UIInterfaceOrientationMask = orientation == .landscapeLeft ? .landscapeLeft : orientation == .landscapeRight ? .landscapeRight : .portrait
            window.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in XCTFail("\(label): \(error)") }
        }
        frames.append(check() + Self.intoSides(window))
        let recorder = TickRecorder { time in ticks.append(time); frames.append(check() + Self.intoSides(window)) }
        let turned = try await until(seconds: 5) { Self.done(change, window) }
        XCTAssertTrue(turned, "\(label): the window never got there")
        try await Task.sleep(for: .seconds(Self.animation + 0.6))
        recorder.stop()
        let gaps = zip(ticks.dropFirst(), ticks).map { ($0 - $1) * 1000 }
        print(String(format: "RESIZE_FRAMES %@ first=%.1fms longest=%.1fms frames=%d", label, gaps.first ?? 0, gaps.max() ?? 0, gaps.count))
        let problems = frames.enumerated().flatMap { frame, problems in problems.map { "frame \(frame): \($0)" } }
        XCTAssertEqual(problems.prefix(12), [], "\(label): \(problems.count) problems over \(frames.count) frames")
        XCTAssertGreaterThan(frames.count, 10, "\(label): too few frames sampled")
    }

    /// What the first frame at `width` showed: the frame of the change. A
    /// turn starts a frame or more after it is asked for.
    private static func first<Value>(_ frames: [(width: CGFloat, boxes: Value)], at width: CGFloat) -> Value? {
        frames.first { abs($0.width - width) < 0.5 }?.boxes
    }

    private func report(_ label: String, _ list: UltraListView) {
        guard let resize = list.lastResize else { print("RESIZE_REPORT \(label) none"); return }
        print(String(format: "RESIZE_REPORT %@ width=%.0f main=%.2fms cpu=%.2fms waited=%.2fms apply=%.2fms pass=%.2fms prepared=%d late=%d kept=%d fixed=%d animated=%d",
                     label, resize.width, resize.milliseconds, resize.cpuMilliseconds, resize.waitedMilliseconds, resize.applyingMilliseconds,
                     resize.passMilliseconds, resize.preparedRows, resize.lateRows, resize.keptRows, resize.fixedRows, resize.animated ? 1 : 0))
    }

    private func signedIn() async throws -> AccountController {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: ResizeOffline(), connector: ResizeNoSocket()
        )
        try await controller.signIn(Credentials(token: "resize", secret: Data(repeating: 43, count: 32)))
        return controller
    }

    // MARK: Homes

    /// Where each fixed-height row of `list` rests, by identity: from the
    /// top inset, as the bar changes height on its own as a phone turns,
    /// and less the rows above it whose height follows the width (a
    /// banner that wraps), which move what is under them.
    private static func place(_ index: Int, _ list: UltraListView) -> CGFloat? {
        guard list.items[index].hasFixedHeight || list.items[index] is SidebarItem, let frame = list.settledFrame(at: index) else { return nil }
        let wrapping = list.loadedIndexRange.prefix { $0 < index }.filter { !list.items[$0].hasFixedHeight }.compactMap { list.settledFrame(at: $0)?.height }.reduce(0, +)
        return frame.minY - list.viewportInsets.top - wrapping
    }

    private static func places(_ list: UltraListView) -> [String: CGFloat] {
        var places: [String: CGFloat] = [:]
        for index in shown(list) { places[list.items[index].identity] = place(index, list) }
        return places
    }

    /// Rows of a fixed height in a list resting at its top keep their
    /// places at any width.
    private static func moved(from places: [String: CGFloat], _ list: UltraListView) -> [String] {
        shown(list).compactMap { index in
            let id = list.items[index].identity
            guard let was = places[id], let now = place(index, list), abs(now - was) > 0.5 else { return nil }
            let above = list.loadedIndexRange.prefix { $0 < index }.map { "\(list.items[$0].identity)=\(list.settledFrame(at: $0)?.height ?? -1)" }
            return "\(id) moved from \(was) to \(now) under \(above) top=\(list.viewportInsets.top)"
        }
    }

    func testLegacyHomeKeepsEveryRowDrawnThroughWidthChanges() async throws {
        let app = try await HomeApp.legacy(self)
        for (name, change) in Self.sizes(of: app.window) {
            let list = try XCTUnwrap(app.legacyList, name)
            let places = Self.places(list)
            try await resize(app.window, to: change, "legacy home, \(name)") { [app] in
                guard let list = app.legacyList else { return ["the list went"] }
                return Self.drawnAtWidth(list) + Self.moved(from: places, list)
            }
            let after = try XCTUnwrap(app.legacyList)
            report("home \(name)", after)
            if after === list, let resize = after.lastResize, abs(resize.width - after.bounds.width) < 0.5 {
                XCTAssertEqual(resize.lateRows, 0, name)
                XCTAssertEqual(resize.keptRows, 0, name)
                XCTAssertGreaterThan(resize.fixedRows, 0, "\(name): home's rows have fixed heights")
            }
        }
    }

    func testComputersHomeKeepsEveryRowDrawnThroughWidthChanges() async throws {
        let app = try await HomeApp.computer(self)
        for (name, change) in Self.sizes(of: app.window) {
            let sidebar = try XCTUnwrap(app.sidebar, name)
            let places = Self.places(sidebar.list)
            // Each row's box as the list derives it at the new width, to
            // compare with what the frame of the change shows.
            var boxes: [(width: CGFloat, boxes: [String: CGRect])] = []
            try await resize(app.window, to: change, "computer's home, \(name)") { [app] in
                guard let sidebar = app.sidebar else { return ["the list went"] }
                var shown: [String: CGRect] = [:]
                for case let view as SidebarItemView in sidebar.list.loadedItemViews { shown[view.row.id] = view.box }
                boxes.append((sidebar.list.bounds.width, shown))
                return Self.drawnAtWidth(sidebar.list, skip: { $0 == SidebarNoticeItem.id }) + Self.moved(from: places, sidebar.list)
            }
            let after = try XCTUnwrap(app.sidebar)
            await after.settle()
            report("sidebar \(name)", after.list)
            // The boxes, fills and marks stood where the list's own layout
            // at the new width puts them, from the frame of the change on.
            if after === sidebar, let first = Self.first(boxes, at: after.list.bounds.width) {
                for case let view as SidebarItemView in after.list.loadedItemViews {
                    guard let box = first[view.row.id] else { continue }
                    XCTAssertEqual(box, view.box, "\(name): \(view.row.id)'s box in the frame of the change")
                }
            }
        }
    }

    // MARK: Card lists

    /// A screen's card list as Artifacts shows one: headings over cards of
    /// rows, a note at the foot.
    private nonisolated static func cards(width: CGFloat) -> [CardItem] {
        var items: [CardItem] = []
        let scale: CGFloat = 3
        for section in 0..<4 {
            items.append(CardItems.heading("heading:\(section)", "Section \(section)", trailing: "\(section * 3)", width: width, maxWidth: .greatestFiniteMagnitude, afterCard: section > 0, dark: false, displayScale: scale))
            for index in 0..<6 {
                var drawing = CardDrawing(dark: false, displayScale: scale)
                let card = CGRect(x: 16, y: 0, width: width - 32, height: 56)
                drawing.text("Artifact \(section)-\(index) with a long enough title to cut", CardFont(.medium, 16), Palette.text, CGRect(x: 32, y: 10, width: width - 96, height: 20))
                drawing.text("2 min", CardFont(.regular, 13), Palette.textSecondary, CGRect(x: width - 80, y: 10, width: 48, height: 16))
                var item = CardItem(id: "row:\(section)-\(index)", kind: .row, size: CGSize(width: width, height: 56), card: card, drawing: drawing, opens: true)
                item.place = CardPlace(first: index == 0, last: index == 5)
                items.append(item)
            }
        }
        items.append(CardItems.note("note", "Artifacts the agents make show here, newest first.", width: width, maxWidth: .greatestFiniteMagnitude, scale: 1, dark: false, displayScale: scale))
        return CardItems.revise(items, previous: [:], counter: &revision)
    }

    nonisolated(unsafe) private static var revision: UInt64 = 0

    func testCardListKeepsEveryRowDrawnThroughWidthChanges() async throws {
        let scene = try await hostedActiveScene()
        let root = UIViewController()
        let window = hostedKeyWindow(in: scene, root: root)
        addTeardownBlock { @MainActor in window.isHidden = true }
        let cards = CardListView(frame: root.view.bounds)
        cards.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.view.addSubview(cards)
        window.layoutIfNeeded()
        cards.setInsets(UIEdgeInsets(top: window.safeAreaInsets.top + 8, left: 0, bottom: 20, right: 0))
        func show() { cards.apply(Self.cards(width: cards.contentWidth), animated: false, replan: { Self.cards(width: $0) }) }
        show()
        let ready = try await until { !cards.list.loadedItemViews.isEmpty && cards.list.loadedItemViews.allSatisfy(\.isDisplayReady) }
        XCTAssertTrue(ready)
        for (name, change) in Self.sizes(of: window) {
            let places = Self.places(cards.list)
            try await resize(window, to: change, "card list, \(name)") {
                Self.drawnAtWidth(cards.list) + Self.moved(from: places, cards.list)
            }
            report("cards \(name)", cards.list)
            let resize = try XCTUnwrap(cards.list.lastResize, name)
            XCTAssertEqual(resize.lateRows, 0, name)
            XCTAssertEqual(resize.keptRows, 0, name)
            XCTAssertGreaterThan(resize.preparedRows, 0, name)
            // The screen derives its rows again at the new width, as
            // Artifacts' pipeline does.
            show()
        }
    }

    // MARK: Settings

    private static func cards(in scroll: UIScrollView) -> [SettingsCardView] {
        scroll.subviews.compactMap { $0 as? SettingsCardView }
    }

    func testSettingsPageLaysItsCardsOutAtTheNewWidthInTheSameFrame() async throws {
        let scene = try await hostedActiveScene()
        let page = SettingsPageViewController(title: "Appearance") {
            [(0..<6).map { SettingsRow(id: "row\($0)", title: "Row \($0)", value: "Value") }, (0..<4).map { SettingsRow(id: "more\($0)", title: "More \($0)") }]
        }
        let navigation = UINavigationController(rootViewController: page)
        func pageScroll() -> UIScrollView { page.scroll }
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in window.isHidden = true }
        window.layoutIfNeeded()
        for (name, change) in Self.sizes(of: window) {
            try await resize(window, to: change, "settings, \(name)") {
                // The cards stand centred in the page at its new width, in
                // the readable column the scroll view's insets leave.
                let bounds = page.view.bounds
                return bounds.width < 1 ? [] : navigation.view.subviews.isEmpty ? ["no page"] : Self.cards(in: pageScroll()).compactMap { card in
                    let frame = card.convert(card.bounds, to: page.view)
                    return abs(frame.midX - bounds.midX) > 0.5 || frame.minX < -0.5 || frame.maxX > bounds.width + 0.5 ? "a card at \(frame) in a page \(bounds.width) wide" : nil
                }
            }
        }
    }

    // MARK: Chats

    func testLegacyChatKeepsItsRowsDrawnAndItsPlaceThroughWidthChanges() async throws {
        let controller = try await signedIn()
        let session = try XCTUnwrap(controller.session)
        let context = AppContext(account: controller, variant: .preview, version: "resize")
        let chat = LegacyChatViewController(context: context, session: session, sessionId: FixtureScenarios.prefix + "long")
        let navigation = UINavigationController(rootViewController: UIViewController())
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        navigation.pushViewController(chat, animated: false)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in window.isHidden = true }
        window.layoutIfNeeded()
        let loaded = try await until(seconds: 30) {
            guard let rows = Self.find(ChatListView.self, in: chat.view) else { return false }
            return rows.isDisplayReady && rows.plans.count > 20
        }
        XCTAssertTrue(loaded, "the chat never drew")
        let rows = try XCTUnwrap(Self.find(ChatListView.self, in: chat.view))
        try await Task.sleep(for: .milliseconds(600))
        let list = rows.ultra.list
        // What each row shows, by identity, frame by frame.
        func shownPlans() -> [String: CGSize] {
            var shown: [String: CGSize] = [:]
            for index in Self.shown(list) {
                if let view = list.loadedItemView(at: index) as? ChatUltraRowView { shown[view.row.identity] = view.plan.size }
            }
            return shown
        }
        for reading in [false, true] {
            if reading {
                rows.setVisibleMinY(1200)
                try await Task.sleep(for: .milliseconds(600))
            }
            for (name, change) in Self.sizes(of: window) {
                let leg = "legacy chat \(reading ? "read up" : "at its newest"), \(name)"
                let read = Self.readingRow(list)
                var plans: [(width: CGFloat, boxes: [String: CGSize])] = []
                try await resize(window, to: change, leg) {
                    plans.append((list.bounds.width, shownPlans()))
                    var problems = Self.drawnAtWidth(list, skip: { $0 == "chat:older-end" || $0 == "chat:newer-end" })
                    if reading, let read, let now = Self.share(read, list), abs(now.share - read.share) > 0.12 {
                        problems.append("reading \(read.identity) at \(now.share), was \(read.share), frame \(now.frame) top=\(list.viewportInsets.top)")
                    }
                    if !reading, rows.distanceFromNewest > 1 { problems.append("left the newest row: \(rows.distanceFromNewest)") }
                    return problems
                }
                report("legacy-chat \(reading ? "reading" : "newest") \(name)", list)
                let resize = try XCTUnwrap(list.lastResize, leg)
                XCTAssertEqual(resize.lateRows, 0, leg)
                XCTAssertGreaterThan(resize.preparedRows, 0, leg)
                // The rows showed, from the frame of the change, the plans
                // the chat's own pipeline makes at the new width.
                let settled = shownPlans()
                for (id, size) in Self.first(plans, at: list.bounds.width) ?? [:] {
                    guard let final = settled[id] else { continue }
                    XCTAssertEqual(size, final, "\(leg): \(id) showed another plan in the frame of the change")
                }
                if reading, let read { Self.assertHolds(read, list, leg) }
            }
        }
        navigation.popToRootViewController(animated: false)
        await controller.signOut()
    }

    typealias Reading = (identity: String, share: CGFloat, top: CGFloat)

    /// The row the reader is on, at the list's reading edge, how much of it
    /// was past the edge, and the inset over the edge then.
    private static func readingRow(_ list: UltraListView) -> Reading? {
        for index in list.loadedIndexRange {
            guard let frame = list.settledFrame(at: index), frame.minY <= 0, frame.maxY > 0, frame.height > 0 else { continue }
            return (list.items[index].identity, -frame.minY / frame.height, CGFloat(list.viewportInsets.top))
        }
        return nil
    }

    /// How much of the row being read is past the reading edge now. The
    /// edge moves with the inset over it, as the list carries the rows
    /// with a composer that changes height (`compensatesInsetChange`).
    private static func share(_ read: Reading, _ list: UltraListView) -> (share: CGFloat, frame: CGRect)? {
        guard let index = list.items.firstIndex(where: { $0.identity == read.identity }), let frame = list.settledFrame(at: index) else { return nil }
        let edge = list.viewportInsets.top - read.top
        return ((edge - frame.minY) / max(1, frame.height), frame)
    }

    private static func assertHolds(_ read: Reading, _ list: UltraListView, _ leg: String) {
        guard let now = share(read, list) else { return XCTFail("\(leg): the row being read, \(read.identity), went off screen") }
        XCTAssertEqual(now.share, read.share, accuracy: 0.12, "\(leg): the reader's place in the row moved: \(now.frame)")
    }

    /// The texts in `view` with nothing drawn, and where they are.
    private static func undrawn(_ view: UIView) -> String {
        var found: [String] = []
        func walk(_ view: UIView) {
            if let text = view as? ChatTextView, !text.isHidden, !text.isDrawn, let window = text.window {
                let frame = text.convert(text.bounds, to: window)
                // Due to draw at this frame's commit, at once while on screen.
                // Drawn at this frame's commit, at once while on screen;
                // off screen, nothing shows of it.
                if text.layer.needsDisplay() || !frame.intersects(window.bounds) { view.subviews.forEach(walk); return }
                found.append("\(type(of: text)) \(Int(frame.minX)),\(Int(frame.minY)) \(Int(frame.width))x\(Int(frame.height)) onScreen=\(frame.intersects(window.bounds))")
            }
            view.subviews.forEach(walk)
        }
        walk(view)
        return found.joined(separator: "; ")
    }

    func testAgentChatKeepsItsRowsDrawnAndItsPlaceThroughWidthChanges() async throws {
        let computer = ResizeComputer()
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: ResizeOffline(), connector: ResizeNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let pairing = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"resize-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in Session.forget(pairing.id) }
        let context = AppContext(account: controller, variant: .preview, version: "resize")
        let session = try XCTUnwrap(Session.session(for: pairing.id, context: context))
        let chat = ChatViewController(session: session, agentId: "a", title: "Cache", spaceId: nil, intro: nil)
        let navigation = UINavigationController(rootViewController: chat)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in window.isHidden = true }
        window.layoutIfNeeded()
        let came = try await until(seconds: 30) { chat.plans.count >= 100 }
        XCTAssertTrue(came, "the turns never came in: \(chat.plans.count)")
        try await Task.sleep(for: .milliseconds(800))
        let transcript = try XCTUnwrap(Self.find(AgentChatUltraList.self, in: chat.view))
        let list = transcript.list
        func shownPlans() -> [String: ChatRowPlan] {
            var shown: [String: ChatRowPlan] = [:]
            for index in Self.shown(list) {
                if let view = list.loadedItemView(at: index) as? AgentChatRowView { shown[view.row.identity] = view.plan }
            }
            return shown
        }
        for reading in [false, true] {
            if reading {
                list.scrollTo(.init(index: 20, identity: list.items[20].identity), transition: .none)
                try await Task.sleep(for: .milliseconds(600))
            }
            for (name, change) in Self.sizes(of: window) {
                let leg = "agent chat \(reading ? "read up" : "at its newest"), \(name)"
                let read = Self.readingRow(list)
                var plans: [(width: CGFloat, boxes: [String: ChatRowPlan])] = []
                try await resize(window, to: change, leg) {
                    let shown = shownPlans()
                    plans.append((list.bounds.width, shown))
                    var problems: [String] = []
                    for index in Self.shown(list) {
                        guard let view = list.loadedItemView(at: index) as? AgentChatRowView else { continue }
                        let undrawn = Self.undrawn(view.canvas)
                        if !undrawn.isEmpty { problems.append("\(view.row.identity) is not drawn: " + undrawn) }
                    }
                    if !reading, transcript.distanceFromNewest > 1 { problems.append("left the newest row: \(transcript.distanceFromNewest)") }
                    return problems
                }
                print(String(format: "RESIZE_REPORT agent-chat-planning %@ %@ main=%.2fms rows=%d", reading ? "reading" : "newest", name, chat.inPlaceMilliseconds, chat.inPlaceRows))
                report("agent-chat \(reading ? "reading" : "newest") \(name)", list)
                // The rows showed, from the frame of the change, the very
                // plans the screen then planned for the whole transcript.
                let settled = shownPlans()
                var same = 0, compared = 0
                for (id, plan) in Self.first(plans, at: list.bounds.width) ?? [:] {
                    guard let final = settled[id] else { continue }
                    compared += 1
                    if final === plan { same += 1 }
                    XCTAssertEqual(plan.size, final.size, "\(leg): \(id) showed another plan in the frame of the change")
                }
                XCTAssertEqual(same, compared, "\(leg): rows drew a second time once the screen planned them")
                if reading, let read { Self.assertHolds(read, list, leg) }
            }
        }
        try? await controller.agentConnections.remove(pairing.id)
    }
}
#endif
