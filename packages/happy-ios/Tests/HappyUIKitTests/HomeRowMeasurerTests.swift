#if canImport(UIKit)
@testable import HappyCore
import HappyLayout
@testable import HappyUI
import UIKit
import XCTest

/// The measurer against the views it stands in for: every heading cell, a
/// session's row and the notices header, at phone widths and screen scales,
/// at the designed text size (`HomeListTextSizeTests` has the others).
@MainActor
final class HomeRowMeasurerTests: XCTestCase {
    private let widths: [CGFloat] = [320, 393, 430]
    private let scales: [CGFloat] = [2, 3]

    override func setUp() {
        super.setUp()
        Fonts.registerBundledFonts()
    }

    /// The environment at the designed text size, made off the main
    /// thread as the list makes it.
    private func environment(_ scale: CGFloat) async -> HomeTextEnvironment {
        await HomeTextEnvironment.make(TextEnvironment(scale: .standard, displayScale: scale))
    }

    private func height(_ view: UIView, width: CGFloat, scale: CGFloat) -> CGFloat {
        view.traitOverrides.displayScale = scale
        view.updateTraitsIfNeeded()
        view.frame = CGRect(x: 0, y: 0, width: width, height: 100)
        view.layoutIfNeeded()
        return view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    }

    func testEveryHeadingMatchesItsCell() async {
        for scale in scales {
            let environment = await self.environment(scale)
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

                for workspace in [nil, "fix-login"] {
                    for changes in [nil, Self.changes] {
                        let row = SessionRowCell(style: .default, reuseIdentifier: nil)
                        row.configure(Self.session(workspace: workspace, changes: changes), style: .gradient, monochrome: false)
                        check(row, .flatSession(workspace: workspace != nil, changes: changes != nil))
                    }
                }

                check(ProjectCardCell(style: .default, reuseIdentifier: nil), .projectCard)
                check(WorktreeCell(style: .default, reuseIdentifier: nil), .worktree)
                check(ProjectChatCell(style: .default, reuseIdentifier: nil), .chat)
            }
        }
    }

    func testTheNoticesMatchTheHeaderView() async {
        let cases = [
            HomeBanners(offlineTitle: "All computers are offline"),
            HomeBanners(nativeUpdate: true),
            HomeBanners(whatsNew: true),
            HomeBanners(offlineTitle: "MacBook Pro is offline", whatsNew: true),
            HomeBanners(offlineTitle: "", nativeUpdate: true, whatsNew: true),
        ]
        for scale in scales {
            let environment = await self.environment(scale)
            for width in widths {
                for banners in cases {
                    let view = HomeListHeaderView()
                    view.content = banners
                    XCTAssertEqual(
                        HomeRowMeasurer.headerHeight(banners, width: width, maxWidth: ContentWidth.maxWidth, environment: environment),
                        height(view, width: width, scale: scale),
                        accuracy: 0.001,
                        "\(banners) at \(width) @\(scale)x"
                    )
                }
            }
            XCTAssertEqual(HomeRowMeasurer.headerHeight(HomeBanners(), width: 393, maxWidth: ContentWidth.maxWidth, environment: environment), 0)
        }
    }

    func testTheNoticesComeInTheHeaderViewsOrder() {
        let all = HomeBanners(offlineTitle: "Offline", nativeUpdate: true, whatsNew: true)
        XCTAssertEqual(all.notices.map(\.subtitle), [Strings.Troubleshoot.bannerSubtitle, Strings.Home.tapToUpdateAppStore])
        XCTAssertEqual(HomeBanners(whatsNew: true).notices.map(\.title), [Strings.Home.whatsNew])
        XCTAssertTrue(HomeBanners().isEmpty)
    }

    func testAnEnvironmentIsItsFontsAndScale() async {
        let environment = await self.environment(3)
        let again = await self.environment(3)
        let twoX = await self.environment(2)
        XCTAssertEqual(environment, again)
        XCTAssertNotEqual(twoX, environment)
        XCTAssertEqual(environment.rows.dayHeaderLine, 18)
        XCTAssertEqual(environment.bannerTitleLine, 22)
        XCTAssertEqual(environment.rows.hairline, 1.0 / 3, accuracy: 0.0001)
        // The designed lines, but the counts' 14.3, which no style fixes,
        // up to a third (as HomeListTextSizeTests has it).
        XCTAssertEqual(environment.rows.sessionLines, .init(title: 22, project: 20, workspace: 18, changes: 43.0 / 3))
    }

    /// The session list measures each heading as the text its cell is
    /// configured with, and leaves the constant rows to their layouts.
    func testTheSessionListMeasuresHeadingsAsItsCellsShowThem() {
        typealias List = SessionListViewController
        XCTAssertEqual(List.kind(.flat(.dayHeader(.today)), grouped: false), .dayHeader(label: Strings.SessionHistory.today))
        XCTAssertEqual(List.kind(.flat(.archiveToggle(hidden: true)), grouped: false), .archiveToggle(label: Strings.Sidebar.showArchived, banded: true))
        XCTAssertEqual(List.kind(.project(.archiveToggle(hidden: false)), grouped: true), .archiveToggle(label: Strings.Sidebar.hideArchived, banded: false))
        XCTAssertEqual(List.kind(.project(.archiveHeader(.daysAgo(3))), grouped: true), .section(label: Strings.SessionHistory.daysAgo(3)))
        XCTAssertEqual(List.kind(.flat(.session(Self.session(workspace: "fix-login"))), grouped: false), .flatSession(workspace: true, changes: false))
        XCTAssertEqual(List.kind(.flat(.session(Self.session(workspace: nil))), grouped: false), .flatSession(workspace: false, changes: false))
        XCTAssertEqual(
            List.kind(.flat(.session(Self.session(workspace: nil, changes: Self.changes))), grouped: false),
            .flatSession(workspace: false, changes: true)
        )
    }

    /// The banners take their words on the main thread, where the screens'
    /// strings live; measuring them off it reads no strings and gives what
    /// it gives on the main thread.
    func testTheMeasurerRunsOffTheMainThread() async {
        let environment = await self.environment(3)
        let banners = HomeBanners(offlineTitle: "MacBook Pro is offline", whatsNew: true)
        let maxWidth = ContentWidth.maxWidth
        let height = await Task.detached {
            XCTAssertFalse(Thread.isMainThread)
            return HomeRowMeasurer.headerHeight(banners, width: 393, maxWidth: maxWidth, environment: environment)
        }.value
        XCTAssertEqual(height, HomeRowMeasurer.headerHeight(banners, width: 393, maxWidth: maxWidth, environment: environment))
        XCTAssertGreaterThan(height, 0)
    }

    /// "≈ +1.2k -7": every part of the counts.
    static let changes = GitLineChanges(approximate: true, insertions: 1234, deletions: 7)

    static func session(_ id: String = "s", workspace: String?, changes: GitLineChanges? = nil) -> SessionRow {
        SessionRow(
            id: id,
            title: "Fix the build",
            projectName: "happy",
            workspaceName: workspace,
            changes: changes,
            avatar: SessionAvatar(seed: id),
            timestamp: "12:55 PM",
            lastActivityAt: 0,
            state: .waiting,
            corner: .timestamp,
            shimmersTitle: false,
            faded: false,
            archived: false,
            isBot: false,
            showsDivider: true
        )
    }
}
#endif
