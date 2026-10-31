#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
import HappyWire
@testable import HappyUI
import UIKit
import XCTest

private struct ProfileOffline: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse { throw URLError(.notConnectedToInternet) }
}

private struct ProfileNoSocket: WebSocketConnector {
    func connect(to url: URL) async throws -> WebSocketConnection { throw URLError(.notConnectedToInternet) }
}

/// A computer that answers the profile routes as happy-agent does, and
/// nothing else: new work is never answered, the event stream never opens.
private actor ProfileDaemon: AgentTransport {
    struct Sent: Sendable { var method: String; var path: String; var headers: [String: String]; var body: Data? }
    private(set) var sent: [Sent] = []
    private var count = 1
    private(set) var version = ProfileDaemon.version(1)
    private var name: String? = "Alex Rivera"
    private var photo: Data?
    private var held: [CheckedContinuation<Void, Never>] = []
    var holdingPatches = false
    var conflicts = 0
    var failing = false

    init(photo: Data?) { self.photo = photo }

    static func version(_ n: Int) -> String { String(format: "0199a000-0000-7000-8000-%012d", n) }

    func hold(_ on: Bool) {
        holdingPatches = on
        if !on { held.forEach { $0.resume() }; held = [] }
    }
    func conflict(_ times: Int) { conflicts = times }
    func fail(_ on: Bool) { failing = on }
    var patches: [Sent] { sent.filter { $0.method == "PATCH" } }

    private func bump() { count += 1; version = Self.version(count) }

    func request(method: String, path: String, credential: String, body: Data?, headers: [String: String]) async throws -> HTTP1Response {
        sent.append(Sent(method: method, path: path, headers: headers, body: body))
        switch (method, path) {
        case ("GET", "/v0/profile"):
            return answer()
        case ("PATCH", "/v0/profile"):
            if holdingPatches { await withCheckedContinuation { held.append($0) } }
            if failing { return HTTP1Response(status: 500, body: Data(#"{"error":"The disk is full.","code":"internal"}"#.utf8)) }
            if conflicts > 0 || headers["If-Match"] != version {
                conflicts = max(0, conflicts - 1)
                bump()
                return HTTP1Response(status: 409, body: Data(#"{"error":"The profile has changed.","code":"version_conflict"}"#.utf8))
            }
            name = try JSONDecoder().decode(JSONValue.self, from: body ?? Data())["name"]?.stringValue
            bump()
            return answer()
        case ("PUT", "/v0/profile/photo"):
            photo = body
            bump()
            return answer()
        case ("DELETE", "/v0/profile/photo"):
            photo = nil
            bump()
            return answer()
        case ("GET", "/v0/profile/photo"):
            guard let photo else { return HTTP1Response(status: 404) }
            return HTTP1Response(status: 200, headers: ["content-type": "image/jpeg", "etag": "\"\(photo.count)\""], body: photo)
        case ("POST", "/v0/spaces/stem-cells"):
            // New work is made on the phone at once; the computer is slow.
            try await Task.sleep(for: .seconds(60))
            throw URLError(.timedOut)
        default:
            return HTTP1Response(status: 404, body: Data(#"{"error":"Not here.","code":"not_found"}"#.utf8))
        }
    }

    private func answer() -> HTTP1Response {
        // A ThumbHash of a flat colour: any valid one will do.
        let photo = photo == nil ? "null" : #"{"thumbhash":"1QcSHQRnh493V4dIh4eXh1h4kJUI"}"#
        let name = name.map { "\"\($0)\"" } ?? "null"
        return HTTP1Response(status: 200, body: Data(#"{"profile":{"email":null,"name":\#(name),"photo":\#(photo),"userId":null,"updatedAt":1,"version":"\#(version)"}}"#.utf8))
    }

    func stream(path: String, credential: String, headers: [String: String]) async throws -> HTTP1Stream { throw URLError(.cannotConnectToHost) }
    func reset() async {}
    func close() async {}
}

/// Settings for an agent connection: the person's Profile row and page,
/// and the two rows that ask the agent to change its own name or picture.
/// Pictures go to the repository's `.context/evidence/profile`.
@MainActor
final class HostedProfileSettingsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/profile")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    private func capture(_ window: UIWindow, _ name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let file = "\(name)-\(window.traitCollection.userInterfaceStyle == .dark ? "dark" : "light")"
        let attachment = XCTAttachment(image: image)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence, let data = image.pngData() {
            try? data.write(to: folder.appendingPathComponent("\(file).png"))
        }
    }

    /// A picture to have: a soft gradient with a circle in it.
    private static func picture(side: CGFloat = 600) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: side * 1.5, height: side), format: format).image { context in
            let colors = [UIColor(red: 0.98, green: 0.62, blue: 0.35, alpha: 1).cgColor, UIColor(red: 0.55, green: 0.36, blue: 0.96, alpha: 1).cgColor]
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: side * 1.5, y: side), options: [])
            UIColor.white.withAlphaComponent(0.85).setFill()
            context.cgContext.fillEllipse(in: CGRect(x: side * 0.75 - side * 0.2, y: side * 0.25, width: side * 0.4, height: side * 0.4))
        }
    }

    private struct Rig {
        let controller: AccountController
        let daemon: ProfileDaemon
        let context: AppContext
        let session: Session
        let computerID: String
    }

    private func rig(photo: Bool = false) async throws -> Rig {
        let daemon = ProfileDaemon(photo: photo ? Self.picture().jpegData(compressionQuality: 0.9) : nil)
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in daemon },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: ProfileOffline(), connector: ProfileNoSocket()
        )
        await controller.agentConnections.setForeground(false)
        let computer = try await controller.agentConnections.add(
            JSONDecoder().decode(AgentConnectionCredentials.self, from: Data(#"{"address":"profile-test","port":1,"deviceID":"\#(UUID().uuidString)","deviceToken":"token"}"#.utf8)),
            name: "Studio Mac"
        )
        addTeardownBlock { @MainActor in
            Session.forget(computer.id)
            try? await controller.agentConnections.remove(computer.id)
        }
        let context = AppContext(account: controller, variant: .preview, version: "test")
        let session = try XCTUnwrap(Session.session(for: computer.id, context: context))
        return Rig(controller: controller, daemon: daemon, context: context, session: session, computerID: computer.id)
    }

    private func host(_ root: UIViewController, style: UIUserInterfaceStyle = .light) async throws -> (UINavigationController, UIWindow) {
        let navigation = UINavigationController(rootViewController: root)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        window.overrideUserInterfaceStyle = style
        addTeardownBlock { @MainActor in
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        return (navigation, window)
    }

    // MARK: Settings

    /// Edit name is gone, and so is renaming by tapping the heading: the
    /// two asks are in its place, under the person's Profile row, which
    /// shows their name and opens their page. All three are found by search.
    func testSettingsAsksTheAgentAndOpensTheProfile() async throws {
        let rig = try await rig(photo: true)
        let settings = SettingsViewController(context: rig.context, computer: rig.computerID)
        let (navigation, window) = try await host(settings)
        try await until { settings.shownRow("profile")?.value == "Alex Rivera" && settings.shownRow("profile")?.image != nil }

        let cards = settings.shownRowIDs
        XCTAssertFalse(cards.joined().contains("edit-name"), "Edit name is still on the page")
        XCTAssertTrue(cards.contains(["profile"]), "the Profile row is not a card of its own: \(cards)")
        XCTAssertTrue(cards.contains(["change-agent-name", "change-agent-avatar", "status"]), "the asks aren't where Edit name was: \(cards)")
        XCTAssertEqual(cards.firstIndex(of: ["profile"]), 1, "Profile is not right under the accounts")
        XCTAssertEqual(settings.shownRow("change-agent-name")?.title, "Change agent name")
        XCTAssertEqual(settings.shownRow("change-agent-avatar")?.title, "Change agent avatar")
        XCTAssertEqual(settings.shownRow("profile")?.title, "Profile")

        // The heading's name is only a name now.
        let heading = try XCTUnwrap(Self.subview(UILabel.self, in: settings.view) { $0.accessibilityIdentifier == "settings-name" })
        XCTAssertFalse(heading.isUserInteractionEnabled, "the heading still takes taps")
        XCTAssertTrue(heading.gestureRecognizers?.isEmpty ?? true, "the heading still renames in place")
        XCTAssertNil(Self.subview(UITextField.self, in: settings.view) { $0.accessibilityIdentifier == "settings-rename" })

        // Found by search: Settings' own, and home's (`SettingsIndex`).
        let ids = SettingsIndex.computer.map(\.id)
        XCTAssertFalse(ids.contains("edit-name"))
        XCTAssertEqual(Array(ids.prefix(3)), ["profile", "change-agent-name", "change-agent-avatar"])
        XCTAssertEqual(HappyCore.Search.ranked(SettingsIndex.computer, query: "profile") { $0.title }.first?.id, "profile")
        XCTAssertEqual(HappyCore.Search.ranked(SettingsIndex.computer, query: "agent avatar") { $0.title }.first?.id, "change-agent-avatar")
        let search = try XCTUnwrap(settings.navigationItem.searchController)
        settings.willPresentSearchController(search)
        search.searchBar.text = "Profile"
        settings.updateSearchResults(for: search)
        XCTAssertEqual(settings.shownRowIDs.first?.first, "profile", "Settings' search doesn't find Profile")
        search.searchBar.text = "agent name"
        settings.updateSearchResults(for: search)
        XCTAssertTrue(settings.shownRowIDs.joined().contains("change-agent-name"))
        settings.willDismissSearchController(search)
        try await until { settings.shownRow("status") != nil }

        settings.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(300))
        capture(window, "settings")
        window.overrideUserInterfaceStyle = .dark
        try await Task.sleep(for: .milliseconds(300))
        capture(window, "settings")
        window.overrideUserInterfaceStyle = .light

        settings.tapRow("profile")
        try await until { navigation.topViewController is ProfileViewController && navigation.transitionCoordinator == nil }
        let page = try XCTUnwrap(navigation.topViewController as? ProfileViewController)
        try await until { page.nameField.text == "Alex Rivera" && page.shownPhoto != nil && page.shownRowIDs == [["profile-name"], ["remove-photo"]] }
        XCTAssertEqual(page.title, "Profile")
        try await Task.sleep(for: .milliseconds(400))
        capture(window, "profile")
        window.overrideUserInterfaceStyle = .dark
        try await Task.sleep(for: .milliseconds(300))
        capture(window, "profile")
        withExtendedLifetime(rig.controller) {}
    }

    // MARK: Profile page

    /// The name is saved over the version read. It shows at once and stays
    /// while the computer thinks, whatever older read lands meanwhile; a
    /// conflict is read again and saved once more; a refusal says so and
    /// puts the computer's name back.
    func testTheNameSavesHeldUntilAnsweredAndRetriesAConflict() async throws {
        let rig = try await rig()
        let source = rig.session.profile
        let page = ProfileViewController(source: source)
        let (_, window) = try await host(page)
        try await until { page.nameField.text == "Alex Rivera" }
        XCTAssertEqual(page.shownRowIDs, [["profile-name"]], "Remove Photo with no photo")
        let read = await rig.daemon.version

        await rig.daemon.hold(true)
        page.nameField.text = "  Alex R  "
        page.textFieldDidEndEditing(page.nameField)
        XCTAssertEqual(page.nameField.text, "Alex R", "the name isn't trimmed")
        try await until { await rig.daemon.patches.count == 1 }
        XCTAssertEqual(source.state.name, "Alex R", "the new name isn't shown while it saves")
        XCTAssertEqual(source.state.pendingName, "Alex R")
        let firstPatches = await rig.daemon.patches
        let patch = try XCTUnwrap(firstPatches.first)
        XCTAssertEqual(patch.headers["If-Match"], read, "not saved over the version read")
        XCTAssertEqual(try JSONDecoder().decode(JSONValue.self, from: XCTUnwrap(patch.body))["name"], .string("Alex R"))

        // A read lands while the save waits: still the new name, no flicker.
        source.refresh()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(page.nameField.text, "Alex R", "a read put the old name back while saving")
        XCTAssertEqual(source.state.name, "Alex R")
        await rig.daemon.hold(false)
        try await until { source.state.pendingName == nil }
        XCTAssertEqual(source.state.profile?.name, "Alex R")
        XCTAssertEqual(page.nameField.text, "Alex R")

        // Changed elsewhere since it was read: read again, saved once more.
        await rig.daemon.conflict(1)
        let before = await rig.daemon.sent.count
        page.nameField.text = "Alex Rivera"
        page.textFieldDidEndEditing(page.nameField)
        try await until { source.state.pendingName == nil && source.state.profile?.name == "Alex Rivera" }
        let methods = await rig.daemon.sent.dropFirst(before).map(\.method)
        XCTAssertEqual(methods, ["PATCH", "GET", "PATCH"], "a conflict wasn't read again and retried once")
        XCTAssertNil(page.presentedViewController, "a conflict that resolved was reported")

        // Refused: said so, and the computer's name is back.
        await rig.daemon.fail(true)
        page.nameField.text = "Broken"
        page.textFieldDidEndEditing(page.nameField)
        try await until { page.presentedViewController is UIAlertController }
        let alert = try XCTUnwrap(page.presentedViewController as? UIAlertController)
        XCTAssertEqual(alert.title, Strings.Profile.couldNotSave)
        XCTAssertEqual(alert.message, "The disk is full.")
        XCTAssertEqual(page.nameField.text, "Alex Rivera", "a refused name stayed up")
        XCTAssertEqual(source.state.name, "Alex Rivera")
        alert.dismiss(animated: false)
        // An empty name isn't saved: the name comes back.
        await rig.daemon.fail(false)
        let patches = await rig.daemon.patches.count
        page.nameField.text = "   "
        page.textFieldDidEndEditing(page.nameField)
        XCTAssertEqual(page.nameField.text, "Alex Rivera")
        try await Task.sleep(for: .milliseconds(200))
        let after = await rig.daemon.patches.count
        XCTAssertEqual(after, patches, "an empty name was sent")
        withExtendedLifetime((rig.controller, window)) {}
    }

    /// A picked picture is cut square and small, shown at once, and sent as
    /// its JPEG bytes; the computer's answer brings Remove Photo, which
    /// takes it away again. The bytes just sent are never read back.
    func testAPhotoIsSentSquareAndCanBeRemoved() async throws {
        let rig = try await rig()
        let source = rig.session.profile
        let page = ProfileViewController(source: source)
        let (_, window) = try await host(page)
        try await until { page.nameField.text == "Alex Rivera" }

        let prepared = ProfileSource.prepare(Self.picture(side: 900))
        XCTAssertEqual(prepared.size, CGSize(width: 512, height: 512))
        XCTAssertEqual(prepared.scale, 1)
        page.setPhoto(prepared)
        try await until { page.shownPhoto === prepared }
        try await until { page.shownRowIDs == [["profile-name"], ["remove-photo"]] && source.state.pendingPhoto == nil }
        let sent = await rig.daemon.sent
        let put = try XCTUnwrap(sent.last { $0.method == "PUT" })
        XCTAssertEqual(put.path, "/v0/profile/photo")
        XCTAssertEqual(put.headers["Content-Type"], "image/jpeg")
        let sentImage = try XCTUnwrap(UIImage(data: XCTUnwrap(put.body)))
        XCTAssertEqual(sentImage.size, CGSize(width: 512, height: 512))
        XCTAssertTrue(page.shownPhoto === prepared, "the answer replaced the picture just sent")
        let reads = await rig.daemon.sent.filter { $0.method == "GET" && $0.path == "/v0/profile/photo" }.count
        XCTAssertEqual(reads, 0, "the picture just sent was read back")
        try await Task.sleep(for: .milliseconds(300))
        capture(window, "profile-photo")

        page.tapRow("remove-photo")
        try await until { page.shownRowIDs == [["profile-name"]] && source.state.pendingPhoto == nil }
        XCTAssertNil(page.shownPhoto)
        let deleted = await rig.daemon.sent.contains { $0.method == "DELETE" && $0.path == "/v0/profile/photo" }
        XCTAssertTrue(deleted)
        withExtendedLifetime((rig.controller, window)) {}
    }

    // MARK: Asks

    /// "Change agent name" changes nothing itself: with no Happy
    /// conversation to be found, new work opens with the ask typed in,
    /// the caret after it, the keyboard up, and nothing sent.
    func testChangeAgentNameTypesTheAskIntoNewWork() async throws {
        let rig = try await rig()
        let settings = SettingsViewController(context: rig.context, computer: rig.computerID)
        let (navigation, window) = try await host(settings)
        try await until { settings.shownRow("change-agent-name") != nil }
        settings.tapRow("change-agent-name")
        try await until { navigation.topViewController is ChatViewController && navigation.transitionCoordinator == nil }
        let chat = try XCTUnwrap(navigation.topViewController as? ChatViewController)
        let card = try XCTUnwrap(Self.subview(AgentInputCardView.self, in: chat.view) { _ in true })
        try await until { card.textView.text == "Change your name to " }
        XCTAssertEqual(card.textView.selectedRange, NSRange(location: 20, length: 0), "the caret isn't at the end")
        try await until { card.textView.isFirstResponder }
        try await Task.sleep(for: .milliseconds(300))
        let sends = await rig.daemon.sent.filter { $0.path.hasSuffix("/send") }
        XCTAssertTrue(sends.isEmpty, "the ask was sent")
        XCTAssertEqual(card.textView.text, "Change your name to ")
        capture(window, "ask-name")
        withExtendedLifetime(rig.controller) {}
    }

    /// With Happy's conversation known, the avatar ask opens it there.
    func testChangeAgentAvatarOpensHappysConversation() async throws {
        let rig = try await rig()
        var snapshot = Snapshot()
        snapshot.happyAgentId = "happy-agent"
        let chat = try XCTUnwrap(ChiefOfStaffAsk.chat(session: rig.session, snapshot: snapshot, ask: .agentAvatar) as? ChatViewController)
        let (_, window) = try await host(chat)
        let card = try XCTUnwrap(Self.subview(AgentInputCardView.self, in: chat.view) { _ in true })
        try await until { card.textView.text == "Change your avatar to " }
        XCTAssertEqual(card.textView.selectedRange, NSRange(location: 22, length: 0))
        withExtendedLifetime((rig.controller, window)) {}
    }

    // MARK: Helpers

    private static func subview<View: UIView>(_ type: View.Type, in view: UIView, where match: (View) -> Bool) -> View? {
        if let found = view as? View, match(found) { return found }
        for subview in view.subviews {
            if let found = Self.subview(type, in: subview, where: match) { return found }
        }
        return nil
    }

    private func until(_ condition: () async -> Bool, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("timed out", file: file, line: line)
        throw CancellationError()
    }
}
#endif
