#if canImport(UIKit)
import HappyCore
@testable import HappyUI
import UIKit
import XCTest

/// The composer's strings: their English is en.ts's functions' own, at the
/// values that pick each branch, and another language reads its catalog.
@MainActor
final class ComposerStringsTests: XCTestCase {
    override func tearDown() {
        _ = AppLocalization.use(nil)
        super.tearDown()
    }

    func testTheEnglishIsEnTsForEveryBranch() async {
        _ = AppLocalization.use(nil)
        // Decoded off the main thread, as the app decodes every catalog:
        // decoding on it stops Debug builds.
        let english = await TranslationCatalog.load("en")
        for count in [0, 1, 2, 21] {
            XCTAssertEqual(Strings.Composer.minutesAgo(count), english("time.minutesAgo", ["count": .number(count)]))
            XCTAssertEqual(Strings.Composer.hoursAgo(count), english("time.hoursAgo", ["count": .number(count)]))
            XCTAssertEqual(Strings.Composer.daysAgo(count), english("sessionHistory.daysAgo", ["count": .number(count)]))
            XCTAssertEqual(Strings.ImageUpload.uploadFailedMessage(count), english("imageUpload.uploadFailedMessage", ["count": .number(count)]))
        }
        XCTAssertEqual(Strings.Composer.detailContext(used: "12k", total: "200k"), english("agentInput.context.detailContext", ["used": "12k", "total": "200k"]))
        XCTAssertEqual(Strings.Composer.percentContext(80), english("agentInput.context.percentContext", ["percent": 80]))
        XCTAssertEqual(Strings.Composer.percentWeek(5), english("agentInput.context.percentWeek", ["percent": 5]))
        XCTAssertEqual(Strings.Composer.usageResets("3:00 PM"), english("agentInput.usagePopup.resets", ["time": "3:00 PM"]))
        XCTAssertEqual(Strings.Composer.lastSeen("just now"), english("status.lastSeen", ["time": "just now"]))
        XCTAssertEqual(Strings.ImageUpload.limitMessage(20), english("imageUpload.limitMessage", ["max": 20]))
        XCTAssertEqual(
            Strings.ImageUpload.fileTooLargeMessage(name: "a.png", maxMb: 10),
            english("imageUpload.fileTooLargeMessage", ["name": "a.png", "maxMb": 10])
        )
        // AgentInput.tsx's literals.
        XCTAssertEqual(Strings.Composer.addPhoto, "Add photo")
        XCTAssertEqual(Strings.Composer.send, "Send")
    }

    func testAnotherLanguageReadsItsCatalog() async {
        let japanese = await TranslationCatalog.load("ja")
        _ = AppLocalization.use(japanese)
        XCTAssertEqual(Strings.Composer.inputPlaceholder, japanese("session.inputPlaceholder"))
        XCTAssertEqual(Strings.Composer.permissionModeTitle, japanese("agentInput.permissionMode.title"))
        XCTAssertEqual(Strings.Composer.percentContext(80), japanese("agentInput.context.percentContext", ["percent": 80]))
        XCTAssertEqual(Strings.ImageUpload.uploadFailedMessage(2), japanese("imageUpload.uploadFailedMessage", ["count": 2]))
        // Literals in AgentInput.tsx stay English there too.
        XCTAssertEqual(Strings.Composer.stop, "Stop")
    }
}
#endif
