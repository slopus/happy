#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// Home's dock and the new-session screen at the person's text size: the
/// heights made off the main thread (`HomeDockText`, `MeasuredLabelSizes`,
/// the prompt's `ComposerTextHeights`) are the ones the labels and the
/// prompt draw at, at several sizes, accessibility sizes included.
@MainActor
final class HomeDockTextSizeTests: XCTestCase {
    private let categories: [UIContentSizeCategory] = [.extraSmall, .large, .extraExtraExtraLarge, .accessibilityMedium, .accessibilityExtraExtraExtraLarge]
    private let scales: [CGFloat] = [2, 3]

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func environment(_ category: UIContentSizeCategory, _ scale: CGFloat) -> TextEnvironment {
        TextEnvironment(scale: TextScale(TextSizeCategory(category)), displayScale: scale)
    }

    /// A window that follows the text size at `category` on a `scale`
    /// screen, as a screen that follows it does. Out of a window, a view
    /// put in a host whose traits were already updated keeps the traits it
    /// had and never takes the host's, not even after it or the host is
    /// updated again (the Mac run left the labels and the row at the
    /// simulator's own Large and 3x); in a window it takes them.
    private func host(_ category: UIContentSizeCategory, _ scale: CGFloat) -> UIWindow {
        let host = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        host.traitOverrides.followsTextSize = true
        host.traitOverrides.displayScale = scale
        host.traitOverrides.preferredContentSizeCategory = category
        return host
    }

    private func label(_ style: TextStyle, _ string: String, lines: Int = 1, alignment: NSTextAlignment = .natural, in host: UIView) -> StyledLabel {
        let label = StyledLabel(style: style, color: Palette.text, lines: lines, alignment: alignment)
        label.string = string
        host.addSubview(label)
        label.updateTraitsIfNeeded()
        return label
    }

