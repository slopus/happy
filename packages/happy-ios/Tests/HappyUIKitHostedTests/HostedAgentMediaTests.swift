#if canImport(UIKit)
import AVKit
import Foundation
@testable import HappyCore
import HappyLayout
import HappyStore
import HappyWire
@testable import HappyUI
import UIKit
import UltraView
import XCTest

private struct MediaOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct MediaNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// One agent, `a`, on a paired computer, whose turn showed things: the
/// screenshots it read, the files it presented, a picture the person sent.
/// Each tool call's media is served by its index, a range at a time.
private actor MediaComputer: AgentTransport {
    var runs: [JSONValue]
    let files: [String: ArtifactDaemon.File]
    private(set) var fetched: [String] = []
    /// Its media route doesn't answer, as a computer away.
    var away = false

    init(runs: [JSONValue], files: [String: ArtifactDaemon.File]) {
        self.runs = runs
        self.files = files
    }

    func set(runs: [JSONValue]) { self.runs = runs }
    func set(away: Bool) { self.away = away }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) throws -> HTTP1Response {
        if path.hasPrefix("/v0/bots/"), path.hasSuffix("/avatar") {
            fetched.append(path)
            guard !away, let picture = files["avatar"] else { return HTTP1Response(status: away ? 502 : 404) }
            return .init(status: 200, body: picture.data)
        }
        if let range = path.range(of: "/tool-calls/") {
            let parts = path[range.upperBound...].split(separator: "/")
            guard parts.count == 3, let file = files["\(parts[0])/\(parts[2])"] else { return HTTP1Response(status: 404) }
            if away { return HTTP1Response(status: 502) }
            fetched.append("\(parts[0])/\(parts[2])")
            return ArtifactDaemon.serve(file, range: headers["Range"])
        }
        let value: JSONValue
        if path.contains("/agents/a/messages?") {
            value = .object(["hasMore": .bool(false), "runs": .array(runs)])
        } else if path.hasSuffix("/agents/a/bootstrap") {
            let running = runs.last?["status"]?.stringValue == "running"
            value = .object(["agent": .object(["id": .string("a"), "workspaceId": .string("w"), "status": .string(running ? "working" : "idle")]), "pending": .array([])])
        } else {
            value = .object([:])
        }
        return .init(status: 200, body: try JSONEncoder().encode(value))
    }

    func close() {}
}

/// The new chat shows what an agent's turn showed, where desktop shows it:
/// each call's line with its pictures, recordings or files under it,
/// screenshots read one after another as one grid, the person's own photo
/// in their message; still there once the turn folds and after a reload.
@MainActor
final class HostedAgentMediaTests: XCTestCase {
    // MARK: Fixtures

    /// Steve's history: a Read of a PNG presents it in two columns.
    static let thumbhash = "xgcCA4AnNsaAeSlmd3/+XGU="
    static let twoColumns: JSONValue = .object(["type": .string("columns"), "columns": .number(2)])

    static func text(_ text: String) -> JSONValue { .object(["type": .string("text"), "text": .string(text)]) }

    static func call(_ id: String, _ name: String, _ presentation: [String: JSONValue]) -> JSONValue {
        .object(["type": .string("tool_call"), "id": .string(id), "name": .string(name), "status": .string("completed"), "presentation": .object(presentation)])
    }

    static func item(_ kind: String, _ name: String, _ file: ArtifactDaemon.File, size: CGSize?) -> JSONValue {
        var item: [String: JSONValue] = ["kind": .string(kind), "name": .string(name), "mimeType": .string(file.mimeType), "size": .number(Double(file.data.count))]
        if let size {
            item["width"] = .number(size.width)
            item["height"] = .number(size.height)
            item["thumbhash"] = .string(thumbhash)
        }
        return .object(item)
    }

    static func screenshot(_ size: CGSize, _ color: UIColor) -> ArtifactDaemon.File {
        ArtifactDaemon.File(path: "f", mimeType: "image/png", data: HostedArtifactMediaTests.png(size, color))
    }

