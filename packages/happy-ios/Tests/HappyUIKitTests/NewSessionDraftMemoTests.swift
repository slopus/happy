#if canImport(UIKit)
import Foundation
import GRDB
@testable import HappyCore
import HappyLayout
import HappyStore
@testable import HappyUI
import UIKit
import XCTest

private struct OfflineTransport: HTTPTransport {
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        throw URLError(.notConnectedToInternet)
    }
}

/// The New Session draft's measured height is its account session's
/// (`AccountSession.newSessionDraftHeight`): used only for the same text
/// measured for the same key, never another account's, and gone with the
/// account when it stops.
@MainActor
final class NewSessionDraftMemoTests: XCTestCase {
    private let width: CGFloat = 369
    private let line = NewSessionComposerLayout.Metrics.lineHeight
    private let draft = "plan\nask\nbuild"

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func account(token: String = "t") throws -> AccountSession {
        try AccountSession(
            credentials: Credentials(token: token, secret: Data(repeating: 1, count: 32)),
            store: LocalStore(writer: DatabaseQueue()),
            dependencies: .init(serverURL: URL(string: "https://api.example.test")!, clientID: "ios/test", transport: OfflineTransport())
        )
    }

    /// A screen of `memo` that measured `text`, as a closed New Session did.
    @discardableResult
    private func measure(_ memo: MeasuredDraftMemo, _ text: String) async -> CGFloat {
        let composer = NewSessionComposerView(frame: .zero)
        composer.heights = memo
        composer.setText(text)
        _ = composer.layout(width: width)
        await composer.textMeasured()
        return composer.layout(width: width).input.height
    }

    /// `text`'s height in the first frame of a screen of `memo`.
    private func firstFrame(_ memo: MeasuredDraftMemo, _ text: String, width: CGFloat? = nil) -> CGFloat {
        let composer = NewSessionComposerView(frame: .zero)
        composer.heights = memo
        composer.setText(text)
        return composer.layout(width: width ?? self.width).input.height
    }

    func testTheSameAccountReopensAtTheHeight() async throws {
        let account = try account()
        let measured = await measure(account.newSessionDraftHeight, draft)
        XCTAssertGreaterThan(measured, line)
        XCTAssertEqual(firstFrame(account.newSessionDraftHeight, draft), measured)
    }

    func testTwoAccountsWithTheSameTextShareNoSeed() async throws {
        let first = try account(token: "first")
        let second = try account(token: "second")
        await measure(first.newSessionDraftHeight, draft)
        XCTAssertFalse(first.newSessionDraftHeight === second.newSessionDraftHeight)
        XCTAssertNil(second.newSessionDraftHeight.entry(for: draft))
        XCTAssertEqual(firstFrame(second.newSessionDraftHeight, draft), line, "cold")
    }

    func testAClosedMemoAndAFreshSessionStartCold() async throws {
        let before = try account()
        await measure(before.newSessionDraftHeight, draft)
        await before.stop()
        XCTAssertEqual(firstFrame(before.newSessionDraftHeight, draft), line, "closed")
        // The same account signed in again: a session of its own.
        let again = try account()
        XCTAssertEqual(firstFrame(again.newSessionDraftHeight, draft), line, "fresh")
    }

    func testAReplacedTextNeverShowsTheOldHeight() async throws {
        let account = try account()
        let memo = account.newSessionDraftHeight
        let measured = await measure(memo, draft)
        XCTAssertGreaterThan(measured, line)
        let composer = NewSessionComposerView(frame: .zero)
        composer.heights = memo
        var heights: [CGFloat] = []
        composer.onHeightChange = { [unowned composer] in heights.append(composer.layout(width: self.width).input.height) }
        // The kept text, then another before the first layout.
        composer.setText(draft)
        composer.setText("one line")
        XCTAssertEqual(composer.layout(width: width).input.height, line)
        await composer.textMeasured()
        XCTAssertEqual(composer.layout(width: width).input.height, line)
        XCTAssertFalse(heights.contains(measured), "the kept text's height never shows: \(heights)")
    }

    func testSignOutLeavesNoDraftText() async throws {
        let account = try account()
        let memo = account.newSessionDraftHeight
        await measure(memo, draft)
        XCTAssertNotNil(memo.entry(for: draft))
        await account.stop()
        XCTAssertTrue(memo.isClosed)
        XCTAssertNil(memo.entry(for: draft))
        // A measurement landing after the stop isn't kept.
        await measure(memo, draft)
        XCTAssertNil(memo.entry(for: draft))
    }

    /// The key the composer measures its text for at `width`, at a text
    /// size.
    private func key(_ scale: TextScale? = nil) -> ComposerTextHeights.Key {
        let style = scale.map { TextStyles.composerInput.scaled($0) } ?? TextStyles.composerInput
        return ComposerTextHeights.Key(
            width: NewSessionComposerView(frame: .zero).layout(width: width).input.width,
            style: style,
            lineHeight: style.lineHeightValue,
            paddingTop: 0,
            paddingBottom: 0,
            maxHeight: NewSessionComposerLayout.Metrics.inputMaxHeight
        )
    }

    func testAHeightKeptForTheSameKeyIsUsedAsKept() throws {
        let memo = try account().newSessionDraftHeight
        // A height no measurement gives: the first frame took the kept one.
        memo.keep(draft, key: key(), height: 88)
        XCTAssertEqual(firstFrame(memo, draft), 88)
    }

    func testAHeightMeasuredAtAnotherTextSizeIsNotUsed() throws {
        let memo = try account().newSessionDraftHeight
        let largest = key(TextScale(.accessibilityExtraExtraExtraLarge))
        XCTAssertNotEqual(largest, key(), "the text size is part of the key")
        XCTAssertEqual(largest.width, key().width, "at the same width")
        memo.keep(draft, key: largest, height: 88)
        XCTAssertEqual(firstFrame(memo, draft), line, "cold")
    }

    func testAKeyOfAnotherKindIsNotUsed() throws {
        let memo = try account().newSessionDraftHeight
        memo.keep(draft, key: "\(width)", height: 88)
        XCTAssertEqual(firstFrame(memo, draft), line)
    }

    func testAHeightMeasuredForAnotherWidthIsNotUsed() async throws {
        let memo = try account().newSessionDraftHeight
        let measured = await measure(memo, draft)
        // At the width it was measured for, the same text has it.
        XCTAssertEqual(firstFrame(memo, draft), measured)
        // Narrower: the kept height is not this key's.
        XCTAssertEqual(firstFrame(memo, draft, width: width - 100), line)
    }
}
#endif
