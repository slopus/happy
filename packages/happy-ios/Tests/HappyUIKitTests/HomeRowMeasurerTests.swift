#if canImport(UIKit)
import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The measurer against the views it stands in for: every heading cell
/// and the notices header, at phone widths and screen scales.
@MainActor
final class HomeRowMeasurerTests: XCTestCase {
    private let widths: [CGFloat] = [320, 393, 430]
    private let scales: [CGFloat] = [2, 3]

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    private func height(_ view: UIView, width: CGFloat, scale: CGFloat) -> CGFloat {
        view.traitOverrides.displayScale = scale
        view.updateTraitsIfNeeded()
        view.frame = CGRect(x: 0, y: 0, width: width, height: 100)
        view.layoutIfNeeded()
        return view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    }

    func testEveryHeadingMatchesItsCell() {
        for scale in scales {
            let environment = HomeTextEnvironment.current(scale: scale)
            for width in widths {
                func check(_ cell: UITableViewCell, _ kind: HomeRowKind, line: UInt = #line) {
                    XCTAssertEqual(
                        HomeRowMeasurer.height(kind, width: width, environment: environment),
                        height(cell, width: width, scale: scale),
                        accuracy: 0.001,
                        "\(kind) at \(width) @\(scale)x",
                        line: line
                    )
                }

                let day = SessionDayHeaderCell(style: .default, reuseIdentifier: nil)
                check(day, .dayHeader(label: ""))
                day.configure(.today)
                check(day, .dayHeader(label: Strings.SessionHistory.today))

                for banded in [true, false] {
                    let toggle = ArchiveToggleCell(style: .default, reuseIdentifier: nil)
                    toggle.banded = banded
                    toggle.configure(hidden: true)
                    check(toggle, .archiveToggle(label: Strings.Sidebar.showArchived, banded: banded))
                }

                let machine = ProjectMachineHeaderCell(style: .default, reuseIdentifier: nil)
                check(machine, .machineHeader(name: ""))
                machine.configure(name: "MacBook Pro")
                check(machine, .machineHeader(name: "MacBook Pro"))

                let section = ProjectSectionCell(style: .default, reuseIdentifier: nil)
                check(section, .section(label: ""))
                section.configure("Projects")
                check(section, .section(label: "Projects"))

                check(ProjectCardCell(style: .default, reuseIdentifier: nil), .projectCard)
                check(WorktreeCell(style: .default, reuseIdentifier: nil), .worktree)
                check(ProjectChatCell(style: .default, reuseIdentifier: nil), .chat)
            }
        }
    }

    func testTheNoticesMatchTheHeaderView() {
        let cases = [
            HomeBanners(offlineTitle: "All computers are offline"),
            HomeBanners(nativeUpdate: true),
            HomeBanners(whatsNew: true),
            HomeBanners(offlineTitle: "MacBook Pro is offline", whatsNew: true),
            HomeBanners(offlineTitle: "", nativeUpdate: true, whatsNew: true),
        ]
        for scale in scales {
            let environment = HomeTextEnvironment.current(scale: scale)
            for width in widths {
                for banners in cases {
                    let view = HomeListHeaderView()
                    view.offlineTitle = banners.offlineTitle
                    view.showsNativeUpdate = banners.nativeUpdate
                    view.showsWhatsNew = banners.whatsNew
                    XCTAssertEqual(
                        HomeRowMeasurer.headerHeight(banners, width: width, environment: environment),
                        height(view, width: width, scale: scale),
                        accuracy: 0.001,
                        "\(banners) at \(width) @\(scale)x"
                    )
                }
            }
            XCTAssertEqual(HomeRowMeasurer.headerHeight(HomeBanners(), width: 393, environment: environment), 0)
        }
    }

    func testTheNoticesComeInTheHeaderViewsOrder() {
        let all = HomeBanners(offlineTitle: "Offline", nativeUpdate: true, whatsNew: true)
        XCTAssertEqual(all.notices.map(\.subtitle), [Strings.Troubleshoot.bannerSubtitle, Strings.Home.tapToUpdateAppStore])
        XCTAssertEqual(HomeBanners(whatsNew: true).notices.map(\.title), [Strings.Home.whatsNew])
        XCTAssertTrue(HomeBanners().isEmpty)
    }

    func testAnEnvironmentIsItsFontsAndScale() {
        XCTAssertEqual(HomeTextEnvironment.current(scale: 3), HomeTextEnvironment.current(scale: 3))
        XCTAssertNotEqual(HomeTextEnvironment.current(scale: 2), HomeTextEnvironment.current(scale: 3))
        let environment = HomeTextEnvironment.current(scale: 3)
        XCTAssertEqual(environment.rows.dayHeaderLine, 18)
        XCTAssertEqual(environment.bannerTitleLine, 22)
        XCTAssertEqual(environment.rows.hairline, 1.0 / 3, accuracy: 0.0001)
    }

    /// The session list measures each heading as the text its cell is
    /// configured with, and leaves the constant rows to their layouts.
    func testTheSessionListMeasuresHeadingsAsItsCellsShowThem() {
        typealias List = SessionListViewController
        XCTAssertEqual(List.kind(.flat(.dayHeader(.today)), grouped: false), .dayHeader(label: Strings.SessionHistory.today))
        XCTAssertEqual(List.kind(.flat(.archiveToggle(hidden: true)), grouped: false), .archiveToggle(label: Strings.Sidebar.showArchived, banded: true))
        XCTAssertEqual(List.kind(.project(.archiveToggle(hidden: false)), grouped: true), .archiveToggle(label: Strings.Sidebar.hideArchived, banded: false))
        XCTAssertEqual(List.kind(.project(.archiveHeader(.daysAgo(3))), grouped: true), .section(label: Strings.SessionHistory.daysAgo(3)))
    }

    func testTheMeasurerRunsOffTheMainThread() async {
        let environment = HomeTextEnvironment.current(scale: 3)
        let height = await Task.detached {
            HomeRowMeasurer.headerHeight(HomeBanners(whatsNew: true), width: 393, environment: environment)
        }.value
        XCTAssertEqual(height, HomeRowMeasurer.headerHeight(HomeBanners(whatsNew: true), width: 393, environment: environment))
        XCTAssertGreaterThan(height, 0)
    }
}
#endif