    @MainActor
    struct Turn {
        var files: [String: ArtifactDaemon.File]
        var sent: Data
        func run(ended: Bool) -> JSONValue {
            let read1 = files["t-read-1/0"]!, read2 = files["t-read-2/0"]!
            let user = TurnsMessages.message("u-r", role: "user", [
                HostedAgentMediaTests.text("Compare the headers before and after"),
                .object(["type": .string("image"), "mimeType": .string("image/png"), "data": .string(sent.base64EncodedString())]),
            ])
            var blocks: [JSONValue] = [
                HostedAgentMediaTests.text("I'll look at both screenshots."),
                HostedAgentMediaTests.call("t-read-1", "Read", ["type": .string("media"), "items": .array([item("image", "before.png", read1, size: CGSize(width: 1228, height: 550))]), "layout": twoColumns]),
                HostedAgentMediaTests.call("t-ls", "Glob", ["type": .string("exploration"), "operations": .array([.object(["kind": .string("search"), "command": .string("Glob *.png")])])]),
                HostedAgentMediaTests.call("t-read-2", "Read", ["type": .string("media"), "items": .array([item("image", "after.png", read2, size: CGSize(width: 1228, height: 550))]), "layout": twoColumns]),
                HostedAgentMediaTests.call("t-run", "exec_command", ["type": .string("exec_command"), "command": .string("make demo")]),
                HostedAgentMediaTests.call("t-show", "present_files", ["type": .string("media"), "items": .array([
                    item("video", "demo.mp4", files["t-show/0"]!, size: nil),
                    item("image", "light.png", files["t-show/1"]!, size: CGSize(width: 800, height: 600)),
                    item("image", "dark.png", files["t-show/2"]!, size: CGSize(width: 800, height: 600)),
                    item("image", "menu.png", files["t-show/3"]!, size: CGSize(width: 600, height: 900)),
                ])]),
            ]
            if ended { blocks.append(HostedAgentMediaTests.text("The new header is softer at its bottom edge.")) }
            var run: [String: JSONValue] = ["id": .string("r"), "status": .string(ended ? "completed" : "running"), "startedAt": .number(1_000), "messages": .array([
                user, TurnsMessages.message("m-r", role: "agent", blocks),
            ])]
            if ended { run["endedAt"] = .number(21_000); run["reason"] = .string("completed") }
            return .object(run)
        }
    }

    private static var made: Turn?

    private func turn() async throws -> Turn {
        if let made = Self.made { return made }
        let video = try await HostedVideoStreamTests.video(seconds: 1)
        let made = Turn(files: [
            "t-read-1/0": Self.screenshot(CGSize(width: 614, height: 275), UIColor(red: 0.30, green: 0.45, blue: 0.85, alpha: 1)),
            "t-read-2/0": Self.screenshot(CGSize(width: 614, height: 275), UIColor(red: 0.20, green: 0.65, blue: 0.55, alpha: 1)),
            "t-show/0": ArtifactDaemon.File(path: "f", mimeType: "video/mp4", data: video),
            "t-show/1": Self.screenshot(CGSize(width: 400, height: 300), UIColor(red: 0.95, green: 0.75, blue: 0.30, alpha: 1)),
            "t-show/2": Self.screenshot(CGSize(width: 400, height: 300), UIColor(red: 0.25, green: 0.25, blue: 0.32, alpha: 1)),
            "t-show/3": Self.screenshot(CGSize(width: 300, height: 450), UIColor(red: 0.80, green: 0.35, blue: 0.45, alpha: 1)),
        ], sent: HostedArtifactMediaTests.png(CGSize(width: 320, height: 240), UIColor(red: 0.55, green: 0.40, blue: 0.80, alpha: 1)))
        Self.made = made
        return made
    }

    override func tearDown() async throws {
        VideoOpening.shared.cancel()
    }

    // MARK: Harness

    private func session(_ computer: MediaComputer) async throws -> Session {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in computer },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: MediaOffline(), connector: MediaNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let pairing = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"media-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(pairing.id)
            try? await controller.agentConnections.remove(pairing.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        return try XCTUnwrap(Session.session(for: pairing.id, context: context))
    }

