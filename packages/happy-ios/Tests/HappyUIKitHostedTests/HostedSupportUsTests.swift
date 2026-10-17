#if canImport(UIKit)
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

@MainActor
final class HostedSupportUsTests: XCTestCase {
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
            XCTAssertEqual(row.subtitle, Strings.SupportUs.notAvailable)
            XCTAssertNotNil(row.accessibilityHint)
            row.sendActions(for: .touchUpInside)
        }
        XCTAssertNil(screen.presentedViewController, "unconfigured restore must not claim success or no purchases")
        XCTAssertTrue(opened.isEmpty)
    }

    func testManagementAndProjectLinksWorkWithoutPurchaseConfiguration() async throws {
        var opened: [URL] = []
        let screen = SupportUsViewController(openURL: { opened.append($0); return true })
        let scene = try await hostedActiveScene()
        let navigation = UINavigationController(rootViewController: screen)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: scene, root: navigation)
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        let list = try XCTUnwrap(screen.view as? GroupedListView)
        let manage = try XCTUnwrap(rows(list).first { $0.accessibilityIdentifier == "supportUs.manage" })
        XCTAssertTrue(manage.isEnabled)
        XCTAssertTrue(manage.accessibilityTraits.contains(.button))
        manage.sendActions(for: .touchUpInside)
        let manageDeadline = Date().addingTimeInterval(2)
        while opened.isEmpty && Date() < manageDeadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(opened, [URL(string: "https://apps.apple.com/account/subscriptions")!])

        let project = try XCTUnwrap(rows(list).first { $0.accessibilityIdentifier == "supportUs.project" })
        project.sendActions(for: .touchUpInside)
        let projectDeadline = Date().addingTimeInterval(2)
        while opened.count < 2 && Date() < projectDeadline { try await Task.sleep(for: .milliseconds(10)) }
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
            XCTAssertGreaterThanOrEqual(section.frame.minY + 0.001, previousBottom)
            XCTAssertEqual(section.frame.height, group.layout(width: section.bounds.width).size.height, accuracy: 1 / list.traitCollection.displayScale)
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

    func testLargeTextKeepsStatusReadableAndLinksReachable() async throws {
        let screen = SupportUsViewController(openURL: { _ in true })
        let scene = try await hostedActiveScene()
        let navigation = UINavigationController(rootViewController: screen)
        AppCoordinator.applyAppearance(to: navigation.navigationBar)
        let window = hostedKeyWindow(in: scene, root: navigation)
        window.traitOverrides.preferredContentSizeCategory = .large
        defer { window.isHidden = true }
        window.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(500))
        window.layoutIfNeeded()
        let list = try XCTUnwrap(screen.view as? GroupedListView)
        XCTAssertTrue(list.window === window)
        XCTAssertFalse(list.isHidden)
        XCTAssertGreaterThan(list.bounds.width, 0)
        XCTAssertGreaterThan(list.bounds.height, 0)
        let normalHeight = list.contentSize.height

        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
            attach(window, name: style == .light ? "Support us — light" : "Support us — dark")
        }

        window.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        window.updateTraitsIfNeeded()
        window.layoutIfNeeded()
        list.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        window.layoutIfNeeded()
        XCTAssertGreaterThan(list.contentSize.height, normalHeight)
        for row in rows(list) where row.onTap == nil && row.subtitle == Strings.SupportUs.notAvailable {
            XCTAssertFalse(row.isEnabled, "text/appearance changes must keep unconfigured actions unavailable")
            XCTAssertFalse(row.isUserInteractionEnabled)
            XCTAssertFalse(row.accessibilityTraits.contains(.button))
            XCTAssertEqual(row.titleLabel.color, Palette.textSecondary)
        }
        for row in rows(list) {
            row.layoutIfNeeded()
            XCTAssertEqual(row.titleLabel.numberOfLines, 0)
            XCTAssertEqual(row.subtitleLabel.numberOfLines, 0)
            for label in [row.titleLabel, row.subtitleLabel] where !label.isHidden {
                let measured = label.sizeThatFits(CGSize(width: label.bounds.width, height: .greatestFiniteMagnitude))
                XCTAssertGreaterThanOrEqual(label.bounds.height, measured.height)
            }
        }
        for group in list.sections.compactMap({ $0 as? ItemGroupView }) where group.footer != nil {
            group.layoutIfNeeded()
            let footer = group.footerLabel
            let measured = footer.sizeThatFits(CGSize(width: footer.bounds.width, height: .greatestFiniteMagnitude))
            XCTAssertGreaterThanOrEqual(footer.bounds.height, measured.height)
        }
        let last = try XCTUnwrap(list.sections.last)
        list.scrollRectToVisible(last.frame, animated: false)
        XCTAssertGreaterThan(list.contentOffset.y, 0, "legal/project links remain reachable at the largest text size")
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            list.contentOffset = .zero
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
            attach(window, name: style == .light ? "Support us — largest text light" : "Support us — largest text dark")
            list.scrollRectToVisible(last.frame, animated: false)
            window.layoutIfNeeded()
            attach(window, name: style == .light ? "Support us — largest text bottom light" : "Support us — largest text bottom dark")
        }
    }

    private func attach(_ window: UIWindow, name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            XCTAssertTrue(window.drawHierarchy(in: window.bounds, afterScreenUpdates: true))
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func rows(_ list: GroupedListView) -> [ItemRowView] {
        list.sections.compactMap { $0 as? ItemGroupView }.flatMap(\.rows).compactMap { $0 as? ItemRowView }
    }
}
#endif
