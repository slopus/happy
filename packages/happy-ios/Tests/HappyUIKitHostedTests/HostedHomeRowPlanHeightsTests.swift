#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import UltraView
import XCTest

/// The legacy home in the app's own window, at the designed text size and
/// at both ends of the range: every row UltraList shows sits in a slot as
/// tall as its plan, its view is that tall and its drawing is that many
/// pixels, the plan was made at the text size shown, and a session's plan
/// is its `FlatSessionRowLayout` at that size's lines
/// (`HomeRowPlanTextSizeTests` pins those frames).
@MainActor
final class HostedHomeRowPlanHeightsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        LegacyFonts.registerBundledFonts()
    }

    private func until(seconds: Double = 5, _ condition: () -> Bool) async throws -> Bool {
        let deadline = ContinuousClock.now + .milliseconds(Int(seconds * 1000))
        while !condition(), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(20)) }
        return condition()
    }

    /// The bitmaps drawn under `layer`.
    private func bitmaps(_ layer: CALayer) -> [CGImage] {
        var found: [CGImage] = []
        if let contents = layer.contents, CFGetTypeID(contents as CFTypeRef) == CGImage.typeID {
            found.append(contents as! CGImage)
        }
        for sublayer in layer.sublayers ?? [] { found += bitmaps(sublayer) }
        return found
    }

    func testEveryRowIsDrawnAsTallAsItsPlanAtTheEndsOfTheTextSizes() async throws {
        let app = try await HomeApp.legacy(self)
        let list = try XCTUnwrap(app.legacyList)
        for category in [UIContentSizeCategory.accessibilityExtraExtraExtraLarge, .extraSmall, .large] {
            app.window.traitOverrides.preferredContentSizeCategory = category
            app.window.layoutIfNeeded()
            let text = TextEnvironment(list.traitCollection)
            XCTAssertEqual(text.scale, TextScale(TextSizeCategory(category)), "the list doesn't follow the text size")
            let rows = { list.items.compactMap { $0 as? HomeUltraRow } }
            let landed = try await until {
                app.window.layoutIfNeeded()
                return !rows().isEmpty && rows().allSatisfy { $0.plan.environment.text == text }
                    && !list.loadedIndexRange.isEmpty && list.loadedItemViews.allSatisfy(\.isDisplayReady)
            }
            XCTAssertTrue(landed, "the rows never drew at \(category.rawValue)")
            let environment = await HomeTextEnvironment.make(text)
            let lines = environment.rows.sessionLines
            let avatar = HomeCardLayout.Metrics.sessionAvatar
            let sessionHeights = [false, true].map { FlatSessionRowLayout.height(lines: lines, workspace: $0, branchIcon: environment.rows.branchIcon.height, avatarSize: avatar) }
            var sessions = 0
            var drawn = 0
            for index in list.loadedIndexRange {
                guard let row = list.items[index] as? HomeUltraRow else { continue }
                let at = "\(row.identity) at \(category.rawValue)"
                let height = row.plan.size.height
                XCTAssertEqual(list.settledFrame(at: index)?.height ?? 0, height, accuracy: 0.001, at)
                let view = try XCTUnwrap(list.loadedItemView(at: index), at)
                XCTAssertEqual(view.bounds.height, height, accuracy: 0.001, at)
                // The row's own drawing is the widest bitmap in it; its avatar is another.
                if let bitmap = bitmaps(view.layer).max(by: { $0.width < $1.width }), CGFloat(bitmap.width) > view.bounds.width * text.displayScale / 2 {
                    XCTAssertEqual(CGFloat(bitmap.height), height * text.displayScale, accuracy: 1, "\(at): the drawing is another height")
                    drawn += 1
                }
                if row.identity.hasPrefix("session:") {
                    XCTAssertTrue(sessionHeights.contains(height), "\(at): \(height), not a session's \(sessionHeights)")
                    sessions += 1
                }
            }
            XCTAssertGreaterThan(sessions, 0, category.rawValue)
            XCTAssertGreaterThan(drawn, sessions / 2, "\(category.rawValue): the rows' drawings weren't found")
        }
    }
}
#endif