    private func open(_ session: Session, style: UIUserInterfaceStyle = .light) async throws -> (ChatViewController, UIWindow) {
        let chat = ChatViewController(session: session, agentId: "a", title: "Header", spaceId: nil, intro: nil)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: chat))
        window.overrideUserInterfaceStyle = style
        window.layoutIfNeeded()
        addTeardownBlock { @MainActor in
            if let presented = window.rootViewController?.presentedViewController {
                await withCheckedContinuation { continuation in presented.dismiss(animated: false) { continuation.resume() } }
            }
            window.isHidden = true
        }
        return (chat, window)
    }

    private func until(_ what: String, _ seconds: Double = 8, _ condition: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTFail("never: \(what)", file: file, line: line)
    }

    private func plan(_ chat: ChatViewController, _ id: String) -> ChatRowPlan? { chat.plans.first { $0.id == id } }

    /// The tiles a row draws, by key, in order.
    private func media(_ chat: ChatViewController, _ id: String) -> [ChatMedia] {
        plan(chat, id)?.items.compactMap { if case .media(let media, _) = $0 { media } else { nil } } ?? []
    }

    private func frames(_ chat: ChatViewController, _ id: String) -> [CGRect] {
        plan(chat, id)?.items.compactMap { if case .media(_, let frame) = $0 { frame } else { nil } } ?? []
    }

    private func views<View: UIView>(_ type: View.Type, in view: UIView) -> [View] {
        var found: [View] = []
        if let match = view as? View { found.append(match) }
        for subview in view.subviews { found += views(type, in: subview) }
        return found
    }

    private func scroll(_ chat: ChatViewController, to id: String) async throws {
        guard let transcript = views(AgentChatUltraList.self, in: chat.view).first,
              let index = transcript.list.items.firstIndex(where: { $0.identity == "chat:row:\(id)" }) else { return XCTFail("no row \(id)") }
        transcript.list.scrollTo(.init(index: index), transition: .none)
        try await Task.sleep(for: .milliseconds(300))
    }

    /// Every row a folded turn keeps, and what each shows.
    private func assertFolded(_ chat: ChatViewController, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(chat.plans.map(\.id), ["u-r", "t-read-1", "t-read-2", "t-show", "r:trace", "m-r/6", "r:status"], file: file, line: line)
        XCTAssertEqual(media(chat, "t-read-1").map(\.key), [], "its screenshot is drawn under the next read", file: file, line: line)
        XCTAssertEqual(media(chat, "t-read-2").map(\.key), ["tool/t-read-1/0", "tool/t-read-2/0"], file: file, line: line)
        XCTAssertEqual(media(chat, "t-show").map(\.key), ["tool/t-show/0", "tool/t-show/1", "tool/t-show/2", "tool/t-show/3"], file: file, line: line)
        XCTAssertEqual(media(chat, "u-r").map(\.key), ["sent/u-r:1"], file: file, line: line)
    }

    // MARK: Tests

    /// Live, each call shows what it showed under its line; the run's two
    /// reads are one two-column grid, the presented files one flow with the
    /// recording first. Ended, the turn folds and keeps every one of them;
    /// read again on another launch, the same.
    func testWhatATurnShowedStaysLiveFoldedAndAfterAReload() async throws {
        let turn = try await turn()
        let computer = MediaComputer(runs: [turn.run(ended: false)], files: turn.files)
        let session = try await session(computer)
        let (chat, _) = try await open(session)
        try await until("the live turn's media") { plan(chat, "t-show") != nil && plan(chat, "u-r") != nil }

        XCTAssertEqual(chat.plans.map(\.id), ["u-r", "m-r", "t-read-1", "t-ls", "t-read-2", "t-run", "t-show"])
        XCTAssertEqual(plan(chat, "t-read-1")?.accessibilityLabel, "Read before.png")
        XCTAssertEqual(plan(chat, "t-read-2")?.accessibilityLabel, "Read after.png")
        XCTAssertEqual(plan(chat, "t-show")?.accessibilityLabel, "Files demo.mp4, light.png, dark.png, menu.png")
        XCTAssertEqual(media(chat, "t-read-2").map(\.key), ["tool/t-read-1/0", "tool/t-read-2/0"])
        XCTAssertEqual(media(chat, "t-read-2").map(\.thumbhash), [Self.thumbhash, Self.thumbhash])
        // Two columns under the line, 8 apart, 8 under it.
        let grid = frames(chat, "t-read-2")
        XCTAssertEqual(grid.count, 2)
        XCTAssertEqual(grid[0].minY, 34)
        XCTAssertEqual(grid[1].minX - grid[0].maxX, 8, accuracy: 0.5)
        XCTAssertEqual(grid[0].minY, grid[1].minY)
        let shown = media(chat, "t-show")
        XCTAssertEqual(shown.map(\.isVideo), [true, false, false, false])
        let flow = frames(chat, "t-show")
        XCTAssertGreaterThan(flow[0].minY, flow[1].maxY, "the recording follows the pictures")
        XCTAssertEqual(media(chat, "u-r").count, 1, "the person's photo is in their message")

        // The pictures arrive into the media store and show.
        try await scroll(chat, to: "t-read-2")
        try await until("the screenshots load", 10) {
            let tiles = views(ChatMediaView.self, in: chat.view).filter { $0.item?.key.hasPrefix("tool/t-read-") == true }
            return tiles.count == 2 && tiles.allSatisfy { $0.pictureImage != nil }
        }
        let fetched = await computer.fetched
        XCTAssertTrue(fetched.contains("t-read-1/0") && fetched.contains("t-read-2/0"), "\(fetched)")

        // The turn ends: it folds, and what it showed stays.
        let ended = turn.run(ended: true)
        await computer.set(runs: [ended])
        await session.store.externalEvent(.object(["type": .string("message.updated"), "payload": .object([
            "agentId": .string("a"), "runId": .string("r"), "message": ended["messages"]?.arrayValue?[1] ?? .null,
        ])]))
        await session.store.externalEvent(.object(["type": .string("run.finished"), "payload": .object([
            "agentId": .string("a"), "run": .object(["id": .string("r"), "status": .string("completed"), "reason": .string("completed"), "startedAt": .number(1_000), "endedAt": .number(21_000)]),
        ])]))
        try await until("the turn folds") { plan(chat, "r:status") != nil }
        assertFolded(chat)
        XCTAssertEqual(plan(chat, "r:trace")?.accessibilityLabel, "View traces, 5 tools")

        // Read again on another launch: folded, the same.
        let (again, _) = try await open(try await self.session(MediaComputer(runs: [ended], files: turn.files)))
        try await until("the reloaded turn") { plan(again, "r:status") != nil && plan(again, "u-r") != nil }
        assertFolded(again)
    }

    /// A tap on a picture opens the viewer at it, among every picture of
    /// the conversation; a tap on the recording plays it, streaming.
    func testATapOpensThePictureAndPlaysTheRecording() async throws {
        let turn = try await turn()
        let computer = MediaComputer(runs: [turn.run(ended: true)], files: turn.files)
        let (chat, window) = try await open(try await session(computer))
        try await until("the folded turn") { plan(chat, "r:status") != nil }
        let picture = try XCTUnwrap(plan(chat, "t-read-2")?.hits.first { $0.action == .openMedia("tool/t-read-1/0") }, "the first read's tile opens it")
        chat.act(picture.action)
        try await until("the viewer") { window.rootViewController?.presentedViewController is PictureViewController }
        let viewer = try XCTUnwrap(window.rootViewController?.presentedViewController as? PictureViewController)
        // After the person's photo: every picture of the conversation, in its order.
        XCTAssertEqual(viewer.index, 1)
        await withCheckedContinuation { continuation in viewer.dismiss(animated: false) { continuation.resume() } }

        XCTAssertNotNil(plan(chat, "t-show")?.hits.first { $0.action == .openMedia("tool/t-show/0") }, "the recording's tile plays it")
        chat.act(.openMedia("tool/t-show/0"))
        try await until("the player", 15) { window.rootViewController?.presentedViewController is AVPlayerViewController }
    }

    /// The profile, pushed over its chat.
    private func profile(_ session: Session) async throws -> SessionDetailViewController {
        let detail = SessionDetailViewController(session: session, agentId: "a", title: "Header", spaceId: nil)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: detail))
        addTeardownBlock { @MainActor in window.isHidden = true }
        window.layoutIfNeeded()
        return detail
    }

    private func squares(_ detail: SessionDetailViewController) -> [SharedMediaCell] { views(SharedMediaCell.self, in: detail.view) }

    /// The chat's profile shows what it shared as the chat does: every
    /// picture and the recording's first frame read and drawn, not left on
    /// its thumbhash.
    func testTheProfilesSharedMediaLoads() async throws {
        let turn = try await turn()
        let detail = try await profile(try await session(MediaComputer(runs: [turn.run(ended: true)], files: turn.files)))
        try await until("the shared media", 10) {
            let cells = squares(detail)
            return cells.count == 7 && cells.allSatisfy { $0.pictureImage != nil }
        }
        XCTAssertEqual(squares(detail).map { $0.shown?.key }, ["tool/t-show/0", "tool/t-show/1", "tool/t-show/2", "tool/t-show/3", "tool/t-read-2/0", "tool/t-read-1/0", "sent/u-r#0"])
        // The chat's own tile in each square: the recording under its ring.
        XCTAssertEqual(squares(detail).map { $0.mediaTile?.item?.isVideo }, [true, false, false, false, false, false, false])
        XCTAssertNotNil(squares(detail)[0].mediaTile?.ring)
    }

    /// Opened while the computer is away, the profile's squares wait on
    /// their thumbhashes with the download's ring; once it is back they
    /// read and draw by themselves, as the chat's do.
    func testTheProfilesMediaArrivesWhenTheComputerIsBack() async throws {
        let turn = try await turn()
        let computer = MediaComputer(runs: [turn.run(ended: true)], files: turn.files)
        await computer.set(away: true)
        let session = try await session(computer)
        let detail = try await profile(session)
        try await until("the reads give up", 15) {
            let tiles = squares(detail).filter { $0.shown?.isPicture == true && !$0.shown!.key.hasPrefix("sent/") }.compactMap(\.mediaTile)
            return tiles.count == 5 && tiles.allSatisfy { if case .failed? = $0.downloadPhase { true } else { false } }
        }
        XCTAssertEqual(squares(detail).filter { $0.pictureImage != nil }.map { $0.shown?.key }, ["sent/u-r#0"], "only the person's own photo, which is here")

        await computer.set(away: false)
        await session.store.externalResync(loadSidebar: false)
        try await until("the shared media", 15) { squares(detail).count == 7 && squares(detail).allSatisfy { $0.pictureImage != nil } }
    }

    /// A bot's picture asked for while the computer was away (as a launch
    /// draws the kept rows before it answers) shows once it is back, in
    /// place of its thumbhash; before, it stayed on the thumbhash for good.
    func testAnAvatarAskedForWhileAwayShowsWhenTheComputerIsBack() async throws {
        let turn = try await turn()
        var files = turn.files
        files["avatar"] = Self.screenshot(CGSize(width: 300, height: 300), UIColor(red: 0.85, green: 0.30, blue: 0.25, alpha: 1))
        let computer = MediaComputer(runs: [turn.run(ended: true)], files: files)
        await computer.set(away: true)
        let session = try await session(computer)
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(#"""
        {"cursor":"c1","profile":{"userId":null},"userSettings":[],"projects":[],"workspaces":[],"surfaces":[],
         "bots":[{"id":"bot-a","name":"Header","status":"active","avatar":{"thumbhash":"\#(Self.thumbhash)"},"agent":{"id":"a","workspaceId":"w","status":"idle"}}]}
        """#.utf8))
        var home = HomeSnapshot()
        home.loaded = true
        home.allRows = SidebarRows.make(desktop, settings: [:])
        home.rows = Rows.visible(home.allRows)
        // After the engine's own first snapshot, which would replace it.
        var first = await session.engine.snapshots().makeAsyncIterator()
        _ = await first.next()
        try await Task.sleep(for: .milliseconds(100))
        session.receive(home: home)

        let detail = try await profile(session)
        XCTAssertEqual(detail.header.avatar, .mark(.image(path: "/v0/bots/bot-a/avatar", thumbhash: Self.thumbhash)))
        let mark = detail.header.mark
        try await until("the picture is asked for") { await computer.fetched.contains("/v0/bots/bot-a/avatar") }
        try await Task.sleep(for: .milliseconds(300))
        func pixels(_ image: UIImage?) -> CGFloat { image.map { $0.size.width * $0.scale } ?? 0 }
        XCTAssertLessThan(pixels(mark.pictureImage), 64, "away: its thumbhash")

        await computer.set(away: false)
        home.live = true
        session.receive(home: home)
        try await until("the picture") { pixels(mark.pictureImage) >= 200 }
    }

    // MARK: Screenshots

    /// The rows beside desktop's, light and dark: live, then folded. Written
    /// to `MEDIA_SCREENS` when it is set.
    func testScreenshotsOfWhatATurnShowed() async throws {
        guard let directory = ProcessInfo.processInfo.environment["MEDIA_SCREENS"] else { throw XCTSkip("MEDIA_SCREENS not set") }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let turn = try await turn()
        for style: UIUserInterfaceStyle in [.light, .dark] {
            let name = style == .dark ? "dark" : "light"
            for ended in [false, true] {
                let computer = MediaComputer(runs: [turn.run(ended: ended)], files: turn.files)
                let (chat, window) = try await open(try await session(computer), style: style)
                try await until("the transcript") { plan(chat, "t-show") != nil && (!ended || plan(chat, "r:status") != nil) }
                try await scroll(chat, to: ended ? "r:status" : "t-show")
                try await until("the pictures", 10) {
                    let tiles = views(ChatMediaView.self, in: chat.view).filter { $0.item?.isVideo == false && $0.window != nil }
                    return !tiles.isEmpty && tiles.allSatisfy { $0.pictureImage != nil }
                }
                try await Task.sleep(for: .milliseconds(600))
                try shoot(window, to: "\(directory)/ios-media-\(ended ? "folded" : "live")-\(name).png")
                window.isHidden = true
            }
        }
    }

    private func shoot(_ window: UIWindow, to path: String) throws {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try XCTUnwrap(image.pngData()).write(to: URL(fileURLWithPath: path))
    }
}

/// Wire messages, as the computer sends them.
enum TurnsMessages {
    static func message(_ id: String, role: String, _ content: [JSONValue]) -> JSONValue {
        .object(["id": .string(id), "role": .string(role), "createdAt": .number(1), "metadata": .object([:]), "content": .array(content)])
    }
}
#endif
