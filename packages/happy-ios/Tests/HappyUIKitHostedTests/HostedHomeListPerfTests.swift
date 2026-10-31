#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

private struct PerfNoNetwork: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct PerfNoSockets: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

private struct PerfUnreachable: AgentTransport {
    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        throw URLError(.cannotConnectToHost)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// A computer that serves only its projects' pictures: each a square of one
/// colour, so a test can see which one a row wears.
private struct PerfProjectPictures: AgentTransport {
    static let colors: [String: UIColor] = ["/v0/projects/chosen/avatar": .systemRed, "/v0/projects/made/avatar": .systemTeal]

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        guard let color = Self.colors[path] else { return HTTP1Response(status: 404) }
        let png = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).pngData { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
            UIColor.white.setFill()
            context.fill(CGRect(x: 20, y: 20, width: 24, height: 24))
        }
        return HTTP1Response(status: 200, headers: ["content-type": "image/png"], body: png)
    }
    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream {
        throw URLError(.cannotConnectToHost)
    }
    func reset() async {}
    func close() async {}
}

/// Home's list under the app's own frame meter (`GymFrameMeter`), on a
/// home as big as a busy account's: surfaces, a hundred bots with their
/// subtasks, tasks and projects, some of them working. The meter's
/// scripted scroll flings and drags it; each run prints `HOME_PERF` and
/// the meter's summary (frames, dropped, hitch time, main-thread time per
/// frame). With `HAPPY_PREVIEW_DIR` set, `testScreens` writes what home
/// looks like, light and dark, at its top and scrolled.
@MainActor
final class HostedHomeListPerfTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    static let thumbhash = "1QcSHQRnh493V4dIh4eXh1h4kJUI"

    /// A busy account's home, in the shapes `SidebarRows` makes.
    static func rows(bots: Int = 100, tasks: Int = 60, projects: Int = 8) -> [Row] {
        var rows: [Row] = []
        var artifacts = Row(id: "direct:artifacts", nodeId: "direct:artifacts", kind: .space, label: "Artifacts", mark: .glyph("doc"), targetKind: "artifacts")
        artifacts.targetId = nil
        rows.append(artifacts)
        for (index, type) in ["todo", "document", "calendar", "chat"].enumerated() {
            var row = Row(id: "surface:\(index)", nodeId: "surface:\(index)", kind: .space, label: ["Groceries", "Launch plan", "Family calendar", "Team chat"][index], mark: .glyph(type == "todo" ? "list" : type == "calendar" ? "calendar" : type == "chat" ? "users" : "doc"), targetKind: "surface")
            row.surfaceType = type
            row.targetId = "surface-\(index)"
            rows.append(row)
        }
        rows.append(Row(id: "direct:bots", nodeId: "direct:bots", kind: .separator, label: ""))
        let names = ["Happy", "Researcher", "Inbox triage", "Release captain", "Designer", "Reviewer", "Writer", "Planner", "Accountant", "Travel agent"]
        for index in 0..<bots {
            let mark: Row.Mark = index == 0 ? .happy : index.isMultiple(of: 3) ? .image(path: "/v0/bots/b\(index)/avatar", thumbhash: thumbhash) : .placeholder(seed: "bot-\(index)")
            let status: Row.Status = index % 7 == 1 ? .working : index % 11 == 2 ? .awaitingInput : index % 13 == 3 ? .waiting : .none
            var row = Row(id: "bot:b\(index)", nodeId: "bot:b\(index)", kind: .space, label: index < names.count ? names[index] : "\(names[index % names.count]) \(index)", mark: mark, status: status, unread: index % 5 == 4, isHappy: index == 0, agentId: "agent-b\(index)", workspaceId: "w-b\(index)", targetKind: "bot")
            row.targetId = "b\(index)"
            rows.append(row)
            for child in 0..<(index % 4 == 0 ? 2 : 0) {
                rows.append(Row(id: "session:b\(index)-\(child)", nodeId: "session:b\(index)-\(child)", kind: .session, depth: 1, label: "Subtask \(child + 1) of \(index)", status: child == 0 && index % 8 == 0 ? .working : .none, agentId: "agent-b\(index)-\(child)", workspaceId: "w-b\(index)-\(child)"))
            }
        }
        rows.append(Row(id: "direct:tasks", nodeId: "direct:tasks", kind: .separator, label: ""))
        for index in 0..<tasks {
            var row = Row(id: "task:t\(index)", nodeId: "task:t\(index)", kind: .space, label: "Task number \(index): ship the thing that was promised", mark: .placeholder(seed: "task-\(index)"), status: index % 6 == 0 ? .working : .none, unread: index % 4 == 1, agentId: "agent-t\(index)", workspaceId: "w-t\(index)", targetKind: "task")
            row.targetId = "t\(index)"
            rows.append(row)
        }
        rows.append(Row(id: "direct:projects", nodeId: "direct:projects", kind: .separator, label: ""))
        for index in 0..<projects {
            rows.append(Row(id: "project:p\(index)", nodeId: "project:p\(index)", kind: .space, label: "project-\(index)", mark: index.isMultiple(of: 2) ? .image(path: "/v0/projects/p\(index)/avatar", thumbhash: nil) : .none, targetKind: "project"))
            for session in 0..<3 {
                rows.append(Row(id: "session:p\(index)-\(session)", nodeId: "session:p\(index)-\(session)", kind: .session, depth: 1, label: "Session \(session) in project \(index)", agentId: "agent-p\(index)-\(session)", workspaceId: "w-p\(index)"))
            }
        }
        return rows
    }

    private func home(style: UIUserInterfaceStyle = .light, rows: [Row], transport: any AgentTransport = PerfUnreachable()) async throws -> (UIWindow, AgentHomeViewController, HomeViewController) {
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()),
            clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(),
            storeDirectory: nil,
            agentTransport: { _ in transport },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: PerfNoNetwork(),
            connector: PerfNoSockets()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"home-perf","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let home = AgentHomeViewController(context: context, id: computer.id)
        let navigation = UINavigationController(rootViewController: home)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        window.overrideUserInterfaceStyle = style
        window.layoutIfNeeded()
        // The engine's own first snapshot (nothing, unreachable) lands first.
        try await Task.sleep(for: .milliseconds(800))
        let v2 = try XCTUnwrap(home.children.compactMap { $0 as? HomeViewController }.first)
        var snapshot = HomeSnapshot()
        snapshot.loaded = true
        snapshot.live = true
        snapshot.syncing = false
        snapshot.rows = rows
        snapshot.allRows = rows
        v2.applyConnection(snapshot)
        home.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(600))
        return (window, home, v2)
    }

    private static func count(_ view: UIView) -> Int { 1 + view.subviews.reduce(0) { $0 + count($1) } }
    private static func layers(_ layer: CALayer) -> Int { 1 + (layer.sublayers ?? []).reduce(0) { $0 + layers($1) } }

    private static func find(_ id: String, in view: UIView) -> UIView? {
        if view.accessibilityIdentifier == id { return view }
        for child in view.subviews { if let found = find(id, in: child) { return found } }
        return nil
    }

    /// Flings and drags home's list with the meter's script, three times.
    func testScrollFrames() async throws {
        setenv("HAPPY_GYM_METER", "1", 1)
        let (window, _, v2) = try await home(rows: Self.rows())
        defer { window.isHidden = true }
        GymFrameMeter.installIfAsked(in: window)
        let meter = try XCTUnwrap(GymFrameMeter.shared)
        let list: UIView = v2.homeList.list
        list.accessibilityIdentifier = "transcript"
        let button = try XCTUnwrap(Self.find("gym-meter", in: window))
        print("HOME_PERF views=\(Self.count(list)) layers=\(Self.layers(list.layer))")
        setenv("HAPPY_GYM_SCRIPT", "down*3 up*3 dragdown*2 dragup*2", 1)
        for run in 0..<3 {
            meter.perform(NSSelectorFromString("runScript"))
            let deadline = ContinuousClock.now + .seconds(60)
            try await Task.sleep(for: .milliseconds(300))
            while button.accessibilityValue?.contains("scripting=1") == true, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(100))
            }
            print("HOME_PERF run=\(run) \(button.accessibilityValue ?? "")")
        }
    }

    /// Home at its top and scrolled, light and dark.
    func testScreens() async throws {
        let device = ProcessInfo.processInfo.environment["HAPPY_SCREEN_PREFIX"] ?? "\(Int(UIScreen.main.bounds.width))pt"
        for style in [UIUserInterfaceStyle.light, .dark] {
            let (window, _, v2) = try await home(style: style, rows: Self.rows(bots: 12, tasks: 6, projects: 2))
            try await Task.sleep(for: .milliseconds(800))
            keep(window, "\(device)-\(style == .dark ? "dark" : "light")-top")
            scroll(v2, by: 520)
            try await Task.sleep(for: .milliseconds(800))
            keep(window, "\(device)-\(style == .dark ? "dark" : "light")-scrolled")
            window.isHidden = true
        }
    }

    /// A daemon's projects as it sends them now: a picture the person
    /// chose, one it made, the home project, one with no picture yet, and an
    /// older daemon's URL. Each wears its face; "before" draws them as the
    /// list did when it read only `avatar.url`, with none.
    func testProjectAvatars() async throws {
        let json = #"""
        {"cursor":"c1","profile":{"userId":null},"userSettings":[],
         "projects":[
           {"id":"chosen","name":"happy","status":"active","orderKey":"a","avatar":{"kind":"image","source":"user","thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"},"agents":[]},
           {"id":"made","name":"site","status":"active","orderKey":"b","avatar":{"kind":"image","source":"generated","thumbhash":"HBkSHYSIeHiPiHh8eJd4eTN0EEQG"},"agents":[]},
           {"id":"home","name":"Home","status":"active","orderKey":"c","avatar":{"kind":"home"},"agents":[]},
           {"id":"fresh","name":"notes","status":"active","orderKey":"d","avatar":null,"agents":[]},
           {"id":"old","name":"legacy","status":"active","orderKey":"e","avatar":{"url":"/v0/projects/chosen/avatar","width":64,"height":64},"agents":[]}],
         "workspaces":[],"bots":[],"tasks":[],"taskMemberships":[],"surfaces":[]}
        """#
        let desktop = try JSONDecoder().decode(DesktopSnapshot.self, from: Data(json.utf8))
        let rows = SidebarRows.make(desktop, settings: [:])
        let device = ProcessInfo.processInfo.environment["HAPPY_SCREEN_PREFIX"] ?? "\(Int(UIScreen.main.bounds.width))pt"
        // What the list drew before: no project read a picture.
        let before = rows.map { row -> Row in
            var row = row
            if row.targetKind == "project" { row.mark = .none }
            return row
        }
        for (name, shown) in [("before", before), ("after", rows)] {
            let (window, _, v2) = try await home(rows: shown, transport: PerfProjectPictures())
            try await Task.sleep(for: .milliseconds(1200))
            keep(window, "\(device)-projects-\(name)")
            if name == "after" {
                let list = v2.homeList
                for id in ["chosen", "made", "old"] {
                    let view = try XCTUnwrap(list.view(for: "project:\(id)"), id)
                    let picture = try XCTUnwrap(view.markImage, id)
                    // The served picture, not its thumbhash: its middle is white.
                    XCTAssertEqual(picture.size.width, picture.size.height, id)
                    XCTAssertGreaterThan(Self.middleBrightness(picture), 0.9, "\(id) wears the computer's picture")
                }
                XCTAssertNotNil(list.view(for: "project:home")?.markImage, "home wears its house")
                XCTAssertNotNil(list.view(for: "project:fresh")?.markImage, "a project with no picture yet wears its placeholder")
            }
            window.isHidden = true
        }
    }

    private static func middleBrightness(_ image: UIImage) -> CGFloat {
        guard let cgImage = image.cgImage else { return 0 }
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        context?.interpolationQuality = .none
        let w = CGFloat(cgImage.width), h = CGFloat(cgImage.height)
        context?.draw(cgImage, in: CGRect(x: -w / 2, y: -h / 2, width: w, height: h))
        return CGFloat(min(pixel[0], pixel[1], pixel[2])) / 255
    }

    private func scroll(_ v2: HomeViewController, by distance: CGFloat) {
        let list = v2.homeList
        list.setContentOffsetY(-list.contentInsets.top + distance)
        list.layoutIfNeeded()
    }

    private func keep(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let directory = ProcessInfo.processInfo.environment["HAPPY_PREVIEW_DIR"] {
            try? image.pngData()?.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name).png"))
        }
    }
}
#endif
