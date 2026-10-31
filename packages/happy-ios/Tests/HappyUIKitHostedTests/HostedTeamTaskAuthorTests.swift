#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

/// A computer in a team: Alex signed in (a blue picture), tasks Alex made,
/// that Ada (a red picture) and Bo (none) made, and one nobody owns; a bot
/// and a project beside them. Pictures are served solid, so a row's mark
/// tells whose it is by its colour.
private actor TeamDaemon: AgentTransport {
    static let alexHash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"
    static let adaHash = "HBkSHYSIeHiPiHh8eJd4eTN0EEQG"
    static let fixture = #"""
    {"cursor":"cursor-1","profile":{"userId":"alex","name":"Alex","photo":{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}},"userSettings":[],
     "projects":[{"id":"p","name":"happy","status":"active","orderKey":"a","agents":[]}],
     "workspaces":[],
     "bots":[{"id":"research","name":"Research","status":"active","agent":{"id":"research-agent","workspaceId":"r","status":"idle"}}],
     "tasks":[
       {"id":"mine","name":"Ship the release notes","ownerUserId":"alex","agent":{"id":"mine-agent","workspaceId":"w1","status":"idle"}},
       {"id":"adas","name":"Fix the login redirect","ownerUserId":"ada","agent":{"id":"adas-agent","workspaceId":"w2","status":"idle"}},
       {"id":"bos","name":"Plan the offsite","ownerUserId":"bo","agent":{"id":"bos-agent","workspaceId":"w3","status":"idle"}},
       {"id":"nobodys","name":"Tidy the backlog","ownerUserId":null,"agent":{"id":"nobodys-agent","workspaceId":"w4","status":"idle"}}],
     "taskMemberships":[{"taskId":"mine"},{"taskId":"adas"},{"taskId":"bos"},{"taskId":"nobodys"}],
     "surfaces":[]}
    """#
    static let users = #"""
    {"users":[
      {"id":"ada","name":"Ada","photo":{"thumbhash":"HBkSHYSIeHiPiHh8eJd4eTN0EEQG"},"version":"1","updatedAt":1},
      {"id":"bo","name":"Bo","photo":null,"version":"1","updatedAt":1}]}
    """#
    typealias RGB = (r: CGFloat, g: CGFloat, b: CGFloat)
    static let red: RGB = (0.9, 0.1, 0.1)
    static let blue: RGB = (0.1, 0.2, 0.9)

    let bootstrap: String
    private let photos: [String: Data]
    private(set) var requested: [String] = []
    private var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []

    init(team: Bool) {
        bootstrap = team ? Self.fixture : Self.fixture.replacingOccurrences(of: #""userId":"alex""#, with: #""userId":null"#)
        func solid(_ color: RGB) -> Data {
            UIGraphicsImageRenderer(size: CGSize(width: 96, height: 96)).image { context in
                UIColor(red: color.r, green: color.g, blue: color.b, alpha: 1).setFill()
                context.fill(CGRect(x: 0, y: 0, width: 96, height: 96))
            }.pngData()!
        }
        photos = ["/v0/users/ada/photo": solid(Self.red), "/v0/users/alex/photo": solid(Self.blue)]
    }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        requested.append(path)
        if path == "/v0/bootstrap/desktop" { return HTTP1Response(status: 200, body: Data(bootstrap.utf8)) }
        if path.hasPrefix("/v0/users?ids=") { return HTTP1Response(status: 200, body: Data(Self.users.utf8)) }
        if let photo = photos[path] { return HTTP1Response(status: 200, headers: ["content-type": "image/png"], body: photo) }
        return HTTP1Response(status: 404, body: Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuations.append(continuation)
        continuation.yield(Data("event: hello\ndata: {\"cursor\":\"cursor-1\",\"resumed\":true}\n\n".utf8))
        return HTTP1Stream(status: 200, body: body)
    }

    func reset() async {}
    func close() async { continuations.forEach { $0.finish() }; continuations.removeAll() }
}

private struct TeamOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct TeamNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// Home's list on a team computer: each task wears the face of the member
/// who made it, the person's own included, in place of its placeholder;
/// a member without a picture wears their own placeholder, seeded by
/// their user ID. Outside a team every task wears its own. The task's
/// profile wears what its row wears.
@MainActor
final class HostedTeamTaskAuthorTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private func rows(team: Bool) throws -> [Row] {
        let json = team ? TeamDaemon.fixture : TeamDaemon.fixture.replacingOccurrences(of: #""userId":"alex""#, with: #""userId":null"#)
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(json.utf8))
        let users = try JSONDecoder().decode([String: [TeamUser]].self, from: Data(TeamDaemon.users.utf8))["users"] ?? []
        return SidebarRows.make(desktop, settings: [:], users: Dictionary(uniqueKeysWithValues: users.map { ($0.id, $0) }))
    }

    private func list(rows: [Row], daemon: TeamDaemon, style: UIUserInterfaceStyle) async throws -> (SidebarList, UIWindow) {
        let root = UIViewController()
        root.view.backgroundColor = UIColor(Palette.groupedGround)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: root)
        window.overrideUserInterfaceStyle = style
        addTeardownBlock { @MainActor in window.isHidden = true }
        let list = SidebarList(frame: window.bounds.inset(by: window.safeAreaInsets))
        list.images = Images(client: AgentClient(transport: daemon, token: "t"))
        root.view.addSubview(list)
        list.layoutIfNeeded()
        list.apply(rows)
        await list.settle()
        return (list, window)
    }

    private func until(_ what: String, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition(), Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(condition(), what)
    }

    /// The colour in the middle of a mark.
    private func middle(_ image: UIImage?) -> UIColor? {
        guard let image, let cg = image.cgImage else { return nil }
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        context?.draw(cg, in: CGRect(x: -CGFloat(cg.width / 2), y: -CGFloat(cg.height / 2), width: CGFloat(cg.width), height: CGFloat(cg.height)))
        return UIColor(red: CGFloat(pixel[0]) / 255, green: CGFloat(pixel[1]) / 255, blue: CGFloat(pixel[2]) / 255, alpha: 1)
    }

    private func isColor(_ image: UIImage?, _ b: TeamDaemon.RGB) -> Bool {
        guard let shown = middle(image) else { return false }
        var a = (r: CGFloat(0), g: CGFloat(0), b: CGFloat(0), a: CGFloat(0))
        shown.getRed(&a.r, green: &a.g, blue: &a.b, alpha: &a.a)
        return abs(a.r - b.r) < 0.08 && abs(a.g - b.g) < 0.08 && abs(a.b - b.b) < 0.08
    }

    private func placeholder(_ seed: String, in view: SidebarItemView) async throws -> UIImage {
        let side = try XCTUnwrap(view.frames.mark?.width)
        let image = await AvatarPlaceholderImages.image(seed: seed, side: side)
        return try XCTUnwrap(image)
    }

    func testATeamTaskRowWearsItsAuthorsFace() async throws {
        let daemon = TeamDaemon(team: true)
        let (list, _) = try await list(rows: rows(team: true), daemon: daemon, style: .light)
        let mine = try XCTUnwrap(list.view(for: "task:mine"))
        let adas = try XCTUnwrap(list.view(for: "task:adas"))
        let bos = try XCTUnwrap(list.view(for: "task:bos"))
        let nobodys = try XCTUnwrap(list.view(for: "task:nobodys"))
        // The member's picture, read where the computer serves it.
        try await until("Ada's task wears Ada's picture") { isColor(adas.markImage, TeamDaemon.red) }
        try await until("Alex's own task wears Alex's picture") { isColor(mine.markImage, TeamDaemon.blue) }
        // No picture: Bo's own placeholder, not the task's.
        let bo = try await placeholder("bo", in: bos)
        try await until("Bo's task wears Bo's placeholder") { bos.markImage === bo }
        XCTAssertFalse(bos.markImage === AvatarPlaceholderImages.cached(seed: "bos", side: bos.frames.mark!.width))
        // Nobody owns it: the task's own placeholder.
        let task = try await placeholder("nobodys", in: nobodys)
        try await until("an unowned task wears its own placeholder") { nobodys.markImage === task }
        // A bot keeps its own.
        let research = try XCTUnwrap(list.view(for: "bot:research"))
        let bot = try await placeholder("research", in: research)
        try await until("a bot wears its own placeholder") { research.markImage === bot }
        let photos = await daemon.requested.filter { $0.hasSuffix("/photo") }
        XCTAssertEqual(Set(photos), ["/v0/users/ada/photo", "/v0/users/alex/photo"])
    }

    func testOutsideATeamATaskRowWearsItsOwnPlaceholder() async throws {
        let daemon = TeamDaemon(team: false)
        let (list, _) = try await list(rows: rows(team: false), daemon: daemon, style: .light)
        for id in ["mine", "adas", "bos", "nobodys"] {
            let view = try XCTUnwrap(list.view(for: "task:\(id)"), id)
            let own = try await placeholder(id, in: view)
            try await until("\(id) wears its own placeholder") { view.markImage === own }
        }
        let photos = await daemon.requested.filter { $0.hasPrefix("/v0/users") }
        XCTAssertEqual(photos, [])
    }

    /// Home's list on a team computer, light and dark, for the eye: written
    /// to `HAPPY_PREVIEW_DIR` when set.
    func testTheTeamListLightAndDark() async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let daemon = TeamDaemon(team: true)
            let (list, window) = try await list(rows: rows(team: true), daemon: daemon, style: style)
            let adas = try XCTUnwrap(list.view(for: "task:adas"))
            let mine = try XCTUnwrap(list.view(for: "task:mine"))
            let bos = try XCTUnwrap(list.view(for: "task:bos"))
            let bo = try await placeholder("bo", in: bos)
            try await until("the pictures arrived") { isColor(adas.markImage, TeamDaemon.red) && isColor(mine.markImage, TeamDaemon.blue) && bos.markImage === bo }
            try await Task.sleep(for: .milliseconds(400))
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            let name = "team-task-authors-\(style == .dark ? "dark" : "light")"
            let attachment = XCTAttachment(image: image)
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
            if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
                try image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
            }
            window.isHidden = true
        }
    }

    // MARK: The task's profile

    private func session(team: Bool) async throws -> Session {
        let daemon = TeamDaemon(team: team)
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in daemon },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: TeamOffline(), connector: TeamNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"team-authors-\#(team)","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
            withExtendedLifetime(controller) {}
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        await session.engine.start()
        return session
    }

    private func profile(_ session: Session, agentId: String) async throws -> SessionDetailViewController {
        let detail = SessionDetailViewController(session: session, agentId: agentId, title: "", spaceId: nil)
        let window = hostedKeyWindow(in: try await hostedActiveScene(), root: UINavigationController(rootViewController: detail))
        addTeardownBlock { @MainActor in window.isHidden = true }
        window.layoutIfNeeded()
        return detail
    }

    func testATeamTasksProfileWearsItsAuthorsFace() async throws {
        let session = try await session(team: true)
        let adas = try await profile(session, agentId: "adas-agent")
        try await until("Ada's task's profile wears Ada's picture") { adas.header.avatar == .mark(.image(path: "/v0/users/ada/photo", thumbhash: TeamDaemon.adaHash)) }
        let bos = try await profile(session, agentId: "bos-agent")
        try await until("Bo's task's profile wears Bo's placeholder") { bos.header.avatar == .mark(.placeholder(seed: "bo")) }
    }

    func testOutsideATeamATasksProfileWearsItsOwnPlaceholder() async throws {
        let session = try await session(team: false)
        let adas = try await profile(session, agentId: "adas-agent")
        try await until("the task's profile wears its own placeholder") { adas.header.avatar == .mark(.placeholder(seed: "adas")) }
    }
}
#endif
