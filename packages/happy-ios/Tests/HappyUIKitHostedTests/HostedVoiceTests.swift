#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class HostedVoiceTests: XCTestCase {
    override func setUp() { super.setUp(); Fonts.registerBundledFonts() }

    func testCallControlsAndBackendDenialUseActualScreenAndReachSupport() async throws {
        let screen = VoiceStatusViewController(coordinator: .shared)
        let navigation = UINavigationController(rootViewController: screen)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: navigation)
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        screen.update(.active(activity: .listening, muted: false))
        XCTAssertEqual(rows(screen).map(\.title), [Strings.Voice.listening, Strings.Voice.mute, Strings.Voice.stop])
        screen.update(.active(activity: .agentSpeaking, muted: true))
        XCTAssertEqual(rows(screen).map(\.title), [Strings.Voice.muted, Strings.Voice.unmute, Strings.Voice.stop])
        let denial = try JSONDecoder().decode(VoiceCredentials.self, from: Data(#"{"allowed":false,"reason":"subscription_required","usedSeconds":1200,"limitSeconds":1200,"agentId":"a"}"#.utf8))
        guard case .denied(let value) = denial else { return XCTFail() }
        screen.update(.denied(value))
        XCTAssertEqual(rows(screen).count, 2)
        XCTAssertFalse(rows(screen).contains { $0.title == Strings.Voice.mute || $0.title == Strings.Voice.stop })
        rows(screen).last?.sendActions(for: .touchUpInside)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertTrue(navigation.topViewController is SupportUsViewController)
    }

    func testPermissionFailureIsReadableAndMeasuredAtLargestTextSize() async throws {
        let screen = VoiceStatusViewController(coordinator: .shared)
        let scene = try await hostedActiveScene()
        let window = hostedKeyWindow(in: scene, root: UINavigationController(rootViewController: screen))
        window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        screen.update(.failed(.microphonePermission))
        window.layoutIfNeeded()
        let list = try XCTUnwrap(screen.view as? GroupedListView)
        list.frame = CGRect(x: 0, y: 0, width: 320, height: 400)
        list.layoutIfNeeded()
        let status = try XCTUnwrap(rows(screen).first)
        XCTAssertEqual(status.titleLabel.numberOfLines, 0)
        XCTAssertEqual(status.title, Strings.Voice.permissionDenied)
        for row in rows(screen) {
            row.layoutIfNeeded()
            XCTAssertEqual(row.frame.height, row.layout(width: row.bounds.width).size.height, accuracy: 0.5)
            let measured = row.titleLabel.sizeThatFits(CGSize(width: row.titleLabel.bounds.width, height: .greatestFiniteMagnitude))
            XCTAssertGreaterThanOrEqual(row.titleLabel.bounds.height + 0.5, measured.height)
            XCTAssertLessThanOrEqual(row.frame.maxX, list.bounds.width)
        }
        XCTAssertTrue(rows(screen).contains { $0.title == Strings.Voice.openSettings && $0.onTap != nil })
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let attachment = XCTAttachment(image: image)
        attachment.name = "Voice permission at largest text"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func rows(_ screen: VoiceStatusViewController) -> [ItemRowView] {
        (screen.view as? GroupedListView)?.sections.compactMap { $0 as? ItemGroupView }.flatMap(\.rows).compactMap { $0 as? ItemRowView } ?? []
    }
}
#endif
