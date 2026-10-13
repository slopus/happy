import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// agentInputLayout.test.ts.
final class MobileComposerGeometryTests: XCTestCase {
    private let metrics = MobileComposerMetrics.mobile

    func testTextStartsAtTheAddGlyphsLeftEdge() {
        let insets = AgentInputInsets(shellInset: 10, actionSize: 42, addIconSize: 26)
        XCTAssertEqual(insets.textInset, 18)
        XCTAssertEqual(insets.inputContainerPaddingLeft, 8)
        XCTAssertEqual(insets.inputContainerPaddingRight, 8)
        XCTAssertEqual(insets.textInset, insets.shellInset + (42 - 26) / 2)
        XCTAssertEqual(AgentInputInsets.mobile, insets)
    }

    func testOneMetricContractForHomeAndChat() {
        XCTAssertEqual(metrics, MobileComposerMetrics(
            shellRadius: 30,
            shellInset: 10,
            shellPaddingTop: 8,
            shellPaddingBottom: 8,
            inputMinHeight: 44,
            inputMaxHeight: 120,
            inputFontSize: 16,
            inputLineHeight: 22,
            inputPaddingTop: 4,
            inputPaddingBottom: 4,
            actionRowHeight: 42,
            actionSize: 42,
            addIconSize: 26,
            secondaryActionHeight: 40,
            effortWidth: 64,
            primaryActionSize: 42,
            primaryActionMarginLeft: 8,
            attachmentExtraHeight: 72
        ))
        XCTAssertEqual(metrics.baseHeight, 102)
        XCTAssertEqual(metrics.chromeHeight, 58)
    }

    func testCollapsedTextStartsWhereTheCapsuleTurnsStraight() {
        let geometry = MobileCollapsedComposerGeometry()
        XCTAssertEqual(geometry.shellHeight, 56)
        XCTAssertEqual(geometry.shellRadius, 28)
        XCTAssertEqual(geometry.contentPaddingLeft, 7)
        XCTAssertEqual(geometry.contentPaddingRight, 7)
        XCTAssertEqual(geometry.inputPaddingLeft, 21)
        XCTAssertEqual(geometry.inputPaddingRight, 4)
        XCTAssertEqual(geometry.textInset, 28)
        XCTAssertEqual(geometry.textInset, geometry.shellRadius)
    }

    func testShellHeightGrowsWithTheInputAndAttachments() {
        XCTAssertEqual(metrics.composerHeight(inputHeight: 30), 102)
        XCTAssertEqual(metrics.composerHeight(inputHeight: 52), 118)
        XCTAssertEqual(metrics.composerHeight(inputHeight: 120), 186)
        XCTAssertEqual(metrics.composerHeight(inputHeight: 30, hasAttachments: true), 174)
    }

    func testIconMenuGeometry() {
        let geometry = metrics.menuGeometry(.icon)
        XCTAssertEqual(geometry.frame, ComposerGeometryStyle(width: .points(42), height: .points(42), flexShrink: 0))
        XCTAssertEqual(geometry.content, ComposerGeometryStyle(
            width: .fill, height: .fill, alignItems: .center, justifyContent: .center
        ))
    }

    /// The pair is right-aligned, so each chip keeps its slack outside the
    /// separator. Only the model shrinks; the effort reserves the widest
    /// label's width.
    func testModelMenuGeometry() {
        let geometry = metrics.menuGeometry(.model)
        XCTAssertEqual(geometry.frame, ComposerGeometryStyle(height: .points(40), minWidth: 0, flexShrink: 1))
        XCTAssertEqual(geometry.content, ComposerGeometryStyle(
            height: .points(40), minWidth: 0, flexDirectionRow: true, alignItems: .center,
            justifyContent: .flexEnd, borderRadius: 20, paddingLeft: 12, paddingRight: 4, gap: 7
        ))
    }

