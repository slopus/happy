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
/// and the agent's picture, whose menu asks it to change its name or picture.
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

    private func rig(photo: Bool = false, signedIn: Bool = false) async throws -> Rig {
        let daemon = ProfileDaemon(photo: photo ? Self.picture().jpegData(compressionQuality: 0.9) : nil)
        let controller = AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            agentTransport: { _ in daemon },
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) },
            transport: ProfileOffline(), connector: ProfileNoSocket()
        )
        if signedIn { try await controller.signIn(Credentials(token: "t", secret: Data(repeating: 1, count: 32))) }
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

    /// Edit name, the two ask rows and Status are gone, and so is renaming
    /// by tapping the heading: the agent's asks live in its picture, and
    /// the person's Profile row, which shows their name and opens their
    /// page, sits under the accounts. All are found by search.
    func testSettingsAsksTheAgentAndOpensTheProfile() async throws {
        let rig = try await rig(photo: true)
        let settings = SettingsViewController(context: rig.context, computer: rig.computerID)
        let (navigation, window) = try await host(settings)
        try await until { settings.shownRow("profile")?.value == "Alex Rivera" && settings.shownRow("profile")?.image != nil }

        let cards = settings.shownRowIDs
        for gone in ["edit-name", "change-agent-name", "change-agent-avatar", "status"] {
            XCTAssertFalse(cards.joined().contains(gone), "\(gone) is still on the page: \(cards)")
        }
        XCTAssertTrue(cards.contains(["profile"]), "the Profile row is not a card of its own: \(cards)")
        XCTAssertEqual(cards.firstIndex(of: ["profile"]), 1, "Profile is not right under the accounts")
        XCTAssertEqual(cards[2], ["appearance", "data-storage"], "a card is left between Profile and Appearance: \(cards)")
        XCTAssertEqual(settings.shownRow("profile")?.title, "Profile")
        XCTAssertTrue(settings.agentButton.isDescendant(of: settings.view) && !settings.agentButton.isHidden, "the agent's picture isn't on the page")
        XCTAssertTrue(settings.navigationItem.rightBarButtonItems?.isEmpty ?? true, "the bar still has a button left of search")

        // The heading's name is only a name now.
        let heading = try XCTUnwrap(Self.subview(UILabel.self, in: settings.view) { $0.accessibilityIdentifier == "settings-name" })
        XCTAssertFalse(heading.isUserInteractionEnabled, "the heading still takes taps")
        XCTAssertTrue(heading.gestureRecognizers?.isEmpty ?? true, "the heading still renames in place")
        XCTAssertNil(Self.subview(UITextField.self, in: settings.view) { $0.accessibilityIdentifier == "settings-rename" })

        // Found by search: Settings' own, and home's (`SettingsIndex`).
        let ids = SettingsIndex.computer.map(\.id)
        XCTAssertFalse(ids.contains("edit-name"))
        XCTAssertEqual(Array(ids.prefix(3)), ["profile", "change-agent-name", "change-agent-avatar"])
        XCTAssertFalse(ids.contains("status"), "Status is still found by search")
        XCTAssertEqual(HappyCore.Search.ranked(SettingsIndex.computer, query: "profile") { $0.title }.first?.id, "profile")
        XCTAssertEqual(HappyCore.Search.ranked(SettingsIndex.computer, query: "agent avatar") { $0.title }.first?.id, "change-agent-avatar")
        let search = try XCTUnwrap(settings.navigationItem.searchController)
        settings.willPresentSearchController(search)
        search.searchBar.text = "Profile"
        settings.updateSearchResults(for: search)
        XCTAssertEqual(settings.shownRowIDs.first?.first, "profile", "Settings' search doesn't find Profile")
        search.searchBar.text = "agent name"
        settings.updateSearchResults(for: search)
        XCTAssertTrue(settings.shownRowIDs.joined().contains("change-agent-name"), "Settings' search doesn't find the name ask")
        search.searchBar.text = "Status"
        settings.updateSearchResults(for: search)
        XCTAssertTrue(settings.shownRowIDs.isEmpty, "Status is still found: \(settings.shownRowIDs)")
        settings.willDismissSearchController(search)
        try await until { settings.shownRow("appearance") != nil }

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

    /// The agent's picture sits large and centred at the top of the page,
    /// over its name: round, with a glass pencil badge on its rim,
    /// unclipped. A press opens its own menu (no primary action), "Change
    /// avatar" then "Edit name", each with its icon. The bar has nothing
    /// left of search, and a Happy account's page has no picture.
    func testTheAgentPictureIsCentredOverTheNameWithItsMenu() async throws {
        let rig = try await rig(signedIn: true)
        let settings = SettingsViewController(context: rig.context, computer: rig.computerID)
        let (navigation, window) = try await host(settings)
        let button = settings.agentButton
        XCTAssertTrue(settings.navigationItem.rightBarButtonItems?.isEmpty ?? true, "the bar still has a button left of search")
        XCTAssertTrue(button.showsMenuAsPrimaryAction, "a press runs an action instead of opening the menu")
        let menu = try XCTUnwrap(button.menu)
        let actions = menu.children.compactMap { $0 as? UIAction }
        XCTAssertEqual(menu.children.count, 2)
        XCTAssertEqual(actions.map(\.title), ["Change avatar", "Edit name"])
        XCTAssertTrue(actions.allSatisfy { $0.image != nil }, "an action has no icon")
        // Nothing yet, or its placeholder at once when that is decoded already.
        let computer = try XCTUnwrap(rig.controller.accounts.first { $0.id == rig.computerID })
        let placeholder = AvatarPlaceholderImages.cached(seed: ProfilePictures.placeholderSeed(computer, context: rig.context), side: ProfilePictures.placeholderSide)
        XCTAssertTrue(button.picture == nil || button.picture === placeholder, "a computer with no picture shows a picture")

        // In the page's content, centred, over the name.
        try await Task.sleep(for: .milliseconds(400))
        window.layoutIfNeeded()
        XCTAssertFalse(button.isHidden)
        XCTAssertFalse(button.isDescendant(of: navigation.navigationBar), "the picture is in the bar")
        let heading = try XCTUnwrap(Self.subview(UILabel.self, in: settings.view) { $0.accessibilityIdentifier == "settings-name" })
        let buttonFrame = button.convert(button.bounds, to: window)
        let headingFrame = heading.convert(heading.bounds, to: window)
        XCTAssertEqual(buttonFrame.size, AgentEditButtonLayout().size)
        XCTAssertEqual(buttonFrame.midX, window.bounds.midX, accuracy: 0.5, "the picture isn't centred")
        XCTAssertLessThan(buttonFrame.maxY, headingFrame.minY, "the picture isn't over the name")
        XCTAssertGreaterThanOrEqual(buttonFrame.minY, navigation.navigationBar.convert(navigation.navigationBar.bounds, to: window).maxY, "the picture is under the bar")

        // The badge is the system's glass, and nothing that holds it clips it.
        let badge = button.badgeView
        XCTAssertTrue((badge as? UIVisualEffectView)?.effect is UIGlassEffect, "the badge isn't Liquid Glass")
        let badgeFrame = badge.convert(badge.bounds, to: window)
        var ancestor: UIView? = badge.superview
        while let view = ancestor, view !== window {
            if view.clipsToBounds {
                let visible = view.convert(view.bounds, to: window)
                XCTAssertTrue(visible.insetBy(dx: -0.01, dy: -0.01).contains(badgeFrame), "\(type(of: view)) clips the badge: \(visible) vs \(badgeFrame)")
            }
            ancestor = view.superview
        }
        // On the screen: the pencil's ink, inside the badge's circle, is
        // the whole glyph where it should be, in the badge's middle.
        let shot = try Pixels(screen(of: window))
        let scale = window.screen.scale
        let inner = (badgeFrame.width / 2 - 2) * scale
        let ink = try XCTUnwrap(shot.dark(in: badgeFrame.applying(CGAffineTransform(scaleX: scale, y: scale)).integral, within: inner), "no pencil drawn in the badge")
        let inkPoints = ink.applying(CGAffineTransform(scaleX: 1 / scale, y: 1 / scale))
        let pencilFrame = AgentEditButtonLayout().pencil.offsetBy(dx: badgeFrame.minX, dy: badgeFrame.minY)
        XCTAssertTrue(pencilFrame.insetBy(dx: -1, dy: -1).contains(inkPoints), "the pencil spills out of its place: \(inkPoints) vs \(pencilFrame)")
        XCTAssertGreaterThanOrEqual(inkPoints.width, AgentEditButtonLayout.Metrics.pencil * 0.7, "the pencil is cut: \(inkPoints)")
        XCTAssertGreaterThanOrEqual(inkPoints.height, AgentEditButtonLayout.Metrics.pencil * 0.7, "the pencil is cut: \(inkPoints)")
        XCTAssertEqual(inkPoints.midX, badgeFrame.midX, accuracy: 1.5, "the pencil is off the badge's middle")
        XCTAssertEqual(inkPoints.midY, badgeFrame.midY, accuracy: 1.5, "the pencil is off the badge's middle")

        // The page, then the menu as it opens and once it has, light and dark.
        let scene = try XCTUnwrap(window.windowScene)
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            try await Task.sleep(for: .milliseconds(400))
            captureScreen(scene, "settings-agent", style: style)
            let interaction = try XCTUnwrap(button.contextMenuInteraction)
            // The tap's own path: what the system does when the button is pressed.
            interaction.perform(NSSelectorFromString("_presentMenuAtLocation:"), with: NSValue(cgPoint: CGPoint(x: buttonFrame.width / 2, y: buttonFrame.height / 2)))
            try await Task.sleep(for: .milliseconds(90))
            captureScreen(scene, "agent-menu-morph", style: style)
            try await Task.sleep(for: .milliseconds(900))
            captureScreen(scene, "agent-menu", style: style)
            interaction.dismissMenu()
            try await Task.sleep(for: .milliseconds(900))
        }
        // With a picture of its own.
        button.picture = Self.picture()
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            try await Task.sleep(for: .milliseconds(400))
            captureScreen(scene, "settings-agent-photo", style: style)
        }
        window.overrideUserInterfaceStyle = .light

        // A Happy account's page: its picture, with no pencil and no menu.
        let happyID = try XCTUnwrap(rig.controller.accounts.first { !$0.isAgentConnection }?.id)
        let accountPage = SettingsViewController(context: rig.context, computer: happyID)
        navigation.pushViewController(accountPage, animated: false)
        accountPage.loadViewIfNeeded()
        accountPage.view.layoutIfNeeded()
        XCTAssertFalse(accountPage.agentButton.isHidden, "a Happy account's page has no picture")
        XCTAssertTrue(accountPage.agentButton.badgeView.isHidden, "a Happy account's picture has the pencil")
        XCTAssertNil(accountPage.agentButton.menu, "a Happy account's picture has the agent's menu")
        XCTAssertTrue(accountPage.navigationItem.rightBarButtonItems?.isEmpty ?? true)
        withExtendedLifetime(rig.controller) {}
    }

    /// Each menu action changes nothing itself: it opens the ask typed in,
    /// the caret after it, the keyboard up, and nothing sent. With no
    /// Happy conversation to be found, that is new work.
    func testEachMenuActionTypesItsAsk() async throws {
        for (identifier, ask) in [("agent-edit-name", "Change your name to "), ("agent-change-avatar", "Change your avatar to ")] {
            let rig = try await rig()
            let settings = SettingsViewController(context: rig.context, computer: rig.computerID)
            let (navigation, window) = try await host(settings)
            let menu = try XCTUnwrap(settings.agentButton.menu)
            let action = try XCTUnwrap(menu.children.compactMap { $0 as? UIAction }.first { $0.identifier.rawValue == identifier })
            action.performWithSender(nil, target: nil)
            try await until { navigation.topViewController is ChatViewController && navigation.transitionCoordinator == nil }
            let chat = try XCTUnwrap(navigation.topViewController as? ChatViewController)
            let card = try XCTUnwrap(Self.subview(AgentInputCardView.self, in: chat.view) { _ in true })
            try await until { card.textView.text == ask }
            XCTAssertEqual(card.textView.selectedRange, NSRange(location: (ask as NSString).length, length: 0), "\(identifier): the caret isn't at the end")
            try await until { card.textView.isFirstResponder }
            try await Task.sleep(for: .milliseconds(300))
            let sends = await rig.daemon.sent.filter { $0.path.hasSuffix("/send") }
            XCTAssertTrue(sends.isEmpty, "\(identifier): the ask was sent")
            XCTAssertEqual(card.textView.text, ask)
            if identifier == "agent-edit-name" { capture(window, "ask-name") }
            window.isHidden = true
            withExtendedLifetime(rig.controller) {}
        }
    }

    /// Home's search finds the asks; picking one runs it over home, as the
    /// menu does, rather than opening Settings at a row that isn't there.
    func testHomeSearchRunsTheAskDirectly() async throws {
        let rig = try await rig()
        let home = UIViewController()
        let (navigation, _) = try await host(home)
        SettingsViewController.open(context: rig.context, computer: rig.computerID, reveal: SettingsIndex.changeAgentAvatar.id, from: home)
        try await until { navigation.topViewController is ChatViewController && navigation.transitionCoordinator == nil }
        XCTAssertFalse(navigation.viewControllers.contains { $0 is SettingsViewController }, "Settings was opened on the way")
        let chat = try XCTUnwrap(navigation.topViewController as? ChatViewController)
        let card = try XCTUnwrap(Self.subview(AgentInputCardView.self, in: chat.view) { _ in true })
        try await until { card.textView.text == "Change your avatar to " }
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

    /// Every window of `scene` drawn in order, the menu's included.
    private func screenImage(_ scene: UIWindowScene) -> UIImage {
        let bounds = scene.screen.bounds
        return UIGraphicsImageRenderer(bounds: bounds).image { _ in
            for window in scene.windows.sorted(by: { $0.windowLevel < $1.windowLevel }) where !window.isHidden {
                window.drawHierarchy(in: window.frame, afterScreenUpdates: false)
            }
        }
    }

    private func captureScreen(_ scene: UIWindowScene, _ name: String, style: UIUserInterfaceStyle) {
        let image = screenImage(scene)
        let file = "\(name)-\(style == .dark ? "dark" : "light")"
        let attachment = XCTAttachment(image: image)
        attachment.name = file
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = Self.evidence, let data = image.pngData() {
            try? data.write(to: folder.appendingPathComponent("\(file).png"))
        }
    }

    private func screen(of window: UIWindow) -> UIImage {
        UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
    }

    /// RGBA bytes of an image, drawn into a context of known layout.
    private struct Pixels {
        let width: Int, height: Int
        let bytes: [UInt8]

        init(_ image: UIImage) throws {
            let cg = try XCTUnwrap(image.cgImage)
            width = cg.width; height = cg.height
            var bytes = [UInt8](repeating: 0, count: width * height * 4)
            bytes.withUnsafeMutableBytes { buffer in
                let context = CGContext(data: buffer.baseAddress, width: cg.width, height: cg.height, bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
                context?.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            }
            self.bytes = bytes
        }

        /// The box of the dark (ink) pixels within `rect`, and within
        /// `radius` of its middle, in pixels.
        func dark(in rect: CGRect, within radius: CGFloat) -> CGRect? {
            var box: CGRect?
            for y in max(0, Int(rect.minY))..<min(height, Int(rect.maxY)) {
                for x in max(0, Int(rect.minX))..<min(width, Int(rect.maxX)) {
                    guard hypot(CGFloat(x) + 0.5 - rect.midX, CGFloat(y) + 0.5 - rect.midY) <= radius else { continue }
                    let i = (y * width + x) * 4
                    let luma = (Int(bytes[i]) * 3 + Int(bytes[i + 1]) * 6 + Int(bytes[i + 2])) / 10
                    guard luma < 60 else { continue }
                    box = (box ?? CGRect(x: x, y: y, width: 1, height: 1)).union(CGRect(x: x, y: y, width: 1, height: 1))
                }
            }
            return box
        }
    }

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
