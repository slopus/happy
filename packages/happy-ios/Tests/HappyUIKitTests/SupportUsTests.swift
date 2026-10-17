#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class SupportUsTests: XCTestCase {
    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    func testOpeningWithoutPurchaseConfigurationShowsAnHonestUsablePage() async throws {
        var opened: [URL] = []
        let screen = SupportUsViewController(openURL: { opened.append($0); return true })
        screen.loadViewIfNeeded()
        screen.viewWillAppear(false)
        screen.viewDidAppear(false)
        await Task.yield()

        XCTAssertTrue(opened.isEmpty, "opening Support us must never open a purchase flow or store")
        XCTAssertNil(screen.presentedViewController)
        XCTAssertEqual(screen.title, Strings.SupportUs.title)
        let list = try XCTUnwrap(screen.view as? GroupedListView)
        let groups = list.sections.compactMap { $0 as? ItemGroupView }
        XCTAssertEqual(groups.count, 4)
        XCTAssertEqual(groups[0].footer, Strings.SupportUs.unavailable)
        XCTAssertEqual(groups[1].footer, Strings.SupportUs.statusUnavailable)

        for identifier in ["supportUs.subscribe", "supportUs.restore"] {
            let row = try XCTUnwrap(rows(list).first { $0.accessibilityIdentifier == identifier })
            XCTAssertFalse(row.isEnabled)
            XCTAssertNil(row.onTap)
            XCTAssertFalse(row.isUserInteractionEnabled)
            XCTAssertFalse(row.accessibilityTraits.contains(.button))
            XCTAssertEqual(row.detail, Strings.SupportUs.notAvailable)
            XCTAssertNotNil(row.accessibilityHint)
            row.sendActions(for: .touchUpInside)
        }
        XCTAssertNil(screen.presentedViewController, "unconfigured restore must not claim success or no purchases")
        XCTAssertTrue(opened.isEmpty)
    }

    func testManagementAndProjectLinksWorkWithoutPurchaseConfiguration() async throws {
        var opened: [URL] = []
        let screen = SupportUsViewController(openURL: { opened.append($0); return true })
        screen.loadViewIfNeeded()
        let list = try XCTUnwrap(screen.view as? GroupedListView)
        let manage = try XCTUnwrap(rows(list).first { $0.accessibilityIdentifier == "supportUs.manage" })
        XCTAssertTrue(manage.isEnabled)
        XCTAssertTrue(manage.accessibilityTraits.contains(.button))
        manage.sendActions(for: .touchUpInside)
        for _ in 0..<10 where opened.isEmpty { await Task.yield() }
        XCTAssertEqual(opened, [URL(string: "https://apps.apple.com/account/subscriptions")!])

        let project = try XCTUnwrap(rows(list).first { $0.accessibilityIdentifier == "supportUs.project" })
        project.sendActions(for: .touchUpInside)
        for _ in 0..<10 where opened.count < 2 { await Task.yield() }
        XCTAssertEqual(opened, [SupportUsViewController.manageSubscriptionsURL, Strings.Links.github])
    }

    func testSmallScreenScrollsAndGroupsUseMeasuredLayouts() throws {
        let screen = SupportUsViewController(openURL: { _ in true })
        screen.loadViewIfNeeded()
        let list = try XCTUnwrap(screen.view as? GroupedListView)
        list.frame = CGRect(x: 0, y: 0, width: 320, height: 480)
        list.layoutIfNeeded()
        XCTAssertGreaterThan(list.contentSize.height, list.bounds.height)

        var previousBottom: CGFloat = 0
        for section in list.sections {
            section.layoutIfNeeded()
            let group = try XCTUnwrap(section as? ItemGroupView)
            XCTAssertGreaterThanOrEqual(section.frame.minY, previousBottom)
            XCTAssertEqual(section.frame.height, group.layout(width: section.bounds.width).size.height)
            XCTAssertLessThanOrEqual(section.frame.maxX, list.bounds.width)
            previousBottom = section.frame.maxY
            for row in group.rows {
                row.layoutIfNeeded()
                XCTAssertGreaterThan(row.frame.height, 0)
                XCTAssertLessThanOrEqual(row.frame.maxX, group.card.bounds.width)
            }
        }
        XCTAssertGreaterThanOrEqual(list.contentSize.height, previousBottom)
    }

    func testLargeTextKeepsStatusReadableAndLinksReachable() throws {
        let screen = SupportUsViewController(openURL: { _ in true })
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 852))
        window.traitOverrides.preferredContentSizeCategory = .large
        window.rootViewController = UINavigationController(rootViewController: screen)
        window.isHidden = false
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        let list = try XCTUnwrap(screen.view as? GroupedListView)
        let normalHeight = list.contentSize.height

        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            window.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
                window.layer.render(in: context.cgContext)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = style == .light ? "Support us — light" : "Support us — dark"
            attachment.lifetime = .keepAlways
            add(attachment)
        }

        window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        window.updateTraitsIfNeeded()
        window.layoutIfNeeded()
        list.layoutIfNeeded()
        XCTAssertGreaterThan(list.contentSize.height, normalHeight)
        for group in list.sections.compactMap({ $0 as? ItemGroupView }) where group.footer != nil {
            group.layoutIfNeeded()
            let footer = group.footerLabel
            let measured = footer.sizeThatFits(CGSize(width: footer.bounds.width, height: .greatestFiniteMagnitude))
            XCTAssertGreaterThanOrEqual(footer.bounds.height, measured.height)
        }
        let last = try XCTUnwrap(list.sections.last)
        list.scrollRectToVisible(last.frame, animated: false)
        XCTAssertGreaterThan(list.contentOffset.y, 0, "legal/project links remain reachable at the largest text size")
    }

    private func rows(_ list: GroupedListView) -> [ItemRowView] {
        list.sections.compactMap { $0 as? ItemGroupView }.flatMap(\.rows).compactMap { $0 as? ItemRowView }
    }
}
#endif