    func testEffortMenuGeometry() {
        let geometry = metrics.menuGeometry(.effort)
        XCTAssertEqual(geometry.frame, ComposerGeometryStyle(height: .points(40), minWidth: 64, flexShrink: 0))
        XCTAssertEqual(geometry.content, ComposerGeometryStyle(
            height: .points(40), minWidth: 0, flexDirectionRow: true, alignItems: .center,
            justifyContent: .flexStart, borderRadius: 20, paddingLeft: 4, paddingRight: 6, gap: 4
        ))
    }

    func testPermissionMenuGeometry() {
        let geometry = metrics.menuGeometry(.permission)
        XCTAssertEqual(geometry.frame, ComposerGeometryStyle(height: .points(40), flexShrink: 0))
        XCTAssertEqual(geometry.content, ComposerGeometryStyle(
            height: .points(40), flexDirectionRow: true, alignItems: .center,
            justifyContent: .center, borderRadius: 20, paddingLeft: 4, paddingRight: 8
        ))
    }

    /// The frame never carries the label's padding or gap.
    func testMenuFramesCarryNoPadding() {
        for variant in [ComposerControl.icon, .model, .effort, .permission] {
            let frame = metrics.menuGeometry(variant).frame
            XCTAssertNil(frame.paddingLeft)
            XCTAssertNil(frame.paddingRight)
            XCTAssertNil(frame.gap)
        }
    }

    func testRowAndCircularButtonsMatchInBothComposers() {
        XCTAssertEqual(metrics.actionRowGeometry, ComposerGeometryStyle(
            height: .points(42), flexDirectionRow: true, alignItems: .center,
            justifyContent: .flexStart, paddingHorizontal: 0, gap: 2
        ))
        XCTAssertEqual(metrics.actionGeometry(primary: false), ComposerGeometryStyle(
            width: .points(42), height: .points(42), flexShrink: 0, alignItems: .center,
            justifyContent: .center, borderRadius: 21
        ))
        XCTAssertEqual(metrics.actionGeometry(primary: true), ComposerGeometryStyle(
            width: .points(42), height: .points(42), flexShrink: 0, alignItems: .center,
            justifyContent: .center, borderRadius: 21, marginLeft: 8
        ))
    }

    /// [+] [ permission … model · effort ] [send]: the middle box is the
    /// row's only flexible child, and inside it only the model gives way.
    func testEveryChipSitsInOneMiddleBox() {
        XCTAssertEqual(metrics.middleGeometry, ComposerGeometryStyle(
            height: .points(42), minWidth: 0, flex: 1, flexDirectionRow: true, alignItems: .center,
            justifyContent: .flexStart, overflowHidden: true, gap: 2
        ))
        XCTAssertEqual(metrics.actionGeometry(primary: false).flexShrink, 0)
        XCTAssertEqual(metrics.actionGeometry(primary: true).flexShrink, 0)
        XCTAssertEqual(metrics.menuGeometry(.permission).frame.flexShrink, 0)
        XCTAssertEqual(metrics.menuGeometry(.effort).frame.flexShrink, 0)
        XCTAssertEqual(metrics.menuGeometry(.model).frame.flexShrink, 1)
        XCTAssertEqual(metrics.menuGeometry(.model).frame.minWidth, 0)
    }

    func testPaddingResolvesLikeYoga() {
        XCTAssertEqual(ComposerGeometryStyle(paddingLeft: 3, paddingHorizontal: 8).resolvedPaddingLeft, 3)
        XCTAssertEqual(ComposerGeometryStyle(paddingLeft: 3, paddingHorizontal: 8).resolvedPaddingRight, 8)
        XCTAssertEqual(ComposerGeometryStyle().resolvedPaddingLeft, 0)
    }
}

/// multiTextInputLayout.test.ts.
final class MultiTextInputLayoutTests: XCTestCase {
    private func resolve(
        _ contentHeight: CGFloat, _ maxHeight: CGFloat, _ lineHeight: CGFloat,
        _ paddingTop: CGFloat, _ paddingBottom: CGFloat, _ minimumHeight: CGFloat?, _ chrome: CGFloat
    ) -> MultiTextInputLayout {
        MultiTextInputLayout(
            contentHeight: contentHeight,
            maxHeight: maxHeight,
            lineHeight: lineHeight,
            paddingTop: paddingTop,
            paddingBottom: paddingBottom,
            minimumHeight: minimumHeight,
            containerChromeHeight: chrome
        )
    }

