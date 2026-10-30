import CoreGraphics
import HappyLayout
import XCTest

/// The compact card (the text in the action row, the chips behind an
/// options button) and when the chat's screen asks for it.
final class CompactComposerLayoutTests: XCTestCase {
    /// A phone held sideways: 874 wide, the card 8 in from each side.
    private let width: CGFloat = 858

    private func card(text: CGFloat = 0, hasText: Bool = false, lineHeight: CGFloat? = nil, compact: Bool = true,
                      chips: Bool = true, showsAdd: Bool = true, zenMode: Bool = false, offersExpand: Bool = true) -> AgentInputCardLayout {
        AgentInputCardLayout(.init(
            width: width,
            textContentHeight: text,
            hasText: hasText,
            lineHeight: lineHeight,
            showsAdd: showsAdd,
            model: chips ? .init(labelSize: CGSize(width: 60, height: 17)) : nil,
            effort: chips ? .init(labelSize: CGSize(width: 40, height: 17)) : nil,
            separator: chips ? CGSize(width: 5, height: 17) : .zero,
            zenMode: zenMode,
            offersExpand: offersExpand,
            compact: compact
        ))
    }

    func testOneRowIsAddTextOptionsAndSend() throws {
        let layout = card()
        XCTAssertEqual(layout.size, CGSize(width: width, height: 60))
        XCTAssertEqual(card(compact: false).size.height, 102)
        XCTAssertEqual(layout.add, CGRect(x: 10, y: 9, width: 42, height: 42))
        XCTAssertEqual(layout.inputContainer, CGRect(x: 54, y: 8, width: 700, height: 44))
        XCTAssertEqual(layout.text, CGRect(x: 62, y: 15, width: 684, height: 30))
        XCTAssertEqual(layout.options, CGRect(x: 756, y: 9, width: 42, height: 42))
        XCTAssertEqual(layout.primary, CGRect(x: 806, y: 9, width: 42, height: 42))
        XCTAssertEqual(layout.middleContent, .init())
        XCTAssertNil(card(compact: false).options)
    }

    func testTheTextWrapsAtTheWidthItIsMeasuredAt() {
        let input = AgentInputCardLayout.Input(width: width, textContentHeight: 0, hasText: false, showsAdd: true,
                                               model: .init(labelSize: .zero), compact: true)
        XCTAssertEqual(AgentInputCardLayout.textWidth(input), card().text.width)
        var full = input
        full.compact = false
        XCTAssertEqual(AgentInputCardLayout.textWidth(full), card(compact: false).text.width)
    }

    func testNoChipsNoOptionsButton() {
        let layout = card(chips: false)
        XCTAssertNil(layout.options)
        XCTAssertEqual(layout.inputContainer.maxX, layout.primary.minX - 8 - 2)
        XCTAssertNil(card(zenMode: true).options)
        XCTAssertNil(card(zenMode: true).add)
    }

    func testTwoLinesShowAndTheThirdScrolls() throws {
        let two = card(text: 2 * 22 + 8, hasText: true)
        XCTAssertFalse(two.textScrolls)
        XCTAssertEqual(two.inputContainer.height, 60)
        XCTAssertNil(two.expand)
        // The buttons keep to the row's foot.
        XCTAssertEqual(two.primary.midY, two.inputContainer.maxY - 22)
        XCTAssertEqual(two.options?.midY, two.primary.midY)

        XCTAssertEqual(two.textPaddingTop, 4)
        XCTAssertEqual(two.textPaddingBottom, 4)

        let three = card(text: 3 * 22 + 8, hasText: true)
        XCTAssertTrue(three.textScrolls)
        // The row is as tall as the cap makes it; the text view inside is
        // its two lines and no padding, centred where the padded one was.
        XCTAssertEqual(three.inputContainer.height, AgentInputCardLayout.compactTextCap(lineHeight: 22) + 8)
        XCTAssertEqual(three.text.height, 44)
        XCTAssertEqual(three.text.minY, three.inputContainer.minY + 4 + 4 + 1)
        XCTAssertEqual(three.textPaddingTop, 0)
        XCTAssertEqual(three.textPaddingBottom, 0)
        XCTAssertEqual(card(text: 8 * 22 + 8, hasText: true, compact: false).textPaddingTop, 4, "the full card keeps its padding")
        let expand = try XCTUnwrap(three.expand)
        XCTAssertEqual(expand.maxX, three.inputContainer.maxX)
        XCTAssertLessThan(expand.maxX, try XCTUnwrap(three.options).minX)
        XCTAssertGreaterThan(three.textTrailingInset, 0)
    }

