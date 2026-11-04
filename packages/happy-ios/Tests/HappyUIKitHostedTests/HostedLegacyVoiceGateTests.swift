#if canImport(UIKit)
import Foundation
@testable import HappyCore
import HappyLayout
import HappyStore
@testable import HappyUI
import UIKit
import XCTest

/// Every request the account makes, answered by no one.
private final class Requests: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var paths: [String] = []

    var seen: [String] { lock.withLock { paths } }
    var voice: [String] { seen.filter { $0.contains("/voice") } }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { paths.append(request.url.path) }
        throw URLError(.notConnectedToInternet)
    }
}

/// Voice in a Happy account's sessions is off (`LegacyVoice`): no
/// microphone in the composer, and a start that asks for no microphone,
/// grant, context, provider or subscription; Voice settings say so. An
/// agent connection's voice still sells.
@MainActor
final class HostedLegacyVoiceGateTests: XCTestCase {
    private let requests = Requests()

    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
        let was = LegacyVoice.isEnabled
        LegacyVoice.isEnabled = false
        addTeardownBlock { @MainActor in LegacyVoice.isEnabled = was }
    }

    private let record = SessionRecord(
        id: "s", seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, projectId: nil,
        metadataVersion: 1, metadataCipher: "c", metadata: .object(["flavor": .string("claude")]),
        agentStateVersion: 1, agentStateCipher: nil, agentState: nil, dataKeyCipher: nil, decryptable: true
    )

    private func account() throws -> AccountSession {
        let store = try LocalStore.inMemory()
        try store.upsertSessions([record])
        return try AccountSession(
            credentials: Credentials(token: "t", secret: Data(repeating: 1, count: 32)),
            store: store,
            dependencies: .init(serverURL: URL(string: "https://api.example.test")!, clientID: "ios/test", transport: requests)
        )
    }

    private func composer(_ account: AccountSession) -> SessionComposerView {
        let composer = SessionComposerView(
            environment: ChatComposerEnvironment(sessionId: "s", account: account, sender: account.sender, controls: account.actions),
            restoreTimeout: .seconds(3600)
        )
        composer.frame = CGRect(x: 0, y: 0, width: 393, height: 120)
        // The session, as the chat hands it on.
        composer.update(ChatComposerState(session: ChatSessionState(record: record, settings: AccountSettings())))
        return composer
    }

    private func card(_ composer: SessionComposerView) throws -> AgentInputCardView {
        try XCTUnwrap(composer.subviews.compactMap { $0 as? AgentInputCardView }.first)
    }

    private func until(_ seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition() {
            if Date() > deadline { return false }
            try await Task.sleep(for: .milliseconds(20))
        }
        return true
    }

    private func host(_ root: UIViewController) async throws -> (UINavigationController, UIWindow) {
        let navigation = UINavigationController(rootViewController: root)
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        let window = hostedKeyWindow(in: scene, root: navigation)
        addTeardownBlock { @MainActor in
            window.rootViewController?.presentedViewController?.dismiss(animated: false)
            window.isHidden = true
            hostWindow?.makeKey()
        }
        window.layoutIfNeeded()
        return (navigation, window)
    }

    /// Off, an empty composer has no microphone, and its button asks for
    /// nothing; on, the same session's has one. The second is what shows
    /// the first had its session.
    func testTheComposerHasNoMicrophone() async throws {
        let account = try account()
        let off = composer(account)
        let offCard = try card(off)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNotEqual(offCard.configuration.primaryAction, .voice)
        off.agentInputCardDidPressPrimary(offCard)
        XCTAssertEqual(VoiceCoordinator.shared.state, .idle)

        LegacyVoice.isEnabled = true
        let on = composer(account)
        let onCard = try card(on)
        let voice = try await until { onCard.configuration.primaryAction == .voice }
        XCTAssertTrue(voice, "the session never loaded, so the first proves nothing")
        LegacyVoice.isEnabled = false
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(requests.voice, [])
        withExtendedLifetime((off, on)) {}
    }

    /// A start that comes some other way: said so, and nothing asked for:
    /// no status screen, no microphone, no grant, no context, no offer.
    func testAStartAsksForNothing() async throws {
        let account = try account()
        let offers = try await hostedOffers("onsale", for: self)
        let (navigation, _) = try await host(UIViewController())
        let top = try XCTUnwrap(navigation.topViewController)
        VoiceCoordinator.shared.start(account: account, sessionId: "s", presenting: top)
        let told = try await until { (top.presentedViewController as? UIAlertController)?.title == Strings.Voice.legacyOff }
        XCTAssertTrue(told, "it didn't say voice is off: \(String(describing: top.presentedViewController))")
        XCTAssertEqual(VoiceCoordinator.shared.state, .idle)
        XCTAssertEqual(VoiceCoordinator.shared.state(for: account), .idle)
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertEqual(requests.voice, [], "a voice request went out")
        XCTAssertFalse(offers.isShowing)
        XCTAssertTrue(offers.intro.due, "the agent call's welcome was used up")
    }

    /// Settings › Voice Assistant, off: says so, asks for no usage and has
    /// no Upgrade; its synced settings stay. On, it is as it was.
    func testVoiceSettingsSayVoiceIsOff() async throws {
        let account = try account()
        let context = AppContext(account: AccountController(
            serverConfig: ServerConfig(storage: InMemoryKeyValueStore()), clientID: "ios/test",
            credentialStore: InMemoryCredentialStore(), storeDirectory: nil,
            rnServerImport: { .confirmed(ServerConfig.defaultServerURL) }, transport: requests
        ), variant: .preview, version: "test")
        let off = VoiceSettingsViewController(context: context, session: account)
        let (navigation, window) = try await host(off)
        XCTAssertEqual(off.shownRowIDs, [["voice-off"], ["voice-language"], ["voice-agent-id", "voice-direct"]])
        XCTAssertNil(off.shownRow("voice-upgrade"))
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(requests.voice, [])
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: image)
        attachment.name = "voice-settings-off"
        attachment.lifetime = .keepAlways
        add(attachment)

        LegacyVoice.isEnabled = true
        let on = VoiceSettingsViewController(context: context, session: account)
        navigation.pushViewController(on, animated: false)
        let asked = try await until { requests.voice.contains("/v1/voice/usage") }
        XCTAssertTrue(asked)
        XCTAssertNotNil(on.shownRow("voice-upgrade"))
    }

    /// An agent connection's voice is apart: with this off, its welcome is
    /// still due and its Voice page still sells and restores.
    func testAnAgentConnectionsVoiceStillSells() async throws {
        let offers = try await hostedOffers("onsale", for: self)
        XCTAssertEqual(offers.offer, .onSale(price: "$19.99"))
        XCTAssertTrue(offers.welcomes())
        let page = AgentVoiceViewController()
        _ = try await host(page)
        XCTAssertEqual(page.shownRow("voice-subscribe")?.value, "$19.99/month")
        XCTAssertNotNil(page.shownRow("voice-subscribe")?.action)
        XCTAssertNotNil(page.shownRow("voice-restore")?.action)
    }
}
#endif