    func testOneLine() {
        XCTAssertEqual(resolve(22, 120, 22, 0, 0, nil, 0), .init(height: 22, containerHeight: 22, scrollEnabled: false))
    }

    func testMultilineGrowth() {
        XCTAssertEqual(resolve(66, 120, 22, 0, 0, nil, 0), .init(height: 66, containerHeight: 66, scrollEnabled: false))
    }

    func testCapEnablesScrolling() {
        XCTAssertEqual(resolve(180, 120, 22, 0, 0, nil, 0), .init(height: 120, containerHeight: 120, scrollEnabled: true))
    }

    func testShrinkingBelowCap() {
        XCTAssertEqual(resolve(44, 120, 22, 0, 0, nil, 0), .init(height: 44, containerHeight: 44, scrollEnabled: false))
    }

    func testVerticalPaddingContributesMinimum() {
        XCTAssertEqual(resolve(10, 120, 22, 4, 6, nil, 0), .init(height: 32, containerHeight: 32, scrollEnabled: false))
    }

    func testExplicitMinimumKeepsACompactInputTallEnough() {
        XCTAssertEqual(resolve(10, 120, 22, 4, 6, 44, 0), .init(height: 44, containerHeight: 44, scrollEnabled: false))
    }

    func testComposerChromeGrowsWithMultilineInput() {
        XCTAssertEqual(resolve(66, 120, 22, 0, 0, 44, 66), .init(height: 66, containerHeight: 132, scrollEnabled: false))
    }

    func testClearedTextWithAStaleMeasurementReturnsToTheMinimum() {
        let layout = MultiTextInputLayout(
            contentHeight: 120,
            hasText: false,
            maxHeight: 120,
            lineHeight: 24,
            paddingTop: 8,
            paddingBottom: 4,
            minimumHeight: 44,
            containerChromeHeight: 66
        )
        XCTAssertEqual(layout, .init(height: 44, containerHeight: 110, scrollEnabled: false))
    }
}

final class AgentInputCardLayoutTests: XCTestCase {
    /// An iPhone 15's card: 393 less the composer's 8 + 8.
    private func card(
        text: CGFloat = 30,
        hasText: Bool = true,
        attachments: Int = 0,
        border: CGFloat = 0,
        showsAdd: Bool = false,
        permission: CGSize? = nil,
        model: CGSize? = nil,
        modelIsMenu: Bool = true,
        effort: CGSize? = nil,
        minHeight: CGFloat? = nil,
        zenMode: Bool = false
    ) -> AgentInputCardLayout {
        AgentInputCardLayout(.init(
            width: 377,
            borderWidth: border,
            attachmentCount: attachments,
            textContentHeight: text,
            hasText: hasText,
            inputMinHeight: minHeight,
            showsAdd: showsAdd,
            permission: permission.map(AgentInputCardLayout.Chip.init),
            model: model.map(AgentInputCardLayout.Chip.init),
            modelIsMenu: modelIsMenu,
            effort: effort.map(AgentInputCardLayout.Chip.init),
            separator: effort == nil ? .zero : CGSize(width: 5, height: 17),
            zenMode: zenMode
        ))
    }

    func testOneLineCard() {
        let layout = card()
        assertSize(layout.size, CGSize(width: 377, height: 102))
        XCTAssertNil(layout.attachments)
        assertFrame(layout.inputContainer, rect(10, 8, 357, 44))
        assertFrame(layout.text, rect(18, 15, 341, 30))
        XCTAssertFalse(layout.textScrolls)
        assertFrame(layout.actionRow, rect(10, 52, 357, 42))
        XCTAssertNil(layout.add)
        assertFrame(layout.primary, rect(325, 52, 42, 42))
        assertFrame(layout.middle, rect(10, 52, 305, 42))
    }