    /// A larger text size keeps its lines: the 44 is a minimum, not a cap.
    func testTheTextSizeGrowsTheRow() {
        let line: CGFloat = 33
        let one = card(text: line + 8, hasText: true, lineHeight: line)
        XCTAssertEqual(one.inputContainer.height, line + 8 + 8)
        XCTAssertGreaterThan(one.inputContainer.height, 44)
        let two = card(text: 2 * line + 8, hasText: true, lineHeight: line)
        XCTAssertFalse(two.textScrolls)
        XCTAssertEqual(two.text.height, 2 * line + 8)
        let three = card(text: 3 * line + 8, hasText: true, lineHeight: line)
        XCTAssertTrue(three.textScrolls)
        XCTAssertEqual(three.text.height, 2 * line)
    }

    // MARK: When

    private let landscape = CGSize(width: 874, height: 402)
    private let landscapeSafe = LayoutInsets(top: 60, left: 62, bottom: 21, right: 62)
    private let portrait = CGSize(width: 402, height: 874)
    private let portraitSafe = LayoutInsets(top: 116, left: 0, bottom: 34, right: 0)

    func testSidewaysWithTheKeyboardUpGoesCompact() {
        let keyboardTop: CGFloat = 195
        let full = ChatScreenLayout(size: landscape, safeArea: landscapeSafe, keyboardTop: keyboardTop) { _ in 103 }
        XCTAssertEqual(full.viewport, 16)
        XCTAssertTrue(ChatScreenLayout.compacts(size: landscape, safeArea: landscapeSafe, keyboardTop: keyboardTop) { _ in 103 })
        let compact = ChatScreenLayout(size: landscape, safeArea: landscapeSafe, keyboardTop: keyboardTop) { _ in 61 }
        // What it gives, under the 120 that sets it off.
        XCTAssertEqual(compact.viewport, 58)
    }

    func testSidewaysWithTheKeyboardDownAndUprightStayFull() {
        XCTAssertFalse(ChatScreenLayout.compacts(size: landscape, safeArea: landscapeSafe, keyboardTop: .greatestFiniteMagnitude) { _ in 103 })
        XCTAssertFalse(ChatScreenLayout.compacts(size: portrait, safeArea: portraitSafe, keyboardTop: 874 - 336) { _ in 103 })
        XCTAssertFalse(ChatScreenLayout.compacts(size: portrait, safeArea: portraitSafe, keyboardTop: .greatestFiniteMagnitude) { _ in 103 })
    }

    /// As measured on an iPhone 17 Pro sideways (874 × 402): the bar's foot
    /// at 78, the keyboard's top at 194 (its suggestions included).
    func testHidingTheBarSidewaysGivesTheTranscriptItsRoom() {
        let keyboardTop: CGFloat = 194
        let underBar = LayoutInsets(top: 78, left: 62, bottom: 21, right: 62)
        let noBar = LayoutInsets(top: 0, left: 62, bottom: 21, right: 62)
        XCTAssertEqual(ChatScreenLayout(size: landscape, safeArea: underBar, keyboardTop: keyboardTop) { _ in 60 }.viewport, 40)
        XCTAssertEqual(ChatScreenLayout(size: landscape, safeArea: noBar, keyboardTop: keyboardTop) { _ in 60 }.viewport, 118)
        // Hidden, the bar can't undo the shape that hid it: decided under
        // the bar it stays compact, and so it would without it.
        XCTAssertTrue(ChatScreenLayout.compacts(size: landscape, safeArea: underBar, keyboardTop: keyboardTop) { _ in 102 })
        XCTAssertTrue(ChatScreenLayout.compacts(size: landscape, safeArea: noBar, keyboardTop: keyboardTop) { _ in 102 })
    }

    func testTheBarHidesOnlySidewaysWithTheKeyboardUpAndTheCardCompact() {
        XCTAssertTrue(ChatScreenLayout.hidesBar(compact: true, sideways: true, keyboardUp: true))
        XCTAssertFalse(ChatScreenLayout.hidesBar(compact: true, sideways: true, keyboardUp: false))
        XCTAssertFalse(ChatScreenLayout.hidesBar(compact: true, sideways: false, keyboardUp: true))
        XCTAssertFalse(ChatScreenLayout.hidesBar(compact: false, sideways: true, keyboardUp: true))
    }

    func testTheThresholdIsTheFullCardsTranscript() {
        // 402 - 21 - 8 - 103 - 8 - 60 leaves 202 with the keyboard down;
        // a keyboard top that leaves 120 exactly stays full, one point
        // higher goes compact.
        let exact: CGFloat = 60 + 120 + 8 + 103 + 8
        XCTAssertFalse(ChatScreenLayout.compacts(size: landscape, safeArea: landscapeSafe, keyboardTop: exact) { _ in 103 })
        XCTAssertTrue(ChatScreenLayout.compacts(size: landscape, safeArea: landscapeSafe, keyboardTop: exact - 1) { _ in 103 })
    }
}
