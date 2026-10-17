#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The person's text size on the screens that follow it, and nowhere else.
/// The factors and the cap are covered on Linux by TextScaleTests.
@MainActor
final class TextSizeTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private let largest = TextScale(.accessibilityExtraExtraExtraLarge).multiplier

    /// A view in a window, at `category`, following the text size or not.
    private func host(_ category: UIContentSizeCategory, follows: Bool) -> (UIWindow, UIView) {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        let host = UIView(frame: window.bounds)
        host.traitOverrides.preferredContentSizeCategory = category
        host.traitOverrides.followsTextSize = follows
        window.addSubview(host)
        return (window, host)
    }

    private func attach(_ view: UIView, to host: UIView) {
        host.addSubview(view)
        host.updateTraitsIfNeeded()
        view.updateTraitsIfNeeded()
        for subview in view.subviews { subview.updateTraitsIfNeeded() }
    }

    private func font(_ label: UILabel, at index: Int = 0) -> UIFont? {
        label.attributedText?.attribute(.font, at: index, effectiveRange: nil) as? UIFont
    }

    private func label(_ text: String = "Hello") -> StyledLabel {
        let label = StyledLabel(style: TextStyles.itemTitle, color: Palette.text)
        label.string = text
        return label
    }

    func testAScreenThatDoesNotFollowStaysAtTheDesignedSize() {
        let (window, host) = host(.accessibilityExtraExtraExtraLarge, follows: false)
        let label = label()
        attach(label, to: host)
        XCTAssertEqual(font(label)?.pointSize, 17)
        XCTAssertEqual(label.lineHeight, 22)
        XCTAssertEqual(label.renderedStyle, TextStyles.itemTitle)
        withExtendedLifetime(window) {}
    }

    func testAScreenThatFollowsDrawsAtTheTextSize() throws {
        let (window, host) = host(.accessibilityExtraExtraExtraLarge, follows: true)
        let label = label()
        attach(label, to: host)
        let font = try XCTUnwrap(font(label))
        XCTAssertEqual(font.pointSize, 17 * largest, accuracy: 0.0001)
        XCTAssertEqual(label.lineHeight, 22 * largest)
        XCTAssertEqual(label.attributedText?.attribute(.kern, at: 0, effectiveRange: nil) as? CGFloat, -0.41, "kern is not scaled")
        let fitted = label.sizeThatFits(CGSize(width: 1000, height: CGFloat.greatestFiniteMagnitude))
        XCTAssertEqual(fitted.height, (22 * largest).rounded(.up), accuracy: 1)
        withExtendedLifetime(window) {}
    }

    func testAChangedTextSizeDrawsAgain() {
        let (window, host) = host(.large, follows: true)
        let label = label()
        attach(label, to: host)
        XCTAssertEqual(font(label)?.pointSize, 17)
        host.traitOverrides.preferredContentSizeCategory = .extraExtraLarge
        attach(label, to: host)
        XCTAssertEqual(font(label)?.pointSize ?? 0, 17 * TextScale(.extraExtraLarge).multiplier, accuracy: 0.0001)
        host.traitOverrides.followsTextSize = false
        attach(label, to: host)
        XCTAssertEqual(font(label)?.pointSize, 17)
        withExtendedLifetime(window) {}
    }

    func testAViewControllerTurnsItOnForItsView() {
        let controller = UIViewController()
        controller.followsTextSize()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.rootViewController = controller
        window.isHidden = false
        controller.view.updateTraitsIfNeeded()
        XCTAssertTrue(controller.view.traitCollection[FollowsTextSize.self])
        XCTAssertFalse(UIView().traitCollection[FollowsTextSize.self], "off by default")
        window.isHidden = true
    }

    // MARK: Onboarding

    func testTheOnboardingTitleStopsAtItsCapAndTheRestGrows() throws {
        let (window, host) = host(.accessibilityExtraExtraExtraLarge, follows: true)
        let content = WelcomeContentView()
        attach(content, to: host)
        XCTAssertEqual(try XCTUnwrap(font(content.titleLabel)).pointSize, 28 * CGFloat(Float(1.2)), accuracy: 0.0001)
        XCTAssertEqual(content.titleLabel.lineHeight, 34 * CGFloat(Float(1.2)))
        let prop = try XCTUnwrap(content.propLabels.first)
        XCTAssertEqual(try XCTUnwrap(font(prop)).pointSize, 17 * largest, accuracy: 0.0001)
        // The wordmark is a picture: it keeps its height.
        XCTAssertEqual(content.layout(width: 345).wordmark.height, WordmarkMetrics.height)
        withExtendedLifetime(window) {}
    }

    func testTheLinkKeepsItsUnderlineAtEverySize() throws {
        let (window, host) = host(.large, follows: true)
        let content = LinkComputerContentView()
        attach(content, to: host)
        host.traitOverrides.preferredContentSizeCategory = .accessibilityMedium
        attach(content, to: host)
        let body = content.bodies[0]
        let text = try XCTUnwrap(body.attributedText)
        let range = (text.string as NSString).range(of: Strings.Onboarding.installBodyLink)
        XCTAssertNotEqual(range.location, NSNotFound)
        XCTAssertEqual(text.attribute(.underlineStyle, at: range.location, effectiveRange: nil) as? Int, NSUnderlineStyle.single.rawValue)
        XCTAssertEqual(try XCTUnwrap(font(body)).pointSize, 15 * TextScale(.accessibilityMedium).multiplier, accuracy: 0.0001)
        withExtendedLifetime(window) {}
    }

    /// The block reserves the taller screen's content, measured at the size
    /// it would be drawn at, as RN's hidden copies are.
    func testTheReservedContentIsMeasuredAtTheTextSize() {
        let (window, host) = host(.accessibilityExtraExtraExtraLarge, follows: true)
        let screen = OnboardingScreenView(
            content: WelcomeContentView(),
            primary: RoundButton(title: Strings.Onboarding.createAccount),
            secondary: RoundButton(title: Strings.Onboarding.restoreExisting, size: .normal, display: .inverted)
        )
        screen.frame = host.bounds
        attach(screen, to: host)
        let width = OnboardingLayout.blockWidth(size: screen.bounds.size, safeArea: LayoutInsets(screen.safeAreaInsets))
        let link = LinkComputerContentView()
        attach(link, to: host)
        let welcome = WelcomeContentView()
        attach(welcome, to: host)
        let tallest = max(link.sizeThatFits(CGSize(width: width, height: 0)).height, welcome.sizeThatFits(CGSize(width: width, height: 0)).height)
        XCTAssertEqual(screen.layout().content.height, tallest, accuracy: 0.5)
        withExtendedLifetime(window) {}
    }

    // MARK: Inputs

    func testTheServerFieldGrowsAndSoDoesItsLine() throws {
        let (window, host) = host(.accessibilityLarge, follows: true)
        let form = ServerFormView()
        attach(form, to: host)
        let scale = TextScale(.accessibilityLarge)
        XCTAssertEqual(try XCTUnwrap(form.field.font).pointSize, TextStyles.serverInput.size * scale.multiplier, accuracy: 0.0001)
        let designed = ServerFormView()
        XCTAssertGreaterThan(form.layout(width: 345).field.height, designed.layout(width: 345).field.height)
        withExtendedLifetime(window) {}
    }

    // MARK: Changelog

    func testWhatsNewFollowsTheTextSize() throws {
        let (window, host) = host(.extraExtraExtraLarge, follows: true)
        let plan = ChangelogPlan.make(
            .init(width: 393, text: host.traitCollection.measuredTextEnvironment, maxWidth: nil),
            entries: [Changelog.Entry(title: "1", summary: "Summary", markdown: "- one\n\nTwo")]
        )
        let paragraph = try XCTUnwrap(plan.entries.first?.texts.last?.string)
        let font = try XCTUnwrap(paragraph.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
        XCTAssertEqual(font.pointSize, TextStyles.changelogBody.size * TextScale(.extraExtraExtraLarge).multiplier, accuracy: 0.0001)
        withExtendedLifetime(window) {}
    }

    // MARK: Header titles

    /// react-native-screens' title: IBMPlexSans-SemiBold 17, a font and a
    /// colour, no line height, never scaled.
    func testUIKitsHeaderTitleIsReactNativeScreens() throws {
        let attributes = AppCoordinator.nativeTitleAttributes
        let font = try XCTUnwrap(attributes[.font] as? UIFont)
        XCTAssertEqual(font.pointSize, 17)
        XCTAssertEqual(font.fontName, "IBMPlexSans-SemiBold")
        XCTAssertNil(attributes[.paragraphStyle])
        XCTAssertNil(attributes[.baselineOffset])
        XCTAssertEqual(Set(attributes.keys), [.font, .foregroundColor])
        let bar = UINavigationBar()
        AppCoordinator.applyAppearance(to: bar)
        XCTAssertEqual((bar.standardAppearance.titleTextAttributes[.font] as? UIFont)?.pointSize, 17)
    }

    /// OnboardingHeader's and Header.tsx's titles scale in a header that
    /// keeps its height; the view is fitted again in the bar.
    func testATitleViewThatFollowsGrowsAndIsFittedAgain() throws {
        let (window, host) = host(.large, follows: false)
        let title = NavigationTitleView(title: "Settings", subtitle: "server.example")
        title.traitOverrides.followsTextSize = true
        attach(title, to: host)
        title.sizeToFit()
        let designed = title.frame.size
        XCTAssertEqual(font(title.titleLabel)?.pointSize, 16)

        host.traitOverrides.preferredContentSizeCategory = .accessibilityMedium
        attach(title, to: host)
        let scale = TextScale(.accessibilityMedium).multiplier
        XCTAssertEqual(try XCTUnwrap(font(title.titleLabel)).pointSize, 16 * scale, accuracy: 0.0001)
        XCTAssertEqual(try XCTUnwrap(font(title.subtitleLabel)).pointSize, 11 * scale, accuracy: 0.0001)
        XCTAssertGreaterThan(title.frame.height, designed.height)
        XCTAssertEqual(title.frame.size, title.layout(maxWidth: NavigationTitleView.defaultMaxWidth).size)
        withExtendedLifetime(window) {}
    }

    /// UIKit's own titles stay put: a title view that doesn't follow is
    /// never refitted.
    func testATitleViewThatDoesNotFollowStays() {
        let (window, host) = host(.large, follows: false)
        let title = NavigationTitleView(title: "Account")
        attach(title, to: host)
        title.sizeToFit()
        let designed = title.frame
        host.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        attach(title, to: host)
        XCTAssertEqual(font(title.titleLabel)?.pointSize, 16)
        XCTAssertEqual(title.frame, designed)
        withExtendedLifetime(window) {}
    }

    func testWhatsNewsTitleGrowsAndItsPictureDoesNot() throws {
        let (window, host) = host(.accessibilityLarge, follows: false)
        let title = ChangelogTitleView(title: "What's New")
        title.traitOverrides.followsTextSize = true
        attach(title, to: host)
        let scale = TextScale(.accessibilityLarge).multiplier
        XCTAssertEqual(try XCTUnwrap(font(title.label)).pointSize, TextStyles.changelogNavigationTitle.size * scale, accuracy: 0.0001)
        let layout = ChangelogTitleLayout(title: title.label.measurable, maxWidth: 240)
        XCTAssertEqual(layout.image.size, CGSize(width: 40, height: 40))
        withExtendedLifetime(window) {}
    }

    // MARK: Troubleshooting

    func testTerminalLinesFollowTheTextSize() throws {
        let (window, host) = host(.extraExtraExtraLarge, follows: true)
        let block = TerminalBlockView(lines: [.command("happy daemon start"), .comment("# a comment")])
        attach(block, to: host)
        for line in block.lines { line.updateTraitsIfNeeded() }
        let command = try XCTUnwrap(block.lines.first?.attributedText)
        let font = try XCTUnwrap(command.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
        XCTAssertEqual(font.pointSize, 14 * TextScale(.extraExtraExtraLarge).multiplier, accuracy: 0.0001)
        // Each UIColor(token) is a new dynamic colour, equal only to itself:
        // compare what it draws in each appearance.
        let prompt = try XCTUnwrap(command.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? UIColor)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            XCTAssertEqual(prompt.resolvedColor(with: traits), UIColor(Palette.terminalPrompt).resolvedColor(with: traits), "the prompt keeps its colour")
        }
        let commandColour = try XCTUnwrap(command.attribute(.foregroundColor, at: 2, effectiveRange: nil) as? UIColor)
        XCTAssertEqual(commandColour.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark)), UIColor(Palette.terminalText.dark))
        XCTAssertEqual(command.string, "$ happy daemon start")
        withExtendedLifetime(window) {}
    }

    func testTroubleshootingsLinkKeepsItsUnderline() throws {
        let (window, host) = host(.large, follows: true)
        let guide = TroubleshootGuideView()
        attach(guide, to: host)
        host.traitOverrides.preferredContentSizeCategory = .accessibilityMedium
        attach(guide, to: host)
        let body = guide.steps[1].body
        body.updateTraitsIfNeeded()
        let text = try XCTUnwrap(body.attributedText)
        let range = (text.string as NSString).range(of: Strings.Troubleshoot.desktopBodyLink)
        XCTAssertNotEqual(range.location, NSNotFound)
        XCTAssertEqual(text.attribute(.underlineStyle, at: range.location, effectiveRange: nil) as? Int, NSUnderlineStyle.single.rawValue)
        XCTAssertEqual(try XCTUnwrap(font(body)).pointSize, 15 * TextScale(.accessibilityMedium).multiplier, accuracy: 0.0001)
        withExtendedLifetime(window) {}
    }
}
#endif