    /// The card is the height agentInputLayout.ts promises for each input.
    func testHeightMatchesTheMetricContract() {
        let metrics = MobileComposerMetrics.mobile
        XCTAssertEqual(card(text: 30).size.height, metrics.composerHeight(inputHeight: 30))
        XCTAssertEqual(card(text: 52).size.height, metrics.composerHeight(inputHeight: 52))
        XCTAssertEqual(card(text: 120).size.height, metrics.composerHeight(inputHeight: 120))
        XCTAssertEqual(card(attachments: 2).size.height, metrics.composerHeight(inputHeight: 30, hasAttachments: true))
    }

    func testTextGrowsThenScrollsAtTheCap() {
        let grown = card(text: 74)
        assertFrame(grown.inputContainer, rect(10, 8, 357, 82))
        assertFrame(grown.text, rect(18, 12, 341, 74))
        XCTAssertFalse(grown.textScrolls)

        let capped = card(text: 300)
        assertFrame(capped.inputContainer, rect(10, 8, 357, 128))
        assertFrame(capped.text, rect(18, 12, 341, 120))
        XCTAssertTrue(capped.textScrolls)
        XCTAssertEqual(capped.size.height, 186)
    }

    /// A cleared input drops to one line whatever was last measured.
    func testEmptyInputIgnoresAStaleMeasurement() {
        let layout = card(text: 120, hasText: false)
        assertFrame(layout.text, rect(18, 15, 341, 30))
        XCTAssertEqual(layout.size.height, 102)
    }

    func testMinimumHeightOverride() {
        let layout = card(minHeight: 60)
        assertFrame(layout.inputContainer, rect(10, 8, 357, 60))
        assertFrame(layout.text, rect(18, 23, 341, 30))
        XCTAssertEqual(layout.size.height, 118)
    }

    func testAttachmentStripAboveTheInput() {
        let layout = card(attachments: 3)
        assertFrame(layout.attachments, rect(18, 8, 341, 64))
        assertFrame(layout.inputContainer, rect(10, 80, 357, 44))
        assertFrame(layout.actionRow, rect(10, 124, 357, 42))
        XCTAssertEqual(layout.size.height, 174)
    }

    func testBorderInsetsEverything() {
        let layout = card(border: 0.5)
        assertFrame(layout.inputContainer, rect(10.5, 8.5, 356, 44))
        assertFrame(layout.primary, rect(324.5, 52.5, 42, 42))
        XCTAssertEqual(layout.size.height, 103)
    }

    /// [+] 2 [ permission ·spacer· model · effort ] 2 8 [send]
    func testChipsInTheMiddleBox() {
        let layout = card(
            showsAdd: true,
            permission: CGSize(width: 30, height: 17),
            model: CGSize(width: 80, height: 17),
            effort: CGSize(width: 40, height: 17)
        )
        assertFrame(layout.add, rect(10, 52, 42, 42))
        assertFrame(layout.middle, rect(54, 52, 261, 42))
        assertFrame(layout.primary, rect(325, 52, 42, 42))

        let content = layout.middleContent
        // 4 + 30 + 8, label centred.
        assertFrame(content.permission?.frame, rect(0, 1, 42, 40))
        assertFrame(content.permission?.label, rect(6, 11.5, 30, 17))
        // The spacer takes the 46 left over; 12 + 80 + 4, label flush right.
        assertFrame(content.model?.frame, rect(92, 1, 96, 40))
        assertFrame(content.model?.label, rect(16, 11.5, 80, 17))
        assertFrame(content.separator, rect(190, 12.5, 5, 17))
        // 4 + 40 + 6 is under the 64 minimum; label flush left.
        assertFrame(content.effort?.frame, rect(197, 1, 64, 40))
        assertFrame(content.effort?.label, rect(0, 11.5, 40, 17))
        XCTAssertEqual(content.effort?.frame.maxX, layout.middle.width)
    }