    private func size(_ label: UIView, _ width: CGFloat) -> CGSize {
        label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    // MARK: The dock

    func testTheDocksHeightsAreTheLabelsAtEverySize() async {
        for category in categories {
            for scale in scales {
                let at = "@\(scale)x \(category.rawValue)"
                let host = host(category, scale)
                host.updateTraitsIfNeeded()
                for width in [CGFloat(320), 393, 430] {
                    let key = HomeDockController.textKey(width: width, text: environment(category, scale))
                    let text = await HomeDockText.make(key)
                    XCTAssertEqual(key.ledeWidth, HomeDockHeaderLayout.ledeWidth(width: width))
                    XCTAssertEqual(size(label(TextStyles.homeDockEntry, Strings.Home.dockPlaceholder, in: host), .greatestFiniteMagnitude).height, text.entryLine, "entry, \(at)")
                    XCTAssertEqual(size(label(TextStyles.homeDockRowValue, "MacBook Pro", in: host), .greatestFiniteMagnitude).height, text.triggerLine, "trigger, \(at)")
                    XCTAssertEqual(size(label(TextStyles.homeDockProgress, Strings.Home.interruptHint, in: host), .greatestFiniteMagnitude).height, text.progressLine, "progress, \(at)")
                    XCTAssertEqual(size(label(TextStyles.botFaceHeading, Strings.Home.botFaceHeading, in: host), .greatestFiniteMagnitude).height, text.faceHeadingLine, "faces, \(at)")
                    XCTAssertEqual(size(label(TextStyles.botFaceCredit, Strings.Home.botFaceCreditLead, in: host), .greatestFiniteMagnitude).height, text.creditLine, "credit, \(at)")
                    let lede = label(TextStyles.homeDockLede, Strings.Home.botLede, lines: 0, alignment: .center, in: host)
                    XCTAssertEqual(size(lede, key.ledeWidth), text.lede, "lede at \(width), \(at)")
                    host.subviews.forEach { $0.removeFromSuperview() }
                }
            }
        }
    }

    /// The resting dock on home, whose screen doesn't follow the text size:
    /// the dock follows on its own, draws its prompt at the size and lays
    /// it out at the line made for it off the main thread.
    func testTheRestingDockDrawsItsPromptAtTheTextSize() async throws {
        for category in categories {
            let m = TextScale(TextSizeCategory(category)).multiplier
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
            window.traitOverrides.preferredContentSizeCategory = category
            let home = UIView(frame: window.bounds)
            window.addSubview(home)
            let dock = HomeDockView(frame: home.bounds)
            home.addSubview(dock)
            dock.updateTraitsIfNeeded()
            let entry = try XCTUnwrap(styledLabels(in: dock).first { $0.style == TextStyles.homeDockEntry })
            entry.updateTraitsIfNeeded()
            XCTAssertEqual(entry.renderedStyle.size, TextStyles.homeDockEntry.size * m, accuracy: 0.0001, category.rawValue)
            // As home asks for it, from its own traits.
            let text = await HomeDockText.make(HomeDockController.textKey(width: home.bounds.width, text: TextEnvironment(home.traitCollection)))
            dock.text = text
            dock.layoutIfNeeded()
            XCTAssertEqual(text.entryLine, size(entry, .greatestFiniteMagnitude).height, category.rawValue)
            XCTAssertEqual(entry.frame.height, text.entryLine, accuracy: 1 / dock.layoutScale + 0.0001, category.rawValue)
        }
    }

    private func styledLabels(in view: UIView) -> [StyledLabel] {
        view.subviews.flatMap { ($0 as? StyledLabel).map { [$0] } ?? styledLabels(in: $0) }
    }

    func testTheStoreLandsOnlyTheLatestKey() async {
        let store = HomeDockTextStore()
        var changes = 0
        store.onChange = { changes += 1 }
        let small = HomeDockController.textKey(width: 393, text: environment(.small, 3))
        let large = HomeDockController.textKey(width: 393, text: environment(.accessibilityExtraExtraExtraLarge, 3))
        store.prepare(small)
        store.prepare(large)
        var answer: HomeDockText?
        store.whenReady(large, timeout: .seconds(5)) { answer = $0 }
        while answer == nil { try? await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(answer?.key, large)
        XCTAssertNil(store.text(for: small), "an older key never lands")
        XCTAssertEqual(store.text(for: large), answer)
        XCTAssertEqual(changes, 1)
        // Asked again, it answers at once.
        var again: HomeDockText?
        store.whenReady(large, timeout: .zero) { again = $0 }
        XCTAssertEqual(again, answer)
    }

    func testTheDeadlineAnswersNilOnce() async {
        let store = HomeDockTextStore()
        var answers: [HomeDockText?] = []
        store.whenReady(HomeDockController.textKey(width: 393, text: environment(.large, 3)), timeout: .zero) { answers.append($0) }
        try? await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(answers.count, 1)
    }

    func testTheFacesCreditAndALinksValueScale() {
        for category in categories {
            let m = TextScale(TextSizeCategory(category)).multiplier
            let host = host(category, 3)
            let row = HomeDockRowView()
            row.isLink = true
            row.value = "Set up a harness"
            host.addSubview(row)
            row.updateTraitsIfNeeded()
            let font = row.valueLabel.attributedText?.attribute(.font, at: 0, effectiveRange: nil) as? UIFont
            XCTAssertEqual(font?.pointSize ?? 0, 17 * m, accuracy: 0.0001, category.rawValue)
        }
    }

    // MARK: The new-session screen's labels

    func testMeasuredLabelSizesAreTheLabelsOwnAtEverySize() async {
        let cases: [(TextStyle, String, Int, NSTextAlignment)] = [
            (TextStyles.newSessionRow, "MacBook Pro", 1, .natural),
            (TextStyles.newSessionOfflineTitle, Strings.NewSession.machineOffline, 0, .natural),
            (TextStyles.newSessionOfflineBody, "Start the daemon on the computer with `happy daemon start`, then try again.", 0, .natural),
            (TextStyles.newSessionAgent, "claude code", 1, .natural),
            (TextStyles.newSessionOption, "~/projects/happy", 1, .natural),
            (TextStyles.newSessionOptionDetail, "2 hours ago", 1, .natural),
            (TextStyles.newSessionEmpty, Strings.NewSession.noResults, 0, .center),
            (TextStyles.newSessionMeta, "Resolves to /Users/someone/projects/happy/packages/happy-ios", 0, .natural),
            (TextStyles.newSessionSettingName, "Permission mode", 0, .natural),
            (TextStyles.newSessionPickerTitle, "Model", 1, .natural),
        ]
        for category in categories {
            for scale in scales {
                let at = "@\(scale)x \(category.rawValue)"
                let host = host(category, scale)
                let sizes = MeasuredLabelSizes()
                var landed = 0
                sizes.onChange = { landed += 1 }
                let labels = cases.map { label($0.0, $0.1, lines: $0.2, alignment: $0.3, in: host) }
                let widths: [CGFloat] = [120, 290, .greatestFiniteMagnitude]
                // Asked before anything is measured: one line, nothing
                // measured here.
                for (index, label) in labels.enumerated() {
                    for width in widths {
                        let guess = sizes.measurable(label).size(fitting: width)
                        XCTAssertEqual(guess.height, cases[index].0.oneLine(in: environment(category, scale)), "guess, \(at)")
                    }
                }
                while !sizes.isSettled { try? await Task.sleep(for: .milliseconds(5)) }
                XCTAssertEqual(landed, 1, "one pass, one layout, \(at)")
                for (index, label) in labels.enumerated() {
                    for width in widths {
                        let measured = sizes.measurable(label).size(fitting: width)
                        let own = size(label, width)
                        let message = "\(cases[index].1) at \(width), \(at)"
                        XCTAssertEqual(measured.height, own.height, message)
                        // A label's own width runs past a narrow width when
                        // it is cut short; the layouts clamp it.
                        XCTAssertEqual(min(measured.width, width), min(own.width, width), message)
                    }
                }
                XCTAssertEqual(sizes.passes, 1, at)
            }
        }
    }

    func testALabelThatDoesntFollowMeasuresItself() {
        let sizes = MeasuredLabelSizes()
        let label = StyledLabel(style: TextStyles.newSessionRow, color: Palette.text, lines: 1)
        label.string = "MacBook Pro"
        XCTAssertEqual(sizes.measurable(label).size(fitting: 200), size(label, 200))
        XCTAssertTrue(sizes.isSettled)
    }

    // MARK: The new-session prompt

    private func lines(_ count: Int) -> String {
        let tag = UUID().uuidString.prefix(8)
        return (1...count).map { "\(tag) line \($0)" }.joined(separator: "\n")
    }

    func testThePromptIsMeasuredAtTheTextSize() async {
        typealias M = NewSessionComposerLayout.Metrics
        let width: CGFloat = 369
        for category in categories {
            let m = TextScale(TextSizeCategory(category)).multiplier
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
            window.traitOverrides.followsTextSize = true
            window.traitOverrides.preferredContentSizeCategory = category
            let composer = NewSessionComposerView(frame: .zero)
            window.addSubview(composer)
            composer.updateTraitsIfNeeded()
            let scale = composer.layoutScale
            let line = (22 * m * scale).rounded(.up) / scale
            // Empty: one line at the size, at once.
            XCTAssertEqual(composer.layout(width: width).input.height, line, accuracy: 0.0001, category.rawValue)
            XCTAssertEqual(composer.textView.font?.pointSize ?? 0, 16 * m, accuracy: 0.0001)

            composer.setText(lines(2))
            // Not laid out yet, the composer starts measuring at its first
            // layout, as the screen's.
            _ = composer.layout(width: width)
            await composer.textMeasured()
            let input = composer.layout(width: width).input
            let twin = ComposerEditorGeometry.textKit1Twin(of: composer.textView)
            let needed = ComposerEditorGeometry.ownHeight(twin, width: input.width)
            XCTAssertEqual(input.height, min(M.inputMaxHeight, needed), category.rawValue)
            composer.frame = CGRect(x: 0, y: 0, width: width, height: composer.layout(width: width).size.height)
            composer.layoutIfNeeded()
            let layout = composer.layout(width: width)
            ComposerEditorGeometry.assertFits(
                composer.textView,
                measured: nil,
                frame: layout.input.height,
                minimum: line,
                cap: M.inputMaxHeight,
                scrolls: layout.textScrolls,
                host: window,
                "the prompt at \(category.rawValue)"
            )
            composer.removeFromSuperview()
        }
    }

    func testANewTextSizeMeasuresThePromptAgain() async {
        let width: CGFloat = 369
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.traitOverrides.followsTextSize = true
        window.traitOverrides.preferredContentSizeCategory = .large
        let composer = NewSessionComposerView(frame: .zero)
        window.addSubview(composer)
        composer.updateTraitsIfNeeded()
        composer.setText(lines(3))
        _ = composer.layout(width: width)
        await composer.textMeasured()
        let before = composer.layout(width: width).input.height
        var changes = 0
        composer.onHeightChange = { changes += 1 }
        window.traitOverrides.preferredContentSizeCategory = .accessibilityMedium
        window.updateTraitsIfNeeded()
        composer.updateTraitsIfNeeded()
        XCTAssertGreaterThanOrEqual(changes, 1, "the screen lays out again")
        _ = composer.layout(width: width)
        await composer.textMeasured()
        let after = composer.layout(width: width).input.height
        XCTAssertGreaterThan(after, before)
        XCTAssertEqual(composer.textView.font?.pointSize ?? 0, 16 * TextScale(.accessibilityMedium).multiplier, accuracy: 0.0001)
    }
}
#endif
