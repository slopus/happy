#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// `NoSessionsMeasure.measure`, off the main thread, against a StyledLabel
/// of the same style, lines and alignment measuring itself at the same
/// text size and scale, as a layout takes each (`Measurable.size(fitting:)`,
/// never wider than the width offered). Where a line runs past the width
/// (a break's whitespace past the edge, or a line cut short) a label's own
/// size is at least the width, and so is the measure's.
@MainActor
final class NoSessionsMeasureParityTests: XCTestCase {
    private enum Overflow {
        /// Every line is within the width.
        case none
        /// A line runs past it: the measure is the whole width.
        case runsPast
    }

    private struct Case {
        var name: String
        var string: String
        var text: (style: TextStyle, lines: Int, alignment: NSTextAlignment)
        var category: UIContentSizeCategory
        var width: CGFloat
        /// At least this many lines, as drawn.
        var lines: Int
        var overflow: Overflow
    }

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private static let titleText = NoSessionsView.titleText
    private static let descriptionText = NoSessionsView.descriptionText
    private static let actionText = TextActionButton.labelText
    private static let buttonText = RoundButton.labelText(.large, display: .filled)

    private var cases: [Case] { [
        // (i) One line that fits.
        Case(name: "title, one line", string: Strings.EmptyMain.noSessionsTitle, text: Self.titleText, category: .large, width: 345, lines: 1, overflow: .none),
        Case(name: "action, one line", string: Strings.Sidebar.showArchived, text: Self.actionText, category: .large, width: 244, lines: 1, overflow: .none),
        // (ii) Wrapped, the break's space within the width.
        Case(name: "description, wrapped", string: Strings.EmptyMain.noSessionsDescription, text: Self.descriptionText, category: .extraExtraExtraLarge, width: 272, lines: 2, overflow: .none),
        // (iii) Wrapped after a word that only just fits, its space past
        // the edge (run 38550113700: 343 and 271 against 345 and 272).
        Case(name: "title, break past the edge", string: Strings.EmptyMain.noSessionsTitle, text: Self.titleText, category: .accessibilityExtraExtraExtraLarge, width: 345, lines: 3, overflow: .runsPast),
        Case(name: "description, break past the edge", string: Strings.EmptyMain.noSessionsDescription, text: Self.descriptionText, category: .accessibilityExtraExtraExtraLarge, width: 272, lines: 4, overflow: .runsPast),
        // (iv) A word longer than the line, broken inside it.
        Case(name: "title, a word longer than the line", string: Strings.EmptyMain.noSessionsTitle, text: Self.titleText, category: .accessibilityExtraExtraExtraLarge, width: 272, lines: 3, overflow: .none),
        // (v) One line cut short (run 38550113700: 227 and 306.67 against
        // 244 and 317), and the button's label, cut short the same way.
        Case(name: "action, cut short", string: Strings.Sidebar.showArchived, text: Self.actionText, category: .accessibilityExtraExtraExtraLarge, width: 244, lines: 1, overflow: .runsPast),
        Case(name: "action, cut short, wider", string: Strings.Sidebar.showArchived, text: Self.actionText, category: .accessibilityExtraExtraExtraLarge, width: 317, lines: 1, overflow: .runsPast),
        Case(name: "button, cut short", string: Strings.NewSession.startNewSession, text: Self.buttonText, category: .accessibilityExtraExtraExtraLarge, width: 272, lines: 1, overflow: .runsPast),
        // (vi) Its own line break.
        Case(name: "description, own break", string: "Start one\non a connected machine.", text: Self.descriptionText, category: .large, width: 272, lines: 2, overflow: .none),
    ] }

    func testTheMeasureIsWhatTheLabelMeasures() async {
        for item in cases {
            for scale in [CGFloat(2), 3] {
                let message = "\(item.name), \(item.category.rawValue) at \(item.width) @\(scale)x"
                let label = StyledLabel(style: item.text.style, color: Palette.text, lines: item.text.lines, alignment: item.text.alignment)
                label.string = item.string
                label.traitOverrides.preferredContentSizeCategory = item.category
                label.traitOverrides.displayScale = scale
                label.traitOverrides.followsTextSize = true
                label.updateTraitsIfNeeded()
                let environment = TextEnvironment(scale: TextScale(TextSizeCategory(item.category)), displayScale: scale)
                // The label draws at that text size and scale.
                XCTAssertEqual(TextEnvironment(label.traitCollection), environment, message)
                XCTAssertNil(label.style.maxScale, message)
                XCTAssertEqual(label.renderedStyle.size, label.style.size * TextScale(TextSizeCategory(item.category)).multiplier, message)

                let string = item.string
                let text = item.text
                let width = item.width
                let measured = await Task.detached {
                    NoSessionsMeasure.measure(string, style: text.style, lines: text.lines, alignment: text.alignment, environment: environment, width: width)
                }.value
                let labelSize = label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
                let expected = label.measurable.size(fitting: width)
                let actual = Measurable.fixed(measured).size(fitting: width)
                let detail = "\(message): measured \(measured), the label \(labelSize)"
                XCTAssertEqual(actual.width, expected.width, accuracy: 0.001, "width, \(detail)")
                XCTAssertEqual(actual.height, expected.height, accuracy: 0.001, "height, \(detail)")

                // The case is the one it says.
                XCTAssertGreaterThanOrEqual(measured.height, CGFloat(item.lines) * label.lineHeight, "lines, \(detail)")
                switch item.overflow {
                case .none:
                    XCTAssertLessThan(measured.width, width, "within the width, \(detail)")
                case .runsPast:
                    XCTAssertEqual(measured.width, width, "past the width, \(detail)")
                }
            }
        }
    }
}
#endif