    /// AgentInput.tsx in zen mode: `!zenMode &&` drops add, permission,
    /// model and effort; the middle box keeps only its spacer.
    func testZenModeLeavesTheTextAndSend() {
        let layout = card(
            attachments: 1,
            showsAdd: true,
            permission: CGSize(width: 30, height: 17),
            model: CGSize(width: 80, height: 17),
            effort: CGSize(width: 40, height: 17),
            zenMode: true
        )
        XCTAssertNil(layout.add)
        assertFrame(layout.middle, rect(10, 124, 305, 42))
        assertFrame(layout.primary, rect(325, 124, 42, 42))
        XCTAssertEqual(layout.middleContent, AgentInputCardLayout.MiddleContent())
        // Pictures already picked stay, and the height doesn't move.
        assertFrame(layout.attachments, rect(18, 8, 341, 64))
        XCTAssertEqual(layout.size.height, card(attachments: 1, showsAdd: true).size.height)
        XCTAssertEqual(card(zenMode: true), card())
    }

    /// A long model name is the only thing cut; effort keeps its corner.
    func testOnlyTheModelShrinks() {
        let layout = card(
            showsAdd: true,
            permission: CGSize(width: 30, height: 17),
            model: CGSize(width: 300, height: 17),
            effort: CGSize(width: 40, height: 17)
        )
        let content = layout.middleContent
        assertFrame(content.permission?.frame, rect(0, 1, 42, 40))
        assertFrame(content.model?.frame, rect(46, 1, 142, 40))
        assertFrame(content.model?.label, rect(0, 11.5, 142, 17))
        assertFrame(content.effort?.frame, rect(197, 1, 64, 40))
    }

    func testModelWithoutAMenuUsesThePlainChipPadding() {
        let layout = card(model: CGSize(width: 80, height: 17), modelIsMenu: false)
        // 305 wide: [spacer] 2 [8 + 80].
        assertFrame(layout.middleContent.model?.frame, rect(217, 1, 88, 40))
        assertFrame(layout.middleContent.model?.label, rect(8, 11.5, 80, 17))
        XCTAssertNil(layout.middleContent.permission)
        XCTAssertNil(layout.middleContent.effort)
        XCTAssertNil(layout.middleContent.separator)
    }

    func testAttachmentThumbnails() {
        let placed = AgentInputCardLayout.attachmentThumbnails(count: 3)
        XCTAssertEqual(placed.frames.count, 3)
        assertFrame(placed.frames[0], rect(4, 0, 64, 64))
        assertFrame(placed.frames[1], rect(76, 0, 64, 64))
        assertFrame(placed.frames[2], rect(148, 0, 64, 64))
        XCTAssertEqual(placed.contentWidth, 216)
        XCTAssertEqual(AgentInputCardLayout.attachmentThumbnails(count: 0).contentWidth, 0)
        assertFrame(AgentInputCardLayout.attachmentRemoveButton, rect(52, -6, 18, 18))
    }
}

final class AgentInputLayoutTests: XCTestCase {
    private let oneLine = AgentInputCardLayout.Input(width: 0, textContentHeight: 30, hasText: true)

    func testCardAloneInTheContainerPadding() {
        let layout = AgentInputLayout(.init(width: 393, card: oneLine))
        XCTAssertNil(layout.status)
        XCTAssertNil(layout.usage)
        assertFrame(layout.card, rect(8, 8, 377, 102))
        XCTAssertEqual(layout.cardOffset, 8)
        XCTAssertEqual(layout.cardLayout?.size.width, 377)
        assertSize(layout.size, CGSize(width: 393, height: 118))
        assertFrame(layout.inner, rect(8, 8, 377, 102))
    }

