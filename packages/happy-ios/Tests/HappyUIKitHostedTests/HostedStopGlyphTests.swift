#if canImport(UIKit)
import Foundation
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Send beside stop, light and dark, as the screen draws them: the chat
/// composer's pair, then the new session card's. Pictures go to the
/// repository's `.context/evidence/stop`.
@MainActor
final class HostedStopGlyphTests: XCTestCase {
    private static let evidence: URL? = {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let context = root.appendingPathComponent(".context")
        guard FileManager.default.fileExists(atPath: context.path) else { return nil }
        let folder = context.appendingPathComponent("evidence/stop")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }()

    func testCaptureSendBesideStop() async throws {
        let scene = try await hostedActiveScene()
        let hostWindow = scene.keyWindow
        defer { hostWindow?.makeKey() }
        for dark in [false, true] {
            let window = hostedKeyWindow(in: scene)
            window.overrideUserInterfaceStyle = dark ? .dark : .light
            defer { window.isHidden = true }
            let root = try XCTUnwrap(window.rootViewController)
            root.view.backgroundColor = UIColor(Palette.surface)
            let card = UIView(frame: CGRect(x: 0, y: 200, width: 140, height: 120))
            card.backgroundColor = UIColor(Palette.surface)
            root.view.addSubview(card)
            let rows: [(AgentInputPrimaryStyle, CGFloat)] = [(.standard, 12), (.newSession, 66)]
            for (style, y) in rows {
                for (index, action) in [AgentInputPrimaryAction.send, .stop].enumerated() {
                    let button = ComposerPrimaryButton(frame: CGRect(x: 20 + CGFloat(index) * 58, y: y, width: 42, height: 42))
                    button.configure(action: action, style: style, busy: false, accessibilityLabel: nil)
                    card.addSubview(button)
                    button.layoutIfNeeded()
                    if action == .stop {
                        XCTAssertFalse(button.stopView.isHidden)
                        XCTAssertEqual(button.stopView.square.frame, CGRect(x: 15, y: 15, width: 12, height: 12))
                    }
                }
            }
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
            let image = UIGraphicsImageRenderer(bounds: card.bounds).image { _ in
                card.drawHierarchy(in: card.bounds, afterScreenUpdates: true)
            }
            let name = "send-stop-\(dark ? "dark" : "light")"
            let attachment = XCTAttachment(image: image)
            attachment.name = name
            attachment.lifetime = .keepAlways
            add(attachment)
            if let folder = Self.evidence, let data = image.pngData() {
                try data.write(to: folder.appendingPathComponent("\(name).png"))
            }
        }
    }
}
#endif