    func testStatusAndUsageRowsAroundTheCard() {
        let layout = AgentInputLayout(.init(
            width: 393,
            statusText: CGSize(width: 100, height: 13),
            card: oneLine,
            usageWeek: CGSize(width: 60, height: 13),
            usageContext: CGSize(width: 70, height: 13)
        ))
        assertFrame(layout.status?.frame, rect(8, 8, 377, 20))
        assertFrame(layout.status?.dot, rect(24, 13.5, 6, 6))
        assertFrame(layout.status?.text, rect(34, 9.5, 100, 13))
        assertFrame(layout.card, rect(8, 28, 377, 102))
        XCTAssertEqual(layout.cardOffset, 28)

        assertFrame(layout.usage?.frame, rect(8, 130, 377, 20))
        assertFrame(layout.usage?.context, rect(278, 136, 89, 14))
        assertFrame(layout.usage?.contextText, rect(278, 136.5, 70, 13))
        assertFrame(layout.usage?.gauge, rect(353, 136, 14, 14))
        assertFrame(layout.usage?.week, rect(208, 136.5, 60, 13))
        assertSize(layout.size, CGSize(width: 393, height: 158))
        assertFrame(layout.inner, rect(8, 8, 377, 142))
    }

    func testWeekAloneSitsAtTheRightEdge() {
        let layout = AgentInputLayout(.init(width: 393, card: oneLine, usageWeek: CGSize(width: 60, height: 13)))
        assertFrame(layout.usage?.frame, rect(8, 110, 377, 19))
        assertFrame(layout.usage?.week, rect(307, 116, 60, 13))
        XCTAssertNil(layout.usage?.context)
        XCTAssertNil(layout.usage?.gauge)
    }

    func testStatusTextIsCutAtTheRowsPadding() {
        let layout = AgentInputLayout(.init(width: 393, statusText: CGSize(width: 500, height: 13), card: oneLine))
        // 8 + 377 - 16 - 34.
        assertFrame(layout.status?.text, rect(34, 9.5, 335, 13))
    }

    func testWideScreensCentreTheInnerContainer() {
        let layout = AgentInputLayout(.init(
            width: 900,
            paddingH: AgentInputLayout.Metrics.containerPaddingHWide,
            maxContentWidth: 800,
            card: oneLine
        ))
        assertFrame(layout.card, rect(50, 8, 800, 102))
    }

    func testAutocompleteFloatsAboveTheComposer() {
        let layout = AgentInputLayout(.init(width: 393, card: oneLine))
        assertFrame(layout.autocomplete(rows: 3, border: 0.5), rect(16, -145, 361, 145))
        assertFrame(layout.autocomplete(rows: 10, border: 0.5), rect(16, -320, 361, 320))
        assertFrame(layout.autocomplete(rows: 0, border: 0), rect(16, 0, 361, 0))
    }

    func testWideScreensRunTheListToTheInnerEdges() {
        let layout = AgentInputLayout(.init(
            width: 900,
            paddingH: AgentInputLayout.Metrics.containerPaddingHWide,
            maxContentWidth: 800,
            card: oneLine
        ))
        assertFrame(layout.autocomplete(rows: 2, border: 0.5), rect(50, -97, 800, 97))
    }
}

final class ComposerTokenTests: XCTestCase {
    func testEveryComposerTokenParsed() {
        let magenta = RGBA(red: 1, green: 0, blue: 1, alpha: 0.999)
        for token in Palette.composer {
            XCTAssertNotEqual(token.light, magenta)
            XCTAssertNotEqual(token.dark, magenta)
        }
    }

    func testThemeValuesFromHappyApp() {
        XCTAssertEqual(Palette.composerPrimaryInactive, ColorToken(light: RGBA(hex: "#D1D1D6")!, dark: RGBA(hex: "#3A3A3C")!))
        XCTAssertEqual(Palette.composerStopFill.dark, RGBA(hex: "#F5F5F5"))
        XCTAssertEqual(Palette.composerFrostedOverlay.light.alpha, 0.82)
        XCTAssertEqual(Palette.sessionStatusThinking.light, RGBA(hex: "#007AFF"))
        XCTAssertEqual(TextStyles.composerInput, TextStyle(.regular, size: 16, lineHeight: 22))
    }

    func testContextGaugeIntensity() {
        XCTAssertEqual(ContextGauge.intensity(percent: 0), 0.35, accuracy: 0.0001)
        XCTAssertEqual(ContextGauge.intensity(percent: 50), 0.675, accuracy: 0.0001)
        XCTAssertEqual(ContextGauge.intensity(percent: 140), 1, accuracy: 0.0001)
    }
}
