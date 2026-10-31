import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout
import XCTest

/// Home's rows as their plans lay them out (`HomeRowDrawing.make` and
/// `makeTablet`), at every text size on a 3x screen, from the smallest to
/// the largest accessibility size: every frame of every kind of row, the
/// phone's carded rows at 393 and the tablet's at 320, pinned to the pixel.
///
/// The lines come from the styles: a fixed line height grown with the
/// text, up to the next pixel, or for the styles without one the fonts'
/// lines in `fontLines`. `HomeRowLinesTests` (HappyUIKitTests) pins those
/// numbers and the glyph boxes to the fonts as the plans measure them, so
/// these are the rows as drawn. A changed frame prints every text size's
/// frames as they are now, to paste over `expected` once it is meant.
final class HomeRowPlanTextSizeTests: XCTestCase {
    /// The fonts' lines, in pixels, smallest text size first, as
    /// `HomeRowLinesTests.fontLines`.
    static let fontLines: [String: [Int]] = [
        "sessionLineChanges": [36, 38, 41, 43, 48, 53, 59, 77, 92, 114, 135, 154],
        "tabletArchivedSubtitle": [42, 45, 48, 51, 57, 63, 69, 91, 109, 135, 160, 182],
        "tabletArchivedTitle": [49, 52, 56, 59, 66, 73, 80, 105, 126, 155, 184, 209],
        "tabletChatTitle": [49, 52, 56, 59, 66, 73, 80, 105, 126, 155, 184, 209],
        "tabletMachineName": [36, 38, 41, 43, 48, 53, 59, 77, 92, 114, 135, 154],
    ]

    /// A title as the plans measure it, where that is not one line
    /// (`HomeRowLinesTests.measuredOff`).
    static let measuredOff: [String: [TextSizeCategory: Int]] = ["sessionTimestamp": [.large: 67]]

    /// The glyph boxes on a 3x screen (`HomeRowLinesTests.testTheGlyphBoxes`).
    static let branch = CGSize(width: 13, height: 40.0 / 3)
    static let draft = CGSize(width: 13, height: 40.0 / 3)
    static let machine = CGSize(width: 12, height: 37.0 / 3)
    static let tabletMachine = CGSize(width: 11, height: 34.0 / 3)
    static let chevron = CGSize(width: 13, height: 40.0 / 3)
    static let hairline: CGFloat = 1.0 / 3

    /// One line of `style` at `category`, as the plans measure a title.
    static func line(_ name: String, _ style: TextStyle, _ category: TextSizeCategory) -> CGFloat {
        if let off = measuredOff[name]?[category] { return CGFloat(off) / 3 }
        if let fixed = style.scaled(TextScale(category)).lineHeight { return (fixed * 3).rounded(.up) / 3 }
        let index = TextSizeCategory.allCases.firstIndex(of: category)!
        return CGFloat(fontLines[name]![index]) / 3
    }

    /// Text `natural` points wide on one line of `line`, wrapping onto at
    /// most `lines` lines (0: as many as it takes) where it is wider than
    /// it is given.
    static func text(_ natural: CGFloat, _ line: CGFloat, lines: Int = 1) -> Measurable {
        Measurable { width in
            guard natural > width, lines != 1 else { return CGSize(width: min(natural, width), height: line) }
            let needed = Int((natural / max(width, 1)).rounded(.up))
            return CGSize(width: width, height: line * CGFloat(lines == 0 ? needed : min(needed, lines)))
        }
    }

    /// Every row the plans draw at `category`, each laid out as its plan
    /// lays it out, by name.
    static func rows(_ category: TextSizeCategory) -> [(String, Any)] {
        func line(_ name: String, _ style: TextStyle) -> CGFloat { Self.line(name, style, category) }
        let sessionLines = FlatSessionRowLayout.Lines(
            title: line("sessionTitle", TextStyles.sessionTitle),
            project: line("sessionProject", TextStyles.sessionProject),
            workspace: line("sessionWorkspace", TextStyles.sessionWorkspace),
            changes: line("sessionLineChanges", TextStyles.sessionLineChanges)
        )
        let changesLine = sessionLines.changes
        // "≈ +1.2k -7", in the flat rows' counts and in the cards'.
        let flatChanges = GitChangesLayout(approximate: CGSize(width: 8, height: changesLine), added: CGSize(width: 36, height: changesLine), removed: CGSize(width: 16, height: changesLine)).size
        let countLine = line("gitLineCount", TextStyles.gitLineCount)
        let cardChanges = GitChangesLayout(approximate: CGSize(width: 8, height: line("gitApproximate", TextStyles.gitApproximate)), added: CGSize(width: 38, height: countLine), removed: CGSize(width: 18, height: countLine)).size
        let phone = HomeCardLayout.contentWidth(393)
        func session(width: CGFloat, avatar: CGFloat, workspace: Bool, changes: Bool, draft: Bool, divider: Bool) -> FlatSessionRowLayout {
            FlatSessionRowLayout(.init(
                width: width,
                title: text(400, sessionLines.title),
                timestamp: text(60, line("sessionTimestamp", TextStyles.sessionTimestamp)),
                project: text(80, sessionLines.project),
                workspace: workspace ? text(70, sessionLines.workspace) : nil,
                branchIcon: branch,
                changes: changes ? flatChanges : nil,
                draftIcon: draft ? Self.draft : nil,
                showsDivider: divider,
                lines: sessionLines,
                avatarSize: avatar
            ))
        }
        let archiveLabel = text(110, line("archiveToggle", TextStyles.archiveToggle))
        return [
            ("phone.session", session(width: phone, avatar: HomeCardLayout.Metrics.sessionAvatar, workspace: false, changes: false, draft: false, divider: false)),
            ("phone.session.workspace", session(width: phone, avatar: HomeCardLayout.Metrics.sessionAvatar, workspace: true, changes: false, draft: false, divider: false)),
            ("phone.session.changes", session(width: phone, avatar: HomeCardLayout.Metrics.sessionAvatar, workspace: false, changes: true, draft: false, divider: false)),
            ("phone.session.all", session(width: phone, avatar: HomeCardLayout.Metrics.sessionAvatar, workspace: true, changes: true, draft: true, divider: false)),
            ("phone.archiveToggle.banded", ArchiveToggleLayout(width: 393, label: archiveLabel)),
            ("phone.archiveToggle", ArchiveToggleLayout(width: 393, label: archiveLabel, paddingTop: ArchiveToggleLayout.unbanded.top, paddingBottom: ArchiveToggleLayout.unbanded.bottom)),
            ("phone.machine", MachineHeaderLayout(width: 393, icon: machine, name: text(90, line("projectMachine", TextStyles.projectMachine)))),
            ("phone.project", ProjectCardLayout(.init(width: phone, hairline: hairline, name: text(120, line("projectName", TextStyles.projectName)), showsDot: true, changes: .fixed(cardChanges), showsAdd: true, showsTree: true))),
            ("phone.worktree", WorktreeRowLayout(.init(width: phone, hairline: hairline, label: text(90, line("worktreeName", TextStyles.worktreeName)), showsDot: true, changes: .fixed(cardChanges), last: false))),
            ("phone.worktreeToggle", WorktreeRowLayout(.init(width: phone, hairline: hairline, label: text(140, line("worktreeToggle", TextStyles.worktreeToggle)), chevron: branch, showsDot: false, changes: nil, last: true))),
            ("phone.chat", ProjectChatRowLayout(width: phone, name: text(150, line("projectName", TextStyles.projectName)), corner: text(50, line("projectTimestamp", TextStyles.projectTimestamp)))),
            ("tablet.bot", session(width: 320, avatar: FlatSessionRowLayout.Metrics.avatarSize, workspace: true, changes: true, draft: true, divider: true)),
            ("tablet.section", TabletSectionHeaderLayout(width: 320, label: text(40, line("sessionDayHeader", TextStyles.sessionDayHeader)))),
            ("tablet.machine", TabletMachineRuleLayout(width: 320, hairline: hairline, icon: tabletMachine, name: text(90, line("tabletMachineName", TextStyles.tabletMachineName)))),
            ("tablet.workspace", TabletWorkspaceHeaderLayout(.init(width: 320, title: text(60, line("tabletWorkspaceTitle", TextStyles.tabletWorkspaceTitle)), branch: text(80, line("tabletWorkspaceBranch", TextStyles.tabletWorkspaceBranch)), changes: cardChanges))),
            ("tablet.chat", TabletChatRowLayout(.init(width: 320, hairline: hairline, title: text(500, line("tabletChatTitle", TextStyles.tabletChatTitle), lines: 2), first: true, last: false, projectEnd: false, showsBorder: true))),
            ("tablet.archived", TabletArchivedRowLayout(.init(width: 320, hairline: hairline, title: text(150, line("tabletArchivedTitle", TextStyles.tabletArchivedTitle)), subtitle: text(120, line("tabletArchivedSubtitle", TextStyles.tabletArchivedSubtitle)), subtitleRow: true, subtitleIcon: CGSize(width: 13, height: 13), status: text(150, line("tabletArchivedStatus", TextStyles.tabletArchivedStatus), lines: 0), last: true))),
        ]
    }

    /// A layout's frames, sizes and flags in its own order, in pixels on a
    /// 3x screen: a frame as x,y,width,height, a size as width x height,
    /// an absent frame as -.
    static func describe(_ layout: Any) -> String {
        func pixels(_ value: CGFloat) -> String {
            let pixels = Double(value * 3)
            return pixels == pixels.rounded() ? String(Int(pixels.rounded())) : String(pixels)
        }
        func format(_ value: Any) -> String {
            let mirror = Mirror(reflecting: value)
            if mirror.displayStyle == .optional {
                guard let inner = mirror.children.first?.value else { return "-" }
                return format(inner)
            }
            switch value {
            case let rect as CGRect: return [rect.minX, rect.minY, rect.width, rect.height].map(pixels).joined(separator: ",")
            case let size as CGSize: return pixels(size.width) + "x" + pixels(size.height)
            case let number as CGFloat: return pixels(number)
            case let flag as Bool: return String(flag)
            default: return String(describing: value)
            }
        }
        return Mirror(reflecting: layout).children.compactMap { child in
            child.label.map { "\($0) \(format(child.value))" }
        }.joined(separator: " ")
    }

    static func describe(_ category: TextSizeCategory) -> String {
        rows(category).map { "\($0.0): \(describe($0.1))" }.joined(separator: "\n")
    }

    /// A row's size and frames, by name, an absent frame left out.
    static func geometry(_ layout: Any) -> (size: CGSize, frames: [(String, CGRect)]) {
        var size = CGSize.zero
        var frames: [(String, CGRect)] = []
        for child in Mirror(reflecting: layout).children {
            var value = child.value
            let mirror = Mirror(reflecting: value)
            if mirror.displayStyle == .optional {
                guard let inner = mirror.children.first?.value else { continue }
                value = inner
            }
            if let found = value as? CGSize, child.label == "size" { size = found }
            if let frame = value as? CGRect, let label = child.label { frames.append((label, frame)) }
        }
        return (size, frames)
    }

    /// The rows that keep their designed height up to the designed text
    /// size, where their text fits with room around it, and grow past it.
    /// The rest follow their text at every size.
    static let designedUpToLarge: Set<String> = [
        "phone.project", "phone.worktree", "phone.worktreeToggle", "phone.chat", "tablet.chat", "tablet.archived",
    ]

    /// Frames drawn past their row on purpose: a tablet chat's card runs on
    /// under the next chat, which draws over it.
    static let overhanging: Set<String> = ["tablet.chat.card"]

    /// From the smallest text size to the largest, every row grows with its
    /// text and holds every line of it, nothing running past its top or
    /// bottom. A draft never moves a height.
    func testTheRowsGrowWithTheirTextAndHoldIt() {
        let designed = Dictionary(uniqueKeysWithValues: Self.rows(.large).map { ($0.0, Self.geometry($0.1).size) })
        var previous: [String: CGFloat] = [:]
        var upToLarge = true
        for category in TextSizeCategory.allCases {
            defer { if category == .large { upToLarge = false } }
            let rows = Self.rows(category)
            XCTAssertEqual(Set(rows.map(\.0)).count, rows.count)
            for (name, layout) in rows {
                let (size, frames) = Self.geometry(layout)
                XCTAssertEqual(size.width, name.hasPrefix("tablet") ? 320 : name.hasPrefix("phone.archiveToggle") || name == "phone.machine" ? 393 : HomeCardLayout.contentWidth(393), "\(name) at \(category)")
                if Self.designedUpToLarge.contains(name), upToLarge {
                    XCTAssertEqual(size, designed[name], "\(name) at \(category) left its designed height")
                }
                XCTAssertGreaterThanOrEqual(size.height, previous[name] ?? 0, "\(name) at \(category) shrank")
                previous[name] = size.height
                for (label, frame) in frames where !Self.overhanging.contains("\(name).\(label)") {
                    XCTAssertGreaterThanOrEqual(frame.minY, -0.001, "\(name).\(label) at \(category) runs over the row")
                    XCTAssertLessThanOrEqual(frame.maxY, size.height + 0.001, "\(name).\(label) at \(category) runs under the row")
                }
            }
            let row = Dictionary(uniqueKeysWithValues: rows.map { ($0.0, Self.geometry($0.1).size.height) })
            XCTAssertEqual(row["phone.session.all"], row["phone.session.workspace"].map { max($0, row["phone.session.changes"] ?? 0) }, "\(category): a draft moved the row")
        }
        // At the largest size every row is past its designed height.
        for (name, size) in designed {
            XCTAssertGreaterThan(previous[name] ?? 0, size.height, "\(name) kept its designed height at the largest size")
        }
    }

    // MARK: Pinned frames

    func testEveryRowsFramesAtEveryTextSize() {
        var changed: [TextSizeCategory] = []
        for category in TextSizeCategory.allCases {
            let actual = Self.describe(category)
            guard let expected = Self.expected[category] else {
                changed.append(category)
                continue
            }
            let lines = zip(actual.split(separator: "\n"), expected.split(separator: "\n"))
            for (now, pinned) in lines where now != pinned {
                XCTFail("\(category):\n  now    \(now)\n  pinned \(pinned)")
            }
            if actual.split(separator: "\n").count != expected.split(separator: "\n").count { XCTFail("\(category): other rows") }
            if actual != expected { changed.append(category) }
        }
        guard !changed.isEmpty else { return }
        let listed = TextSizeCategory.allCases.map { category in
            "        .\(category): \"\"\"\n" + Self.describe(category).split(separator: "\n").map { "        \($0)" }.joined(separator: "\n") + "\n        \"\"\","
        }.joined(separator: "\n")
        XCTFail("the rows' frames at \(changed); every text size's now:\n    static let expected: [TextSizeCategory: String] = [\n\(listed)\n    ]")
    }

    /// The rows' frames at each text size. At the accessibility sizes the
    /// rows designed at a fixed height (a project, a worktree, a chat, the
    /// tablet's chats and archived cards) grow to hold their text, where
    /// RN's keep their height and let it run past.
    static let expected: [TextSizeCategory: String] = [
        .extraSmall: """
        phone.session: size 1083x233 avatar 48,56.50000000000001,120,120 title 204,35.5,627,55 timestamp 855,35.5,180,55 dot 975,33,60,60 project 204,96,831,50 workspace - branchIcon - changes - draftIcon - divider -
        phone.session.workspace: size 1083x233 avatar 48,56.50000000000001,120,120 title 204,35.5,627,55 timestamp 855,35.5,180,55 dot 975,33,60,60 project 204,96,831,50 workspace 204,153.5,210,45 branchIcon 426,156.00000000000003,39,40 changes - draftIcon - divider -
        phone.session.changes: size 1083x233 avatar 48,56.50000000000001,120,120 title 204,35.5,627,55 timestamp 855,35.5,180,55 dot 975,33,60,60 project 204,96,831,50 workspace - branchIcon - changes 831,158,204,36 draftIcon - divider -
        phone.session.all: size 1083x233 avatar 48,56.50000000000001,120,120 title 204,35.5,627,55 timestamp 855,35.5,180,55 dot 975,33,60,60 project 204,96,831,50 workspace 204,153.5,210,45 branchIcon 426,156.00000000000003,39,40 changes 831,158,204,36 draftIcon 768,156.00000000000003,39,40 divider -
        phone.archiveToggle.banded: size 1179x141 label 424.5,72,330,45 leadingLine 72,94.005,316.5,0.99 trailingLine 790.5,94.005,316.5,0.99
        phone.archiveToggle: size 1179x141 label 424.5,60,330,45 leadingLine 72,82.005,316.5,0.99 trailingLine 790.5,82.005,316.5,0.99
        phone.machine: size 1179x121 icon 96,60,36,37 name 150,61.00000000000001,270,35
        phone.project: size 1083x156 avatar 48,36,84,84 stem 89,120,2,36 name 168,50.50000000000001,474,55 dot 666,67.5,21,21 changes 711,55.5,216,45 add 951,30,84,96
        phone.worktree: size 1083x144 trunk 89,0,2,144 elbow 90,71,42,2 chevron - label 168,46,582,52 dot 774,61.5,21,21 changes 819,49.5,216,45
        phone.worktreeToggle: size 1083x144 trunk 89,0,2,72 elbow 90,71,42,2 chevron 168,52,39,40 label 222,47,420,50 dot - changes -
        phone.chat: size 1083x144 avatar 48,30,84,84 name 168,44.5,693,55 corner 885,49.5,150,45
        tablet.bot: size 960x240 avatar 48,30,180,180 title 264,38.99999999999999,444,55 timestamp 732,38.99999999999999,180,55 dot 852,36.49999999999999,60,60 project 264,99.5,648,50 workspace 264,157,210,45 branchIcon 486,159.5,39,40 changes 708,161.5,204,36 draftIcon 645,159.5,39,40 divider 264,239.01,696,0.99
        tablet.section: size 960x129 label 72,60,816,45
        tablet.machine: size 960x60 leadingLine 96,41.5,208.5,1 icon 322.5,24.999999999999996,33,34 name 373.5,24,270,36 trailingLine 655.5,41.5,208.5,1
        tablet.workspace: size 960x144 avatar 60,36,90,90 title 174,36,594,45 branch 174,83.5,240,40 changes 432,81,216,45 addButton 792,36,90,90 addIcon 810,54,54,54
        tablet.chat: size 960x169 card 48,0,864,224 row 49,1,862,168 title 96.99999999999999,36,688,98 indicator 808.9999999999999,58,54,54 dot 826.9999999999999,76,18,18 divider 49,168,862,1
        tablet.archived: size 960x302 card 48,0,864,266 row 49,1,862,264 avatar 96.99999999999999,61.00000000000001,144,144 draftOverlay 193,157.00000000000003,54,54 title 289,51.500000000000014,574.0000000000001,49 subtitle 340,106.5,360,42 subtitleIcon 289,108,39,39 dot 289,181.5,18,18 status 319,167.5,544,40
        """,
        .small: """
        phone.session: size 1083x236 avatar 48,58.00000000000001,120,120 title 204,33.5,627,59 timestamp 855,33.5,180,59 dot 975,33,60,60 project 204,96,831,53 workspace - branchIcon - changes - draftIcon - divider -
        phone.session.workspace: size 1083x236 avatar 48,58.00000000000001,120,120 title 204,33.5,627,59 timestamp 855,33.5,180,59 dot 975,33,60,60 project 204,96,831,53 workspace 204,155,210,48 branchIcon 426,159.00000000000003,39,40 changes - draftIcon - divider -
        phone.session.changes: size 1083x236 avatar 48,58.00000000000001,120,120 title 204,33.5,627,59 timestamp 855,33.5,180,59 dot 975,33,60,60 project 204,96,831,53 workspace - branchIcon - changes 831,160,204,38 draftIcon - divider -
        phone.session.all: size 1083x236 avatar 48,58.00000000000001,120,120 title 204,33.5,627,59 timestamp 855,33.5,180,59 dot 975,33,60,60 project 204,96,831,53 workspace 204,155,210,48 branchIcon 426,159.00000000000003,39,40 changes 831,160,204,38 draftIcon 768,159.00000000000003,39,40 divider -
        phone.archiveToggle.banded: size 1179x144 label 424.5,72,330,48 leadingLine 72,95.505,316.5,0.99 trailingLine 790.5,95.505,316.5,0.99
        phone.archiveToggle: size 1179x144 label 424.5,60,330,48 leadingLine 72,83.505,316.5,0.99 trailingLine 790.5,83.505,316.5,0.99
        phone.machine: size 1179x122 icon 96,60.49999999999999,36,37 name 150,60,270,38
        phone.project: size 1083x156 avatar 48,36,84,84 stem 89,120,2,36 name 168,48.49999999999999,474,59 dot 666,67.5,21,21 changes 711,54,216,48 add 951,30,84,96
        phone.worktree: size 1083x144 trunk 89,0,2,144 elbow 90,71,42,2 chevron - label 168,44,582,56 dot 774,61.5,21,21 changes 819,48,216,48
        phone.worktreeToggle: size 1083x144 trunk 89,0,2,72 elbow 90,71,42,2 chevron 168,52,39,40 label 222,45.5,420,53 dot - changes -
        phone.chat: size 1083x144 avatar 48,30,84,84 name 168,42.5,693,59 corner 885,48,150,48
        tablet.bot: size 960x240 avatar 48,30,180,180 title 264,35.49999999999999,444,59 timestamp 732,35.49999999999999,180,59 dot 852,34.99999999999999,60,60 project 264,98,648,53 workspace 264,157,210,48 branchIcon 486,161,39,40 changes 708,161.99999999999997,204,38 draftIcon 645,161,39,40 divider 264,239.01,696,0.99
        tablet.section: size 960x132 label 72,60,816,48
        tablet.machine: size 960x61.99999999999999 leadingLine 96,42.5,208.5,1 icon 322.5,25.999999999999993,33,34 name 373.5,23.999999999999996,270,38 trailingLine 655.5,42.5,208.5,1
        tablet.workspace: size 960x150 avatar 60,39,90,90 title 174,36,594,48 branch 174,86.5,240,43 changes 432,84,216,48 addButton 792,39,90,90 addIcon 810,57,54,54
        tablet.chat: size 960x169 card 48,0,864,224 row 49,1,862,168 title 96.99999999999999,33,688,104 indicator 808.9999999999999,58,54,54 dot 826.9999999999999,76,18,18 divider 49,168,862,1
        tablet.archived: size 960x302 card 48,0,864,266 row 49,1,862,264 avatar 96.99999999999999,61.00000000000001,144,144 draftOverlay 193,157.00000000000003,54,54 title 289,48.500000000000014,574.0000000000001,52 subtitle 340,106.5,360,45 subtitleIcon 289,109.5,39,39 dot 289,184.5,18,18 status 319,169,544,43
        """,
        .medium: """
        phone.session: size 1083x240 avatar 48,60,120,120 title 204,31.5,627,63 timestamp 855,31.5,180,63 dot 975,33,60,60 project 204,96,831,57 workspace - branchIcon - changes - draftIcon - divider -
        phone.session.workspace: size 1083x240 avatar 48,60,120,120 title 204,31.5,627,63 timestamp 855,31.5,180,63 dot 975,33,60,60 project 204,96,831,57 workspace 204,157.5,210,51 branchIcon 426,163,39,40 changes - draftIcon - divider -
        phone.session.changes: size 1083x240 avatar 48,60,120,120 title 204,31.5,627,63 timestamp 855,31.5,180,63 dot 975,33,60,60 project 204,96,831,57 workspace - branchIcon - changes 831,162.5,204,41 draftIcon - divider -
        phone.session.all: size 1083x240 avatar 48,60,120,120 title 204,31.5,627,63 timestamp 855,31.5,180,63 dot 975,33,60,60 project 204,96,831,57 workspace 204,157.5,210,51 branchIcon 426,163,39,40 changes 831,162.5,204,41 draftIcon 768,163,39,40 divider -
        phone.archiveToggle.banded: size 1179x147 label 424.5,72,330,51 leadingLine 72,97.005,316.5,0.99 trailingLine 790.5,97.005,316.5,0.99
        phone.archiveToggle: size 1179x147 label 424.5,60,330,51 leadingLine 72,85.005,316.5,0.99 trailingLine 790.5,85.005,316.5,0.99
        phone.machine: size 1179x124 icon 96,61.5,36,37 name 150,60,270,40
        phone.project: size 1083x156 avatar 48,36,84,84 stem 89,120,2,36 name 168,46.5,474,63 dot 666,67.5,21,21 changes 711,52.5,216,51 add 951,30,84,96
        phone.worktree: size 1083x144 trunk 89,0,2,144 elbow 90,71,42,2 chevron - label 168,42,582,60 dot 774,61.5,21,21 changes 819,46.5,216,51
        phone.worktreeToggle: size 1083x144 trunk 89,0,2,72 elbow 90,71,42,2 chevron 168,52,39,40 label 222,43.5,420,57 dot - changes -
        phone.chat: size 1083x144 avatar 48,30,84,84 name 168,40.5,693,63 corner 885,46.5,150,51
        tablet.bot: size 960x240 avatar 48,30,180,180 title 264,31.5,444,63 timestamp 732,31.5,180,63 dot 852,33,60,60 project 264,96,648,57 workspace 264,157.5,210,51 branchIcon 486,163,39,40 changes 708,162.5,204,41 draftIcon 645,163,39,40 divider 264,239.01,696,0.99
        tablet.section: size 960x135 label 72,60,816,51
        tablet.machine: size 960x65 leadingLine 96,44,208.5,1 icon 322.5,27.499999999999993,33,34 name 373.5,23.999999999999996,270,41 trailingLine 655.5,44,208.5,1
        tablet.workspace: size 960x156 avatar 60,42,90,90 title 174,36,594,51 branch 174,89.5,240,46 changes 432,87,216,51 addButton 792,42,90,90 addIcon 810,60,54,54
        tablet.chat: size 960x169 card 48,0,864,224 row 49,1,862,168 title 96.99999999999999,28.999999999999993,688,112 indicator 808.9999999999999,58,54,54 dot 826.9999999999999,76,18,18 divider 49,168,862,1
        tablet.archived: size 960x302 card 48,0,864,266 row 49,1,862,264 avatar 96.99999999999999,61.00000000000001,144,144 draftOverlay 193,157.00000000000003,54,54 title 289,45,574.0000000000001,56 subtitle 340,107.00000000000001,360,48 subtitleIcon 289,111.50000000000001,39,39 dot 289,188,18,18 status 319,171.00000000000003,544,46
        """,
        .large: """
        phone.session: size 1083x243 avatar 48,61.5,120,120 title 204,30,627,66 timestamp 855,29.5,180,67 dot 975,33,60,60 project 204,96,831,60 workspace - branchIcon - changes - draftIcon - divider -
        phone.session.workspace: size 1083x243 avatar 48,61.5,120,120 title 204,30,627,66 timestamp 855,29.5,180,67 dot 975,33,60,60 project 204,96,831,60 workspace 204,159,210,54 branchIcon 426,166,39,40 changes - draftIcon - divider -
        phone.session.changes: size 1083x243 avatar 48,61.5,120,120 title 204,30,627,66 timestamp 855,29.5,180,67 dot 975,33,60,60 project 204,96,831,60 workspace - branchIcon - changes 831,164.5,204,43 draftIcon - divider -
        phone.session.all: size 1083x243 avatar 48,61.5,120,120 title 204,30,627,66 timestamp 855,29.5,180,67 dot 975,33,60,60 project 204,96,831,60 workspace 204,159,210,54 branchIcon 426,166,39,40 changes 831,164.5,204,43 draftIcon 768,166,39,40 divider -
        phone.archiveToggle.banded: size 1179x150 label 424.5,72,330,54 leadingLine 72,98.505,316.5,0.99 trailingLine 790.5,98.505,316.5,0.99
        phone.archiveToggle: size 1179x150 label 424.5,60,330,54 leadingLine 72,86.505,316.5,0.99 trailingLine 790.5,86.505,316.5,0.99
        phone.machine: size 1179x126 icon 96,62.5,36,37 name 150,60,270,42
        phone.project: size 1083x156 avatar 48,36,84,84 stem 89,120,2,36 name 168,45,474,66 dot 666,67.5,21,21 changes 711,51,216,54 add 951,30,84,96
        phone.worktree: size 1083x144 trunk 89,0,2,144 elbow 90,71,42,2 chevron - label 168,40.5,582,63 dot 774,61.5,21,21 changes 819,45,216,54
        phone.worktreeToggle: size 1083x144 trunk 89,0,2,72 elbow 90,71,42,2 chevron 168,52,39,40 label 222,42,420,60 dot - changes -
        phone.chat: size 1083x144 avatar 48,30,84,84 name 168,39,693,66 corner 885,45,150,54
        tablet.bot: size 960x243 avatar 48,31.5,180,180 title 264,30,444,66 timestamp 732,29.5,180,67 dot 852,33,60,60 project 264,96,648,60 workspace 264,159,210,54 branchIcon 486,166,39,40 changes 708,164.5,204,43 draftIcon 645,166,39,40 divider 264,242.01,696,0.99
        tablet.section: size 960x138 label 72,60,816,54
        tablet.machine: size 960x67 leadingLine 96,45.00000000000001,208.5,1 icon 322.5,28.5,33,34 name 373.5,24,270,43 trailingLine 655.5,45.00000000000001,208.5,1
        tablet.workspace: size 960x162 avatar 60,45,90,90 title 174,36,594,54 branch 174,93,240,48 changes 432,90,216,54 addButton 792,45,90,90 addIcon 810,63,54,54
        tablet.chat: size 960x169 card 48,0,864,224 row 49,1,862,168 title 96.99999999999999,25.999999999999993,688,118 indicator 808.9999999999999,58,54,54 dot 826.9999999999999,76,18,18 divider 49,168,862,1
        tablet.archived: size 960x302 card 48,0,864,266 row 49,1,862,264 avatar 96.99999999999999,61.00000000000001,144,144 draftOverlay 193,157.00000000000003,54,54 title 289,42,574.0000000000001,59 subtitle 340,107.00000000000001,360,51 subtitleIcon 289,113.00000000000001,39,39 dot 289,191,18,18 status 319,173,544,48
        """,
        .extraLarge: """
        phone.session: size 1083x259 avatar 48,69.50000000000001,120,120 title 204,30,627,74 timestamp 855,30,180,74 dot 975,37,60,60 project 204,104.00000000000001,831,68 workspace - branchIcon - changes - draftIcon - divider -
        phone.session.workspace: size 1083x266 avatar 48,73,120,120 title 204,30,627,74 timestamp 855,30,180,74 dot 975,37,60,60 project 204,104.00000000000001,831,68 workspace 204,175.00000000000003,210,61 branchIcon 426,185.50000000000003,39,40 changes - draftIcon - divider -
        phone.session.changes: size 1083x259 avatar 48,69.50000000000001,120,120 title 204,30,627,74 timestamp 855,30,180,74 dot 975,37,60,60 project 204,104.00000000000001,831,68 workspace - branchIcon - changes 831,178.00000000000003,204,48 draftIcon - divider -
        phone.session.all: size 1083x266 avatar 48,73,120,120 title 204,30,627,74 timestamp 855,30,180,74 dot 975,37,60,60 project 204,104.00000000000001,831,68 workspace 204,175.00000000000003,210,61 branchIcon 426,185.50000000000003,39,40 changes 831,181.50000000000003,204,48 draftIcon 768,185.50000000000003,39,40 divider -
        phone.archiveToggle.banded: size 1179x157 label 424.5,72,330,61 leadingLine 72,102.005,316.5,0.99 trailingLine 790.5,102.005,316.5,0.99
        phone.archiveToggle: size 1179x157 label 424.5,60,330,61 leadingLine 72,90.005,316.5,0.99 trailingLine 790.5,90.005,316.5,0.99
        phone.machine: size 1179x131 icon 96,65,36,37 name 150,60,270,47
        phone.project: size 1083x156 avatar 48,36,84,84 stem 89,120,2,36 name 168,41,474,74 dot 666,67.5,21,21 changes 711,47.5,216,61 add 951,30,84,96
        phone.worktree: size 1083x144 trunk 89,0,2,144 elbow 90,71,42,2 chevron - label 168,36.5,582,71 dot 774,61.5,21,21 changes 819,41.5,216,61
        phone.worktreeToggle: size 1083x144 trunk 89,0,2,72 elbow 90,71,42,2 chevron 168,52,39,40 label 222,38,420,68 dot - changes -
        phone.chat: size 1083x146 avatar 48,31.000000000000007,84,84 name 168,36.00000000000001,693,74 corner 885,42.50000000000001,150,61
        tablet.bot: size 960x266 avatar 48,43.00000000000001,180,180 title 264,30,444,74 timestamp 732,30,180,74 dot 852,37,60,60 project 264,104.00000000000001,648,68 workspace 264,175.00000000000003,210,61 branchIcon 486,185.50000000000003,39,40 changes 708,181.50000000000003,204,48 draftIcon 645,185.50000000000003,39,40 divider 264,265.01,696,0.99
        tablet.section: size 960x145 label 72,60,816,61
        tablet.machine: size 960x72 leadingLine 96,47.5,208.5,1 icon 322.5,30.999999999999996,33,34 name 373.5,24,270,48 trailingLine 655.5,47.5,208.5,1
        tablet.workspace: size 960x176 avatar 60,51.999999999999986,90,90 title 174,35.999999999999986,594,61 branch 174,100.49999999999997,240,54 changes 432,96.99999999999999,216,61 addButton 792,51.999999999999986,90,90 addIcon 810,69.99999999999999,54,54
        tablet.chat: size 960x181 card 48,0,864,236 row 49,1,862,180 title 96.99999999999999,24.999999999999996,688,132 indicator 808.9999999999999,64,54,54 dot 826.9999999999999,82,18,18 divider 49,180,862,1
        tablet.archived: size 960x305 card 48,0,864,269 row 49,1,862,267 avatar 96.99999999999999,62.50000000000001,144,144 draftOverlay 193,158.50000000000003,54,54 title 289,37.00000000000001,574.0000000000001,66 subtitle 340,109,360,57 subtitleIcon 289,118,39,39 dot 289,199.00000000000003,18,18 status 319,178,544,54
        """,
        .extraExtraLarge: """
        phone.session: size 1083x274 avatar 48,77,120,120 title 204,30,627,82 timestamp 855,30,180,82 dot 975,41,60,60 project 204,111.99999999999999,831,75 workspace - branchIcon - changes - draftIcon - divider -
        phone.session.workspace: size 1083x287 avatar 48,83.49999999999999,120,120 title 204,30,627,82 timestamp 855,30,180,82 dot 975,41,60,60 project 204,111.99999999999999,831,75 workspace 204,190,210,67 branchIcon 426,203.5,39,40 changes - draftIcon - divider -
        phone.session.changes: size 1083x274 avatar 48,77,120,120 title 204,30,627,82 timestamp 855,30,180,82 dot 975,41,60,60 project 204,111.99999999999999,831,75 workspace - branchIcon - changes 831,190.49999999999997,204,53 draftIcon - divider -
        phone.session.all: size 1083x287 avatar 48,83.49999999999999,120,120 title 204,30,627,82 timestamp 855,30,180,82 dot 975,41,60,60 project 204,111.99999999999999,831,75 workspace 204,190,210,67 branchIcon 426,203.5,39,40 changes 831,196.99999999999997,204,53 draftIcon 768,203.5,39,40 divider -
        phone.archiveToggle.banded: size 1179x163 label 424.5,72,330,67 leadingLine 72,105.005,316.5,0.99 trailingLine 790.5,105.005,316.5,0.99
        phone.archiveToggle: size 1179x163 label 424.5,60,330,67 leadingLine 72,93.005,316.5,0.99 trailingLine 790.5,93.005,316.5,0.99
        phone.machine: size 1179x136 icon 96,67.49999999999999,36,37 name 150,60,270,52
        phone.project: size 1083x156 avatar 48,36,84,84 stem 89,120,2,36 name 168,37,474,82 dot 666,67.5,21,21 changes 711,44.5,216,67 add 951,30,84,96
        phone.worktree: size 1083x150 trunk 89,0,2,150 elbow 90,74,42,2 chevron - label 168,36,582,78 dot 774,64.5,21,21 changes 819,41.5,216,67
        phone.worktreeToggle: size 1083x147 trunk 89,0,2,73.5 elbow 90,72.5,42,2 chevron 168,53.5,39,40 label 222,36,420,75 dot - changes -
        phone.chat: size 1083x154 avatar 48,34.99999999999999,84,84 name 168,35.99999999999999,693,82 corner 885,43.49999999999999,150,67
        tablet.bot: size 960x287 avatar 48,53.499999999999986,180,180 title 264,30,444,82 timestamp 732,30,180,82 dot 852,41,60,60 project 264,111.99999999999999,648,75 workspace 264,190,210,67 branchIcon 486,203.5,39,40 changes 708,196.99999999999997,204,53 draftIcon 645,203.5,39,40 divider 264,286.01,696,0.99
        tablet.section: size 960x151 label 72,60,816,67
        tablet.machine: size 960x77 leadingLine 96,50,208.5,1 icon 322.5,33.5,33,34 name 373.5,24.000000000000007,270,53 trailingLine 655.5,50,208.5,1
        tablet.workspace: size 960x188 avatar 60,57.999999999999986,90,90 title 174,35.999999999999986,594,67 branch 174,106.49999999999997,240,60 changes 432,102.99999999999999,216,67 addButton 792,57.999999999999986,90,90 addIcon 810,75.99999999999999,54,54
        tablet.chat: size 960x194.99999999999994 card 48,0,864,249.99999999999994 row 49,1,862,193.99999999999997 title 96.99999999999999,24.999999999999996,688,146 indicator 808.9999999999999,71,54,54 dot 826.9999999999999,89,18,18 divider 49,193.99999999999997,862,1
        tablet.archived: size 960x324 card 48,0,864,288 row 49,1,862,286 avatar 96.99999999999999,72,144,144 draftOverlay 193,168,54,54 title 289,37.00000000000001,574.0000000000001,73 subtitle 340,116.00000000000001,360,63 subtitleIcon 289,128,39,39 dot 289,215,18,18 status 319,191,544,60
        """,
        .extraExtraExtraLarge: """
        phone.session: size 1083x289 avatar 48,84.5,120,120 title 204,30,627,90 timestamp 855,30,180,90 dot 975,45,60,60 project 204,120,831,82 workspace - branchIcon - changes - draftIcon - divider -
        phone.session.workspace: size 1083x309 avatar 48,94.5,120,120 title 204,30,627,90 timestamp 855,30,180,90 dot 975,45,60,60 project 204,120,831,82 workspace 204,205,210,74 branchIcon 426,222,39,40 changes - draftIcon - divider -
        phone.session.changes: size 1083x294 avatar 48,87,120,120 title 204,30,627,90 timestamp 855,30,180,90 dot 975,45,60,60 project 204,120,831,82 workspace - branchIcon - changes 831,205,204,59 draftIcon - divider -
        phone.session.all: size 1083x309 avatar 48,94.5,120,120 title 204,30,627,90 timestamp 855,30,180,90 dot 975,45,60,60 project 204,120,831,82 workspace 204,205,210,74 branchIcon 426,222,39,40 changes 831,212.5,204,59 draftIcon 768,222,39,40 divider -
        phone.archiveToggle.banded: size 1179x170 label 424.5,72,330,74 leadingLine 72,108.50500000000001,316.5,0.99 trailingLine 790.5,108.50500000000001,316.5,0.99
        phone.archiveToggle: size 1179x170 label 424.5,60,330,74 leadingLine 72,96.50500000000001,316.5,0.99 trailingLine 790.5,96.50500000000001,316.5,0.99
        phone.machine: size 1179x141 icon 96,70,36,37 name 150,60,270,57
        phone.project: size 1083x162 avatar 48,39,84,84 stem 89,123,2,39 name 168,36,474,90 dot 666,70.5,21,21 changes 711,44,216,74 add 951,33,84,96
        phone.worktree: size 1083x158 trunk 89,0,2,158 elbow 90,78.00000000000001,42,2 chevron - label 168,36.00000000000001,582,86 dot 774,68.5,21,21 changes 819,42.00000000000001,216,74
        phone.worktreeToggle: size 1083x154 trunk 89,0,2,77 elbow 90,76,42,2 chevron 168,56.999999999999986,39,40 label 222,35.99999999999999,420,82 dot - changes -
        phone.chat: size 1083x162 avatar 48,39,84,84 name 168,36,693,90 corner 885,44,150,74
        tablet.bot: size 960x309 avatar 48,64.5,180,180 title 264,30,444,90 timestamp 732,30,180,90 dot 852,45,60,60 project 264,120,648,82 workspace 264,205,210,74 branchIcon 486,222,39,40 changes 708,212.5,204,59 draftIcon 645,222,39,40 divider 264,308.01,696,0.99
        tablet.section: size 960x158 label 72,60,816,74
        tablet.machine: size 960x83 leadingLine 96,53,208.5,1 icon 322.5,36.5,33,34 name 373.5,24.000000000000007,270,59 trailingLine 655.5,53,208.5,1
        tablet.workspace: size 960x202.00000000000003 avatar 60,65.00000000000001,90,90 title 174,36.000000000000014,594,74 branch 174,114.50000000000001,240,65 changes 432,110.00000000000001,216,74 addButton 792,65.00000000000001,90,90 addIcon 810,83.00000000000001,54,54
        tablet.chat: size 960x209 card 48,0,864,264 row 49,1,862,208.00000000000003 title 96.99999999999999,25.000000000000018,688,160 indicator 808.9999999999999,78.00000000000003,54,54 dot 826.9999999999999,96.00000000000003,18,18 divider 49,208.00000000000003,862,1
        tablet.archived: size 960x342.00000000000006 card 48,0,864,306.00000000000006 row 49,1,862,304 avatar 96.99999999999999,81.00000000000003,144,144 draftOverlay 193,177,54,54 title 289,37.00000000000001,574.0000000000001,80 subtitle 340,123,360,69 subtitleIcon 289,138,39,39 dot 289,230.5,18,18 status 319,204,544,65
        """,
        .accessibilityMedium: """
        phone.session: size 1083x343 avatar 48,111.50000000000001,120,120 title 204,30,627,118 timestamp 855,30,180,118 dot 975,59,60,60 project 204,148,831,108 workspace - branchIcon - changes - draftIcon - divider -
        phone.session.workspace: size 1083x386.00000000000006 avatar 48,133.00000000000003,120,120 title 204,30,627,118 timestamp 855,30,180,118 dot 975,59,60,60 project 204,148,831,108 workspace 204,259,210,97 branchIcon 426,287.5,39,40 changes - draftIcon - divider -
        phone.session.changes: size 1083x366.00000000000006 avatar 48,123.00000000000003,120,120 title 204,30,627,118 timestamp 855,30,180,118 dot 975,59,60,60 project 204,148,831,108 workspace - branchIcon - changes 831,259,204,77 draftIcon - divider -
        phone.session.all: size 1083x386.00000000000006 avatar 48,133.00000000000003,120,120 title 204,30,627,118 timestamp 855,30,180,118 dot 975,59,60,60 project 204,148,831,108 workspace 204,259,210,97 branchIcon 426,287.5,39,40 changes 831,269,204,77 draftIcon 768,287.5,39,40 divider -
        phone.archiveToggle.banded: size 1179x193.00000000000003 label 424.5,72,330,97 leadingLine 72,120.00500000000002,316.5,0.99 trailingLine 790.5,120.00500000000002,316.5,0.99
        phone.archiveToggle: size 1179x193.00000000000003 label 424.5,60,330,97 leadingLine 72,108.00500000000002,316.5,0.99 trailingLine 790.5,108.00500000000002,316.5,0.99
        phone.machine: size 1179x160 icon 96,79.49999999999999,36,37 name 150,60,270,76
        phone.project: size 1083x190 avatar 48,53,84,84 stem 89,137,2,52.99999999999999 name 168,36,474,118 dot 666,84.5,21,21 changes 711,46.5,216,97 add 951,47,84,96
        phone.worktree: size 1083x185 trunk 89,0,2,185 elbow 90,91.5,42,2 chevron - label 168,36,582,113 dot 774,82,21,21 changes 819,43.99999999999999,216,97
        phone.worktreeToggle: size 1083x180 trunk 89,0,2,90 elbow 90,89,42,2 chevron 168,70,39,40 label 222,36,420,108 dot - changes -
        phone.chat: size 1083x190 avatar 48,53,84,84 name 168,36,693,118 corner 885,46.5,150,97
        tablet.bot: size 960x386.00000000000006 avatar 48,103.00000000000003,180,180 title 264,30,444,118 timestamp 732,30,180,118 dot 852,59,60,60 project 264,148,648,108 workspace 264,259,210,97 branchIcon 486,287.5,39,40 changes 708,269,204,77 draftIcon 645,287.5,39,40 divider 264,385.01,696,0.99
        tablet.section: size 960x181 label 72,60,816,97
        tablet.machine: size 960x101.00000000000001 leadingLine 96,62,208.5,1 icon 322.5,45.5,33,34 name 373.5,24.000000000000007,270,77 trailingLine 655.5,62,208.5,1
        tablet.workspace: size 960x248 avatar 60,88,90,90 title 174,36,594,97 branch 174,138.5,240,86 changes 432,133,216,97 addButton 792,88,90,90 addIcon 810,106,54,54
        tablet.chat: size 960x259 card 48,0,864,314 row 49,1,862,258 title 96.99999999999999,25.000000000000007,688,210 indicator 808.9999999999999,103,54,54 dot 826.9999999999999,121,18,18 divider 49,258,862,1
        tablet.archived: size 960x410.00000000000006 card 48,0,864,374 row 49,1,862,372 avatar 96.99999999999999,115,144,144 draftOverlay 193,211.00000000000003,54,54 title 289,37.00000000000001,574.0000000000001,105 subtitle 340,148,360,91 subtitleIcon 289,174,39,39 dot 289,287.99999999999994,18,18 status 319,250.99999999999997,544,86
        """,
        .accessibilityLarge: """
        phone.session: size 1083x388 avatar 48,134,120,120 title 204,30,627,142 timestamp 855,30,180,142 dot 975,71,60,60 project 204,172,831,129 workspace - branchIcon - changes - draftIcon - divider -
        phone.session.workspace: size 1083x450 avatar 48,165,120,120 title 204,30,627,142 timestamp 855,30,180,142 dot 975,71,60,60 project 204,172,831,129 workspace 204,304,210,116 branchIcon 426,342,39,40 changes - draftIcon - divider -
        phone.session.changes: size 1083x426 avatar 48,153,120,120 title 204,29.99999999999998,627,142 timestamp 855,29.99999999999998,180,142 dot 975,70.99999999999999,60,60 project 204,172,831,129 workspace - branchIcon - changes 831,304,204,92 draftIcon - divider -
        phone.session.all: size 1083x450 avatar 48,165,120,120 title 204,30,627,142 timestamp 855,30,180,142 dot 975,71,60,60 project 204,172,831,129 workspace 204,304,210,116 branchIcon 426,342,39,40 changes 831,316,204,92 draftIcon 768,342,39,40 divider -
        phone.archiveToggle.banded: size 1179x211.99999999999997 label 424.5,72,330,116 leadingLine 72,129.505,316.5,0.99 trailingLine 790.5,129.505,316.5,0.99
        phone.archiveToggle: size 1179x211.99999999999997 label 424.5,60,330,116 leadingLine 72,117.505,316.5,0.99 trailingLine 790.5,117.505,316.5,0.99
        phone.machine: size 1179x175 icon 96,86.99999999999999,36,37 name 150,60,270,91
        phone.project: size 1083x214.00000000000003 avatar 48,65.00000000000001,84,84 stem 89,149,2,65.00000000000001 name 168,36.000000000000014,474,142 dot 666,96.50000000000001,21,21 changes 711,49.000000000000014,216,116 add 951,59.000000000000014,84,96
        phone.worktree: size 1083x208.00000000000003 trunk 89,0,2,208.00000000000003 elbow 90,103,42,2 chevron - label 168,36.000000000000014,582,136 dot 774,93.50000000000001,21,21 changes 819,46.000000000000014,216,116
        phone.worktreeToggle: size 1083x201 trunk 89,0,2,100.5 elbow 90,99.5,42,2 chevron 168,80.5,39,40 label 222,36,420,129 dot - changes -
        phone.chat: size 1083x214.00000000000003 avatar 48,65.00000000000001,84,84 name 168,36.000000000000014,693,142 corner 885,49.000000000000014,150,116
        tablet.bot: size 960x450 avatar 48,135,180,180 title 264,30,444,142 timestamp 732,30,180,142 dot 852,71,60,60 project 264,172,648,129 workspace 264,304,210,116 branchIcon 486,342,39,40 changes 708,316,204,92 draftIcon 645,342,39,40 divider 264,449.01,696,0.99
        tablet.section: size 960x199.99999999999997 label 72,60,816,116
        tablet.machine: size 960x116.00000000000001 leadingLine 96,69.5,208.5,1 icon 322.5,53,33,34 name 373.5,24.000000000000007,270,92 trailingLine 655.5,69.5,208.5,1
        tablet.workspace: size 960x286 avatar 60,107,90,90 title 174,36,594,116 branch 174,158.5,240,103 changes 432,152,216,116 addButton 792,107,90,90 addIcon 810,125,54,54
        tablet.chat: size 960x301 card 48,0,864,356 row 49,1,862,300 title 96.99999999999999,25.000000000000007,688,252 indicator 808.9999999999999,124,54,54 dot 826.9999999999999,142,18,18 divider 49,300,862,1
        tablet.archived: size 960x466 card 48,0,864,430 row 49,1,862,428.00000000000006 avatar 96.99999999999999,143,144,144 draftOverlay 193,239,54,54 title 289,36.999999999999986,574.0000000000001,126 subtitle 340,169,360,109 subtitleIcon 289,204,39,39 dot 289,335.5,18,18 status 319,290,544,103
        """,
        .accessibilityExtraLarge: """
        phone.session: size 1083x451 avatar 48,165.5,120,120 title 204,30,627,175 timestamp 855,30,180,175 dot 975,87.5,60,60 project 204,205.00000000000003,831,159 workspace - branchIcon - changes - draftIcon - divider -
        phone.session.workspace: size 1083x540 avatar 48,210,120,120 title 204,30,627,175 timestamp 855,30,180,175 dot 975,87.5,60,60 project 204,205.00000000000003,831,159 workspace 204,367,210,143 branchIcon 426,418.5,39,40 changes - draftIcon - divider -
        phone.session.changes: size 1083x511 avatar 48,195.5,120,120 title 204,30,627,175 timestamp 855,30,180,175 dot 975,87.5,60,60 project 204,205.00000000000003,831,159 workspace - branchIcon - changes 831,367,204,114 draftIcon - divider -
        phone.session.all: size 1083x540 avatar 48,210,120,120 title 204,30,627,175 timestamp 855,30,180,175 dot 975,87.5,60,60 project 204,205.00000000000003,831,159 workspace 204,367,210,143 branchIcon 426,418.5,39,40 changes 831,381.5,204,114 draftIcon 768,418.5,39,40 divider -
        phone.archiveToggle.banded: size 1179x238.99999999999997 label 424.5,72,330,143 leadingLine 72,143.005,316.5,0.99 trailingLine 790.5,143.005,316.5,0.99
        phone.archiveToggle: size 1179x238.99999999999997 label 424.5,60,330,143 leadingLine 72,131.005,316.5,0.99 trailingLine 790.5,131.005,316.5,0.99
        phone.machine: size 1179x196.00000000000003 icon 96,97.50000000000003,36,37 name 150,60.000000000000014,270,112
        phone.project: size 1083x247.00000000000003 avatar 48,81.50000000000001,84,84 stem 89,165.5,2,81.50000000000001 name 168,36.000000000000014,474,175 dot 666,113.00000000000001,21,21 changes 711,52.000000000000014,216,143 add 951,75.50000000000001,84,96
        phone.worktree: size 1083x238.99999999999997 trunk 89,0,2,238.99999999999997 elbow 90,118.49999999999997,42,2 chevron - label 168,35.999999999999986,582,167 dot 774,108.99999999999999,21,21 changes 819,47.999999999999986,216,143
        phone.worktreeToggle: size 1083x231 trunk 89,0,2,115.5 elbow 90,114.5,42,2 chevron 168,95.5,39,40 label 222,36,420,159 dot - changes -
        phone.chat: size 1083x247.00000000000003 avatar 48,81.50000000000001,84,84 name 168,36.000000000000014,693,175 corner 885,52.000000000000014,150,143
        tablet.bot: size 960x540 avatar 48,180,180,180 title 264,30,444,175 timestamp 732,30,180,175 dot 852,87.5,60,60 project 264,205.00000000000003,648,159 workspace 264,367,210,143 branchIcon 486,418.5,39,40 changes 708,381.5,204,114 draftIcon 645,418.5,39,40 divider 264,539.01,696,0.99
        tablet.section: size 960x226.99999999999997 label 72,60,816,143
        tablet.machine: size 960x138 leadingLine 96,80.5,208.5,1 icon 322.5,64,33,34 name 373.5,24,270,114 trailingLine 655.5,80.5,208.5,1
        tablet.workspace: size 960x340 avatar 60,134,90,90 title 174,36,594,143 branch 174,187,240,127 changes 432,179,216,143 addButton 792,134,90,90 addIcon 810,152,54,54
        tablet.chat: size 960x359 card 48,0,864,414 row 49,1,862,358 title 96.99999999999999,25.000000000000007,688,310 indicator 808.9999999999999,153,54,54 dot 826.9999999999999,171,18,18 divider 49,358,862,1
        tablet.archived: size 960x545 card 48,0,864,509 row 49,1,862,507 avatar 96.99999999999999,182.5,144,144 draftOverlay 193,278.5,54,54 title 289,36.999999999999986,574.0000000000001,155 subtitle 340,198,360,135 subtitleIcon 289,246,39,39 dot 289,402.50000000000006,18,18 status 319,345,544,127
        """,
        .accessibilityExtraExtraLarge: """
        phone.session: size 1083x514 avatar 48,196.99999999999997,120,120 title 204,30,627,208 timestamp 855,30,180,208 dot 975,104,60,60 project 204,238,831,189 workspace - branchIcon - changes - draftIcon - divider -
        phone.session.workspace: size 1083x629.9999999999999 avatar 48,254.99999999999994,120,120 title 204,30,627,208 timestamp 855,30,180,208 dot 975,104,60,60 project 204,238,831,189 workspace 204,429.99999999999994,210,170 branchIcon 426,494.9999999999999,39,40 changes - draftIcon - divider -
        phone.session.changes: size 1083x595 avatar 48,237.49999999999997,120,120 title 204,30,627,208 timestamp 855,30,180,208 dot 975,104,60,60 project 204,238,831,189 workspace - branchIcon - changes 831,429.99999999999994,204,135 draftIcon - divider -
        phone.session.all: size 1083x629.9999999999999 avatar 48,254.99999999999994,120,120 title 204,30,627,208 timestamp 855,30,180,208 dot 975,104,60,60 project 204,238,831,189 workspace 204,429.99999999999994,210,170 branchIcon 426,494.9999999999999,39,40 changes 831,447.5,204,135 draftIcon 768,494.9999999999999,39,40 divider -
        phone.archiveToggle.banded: size 1179x266 label 424.5,72,330,170 leadingLine 72,156.505,316.5,0.99 trailingLine 790.5,156.505,316.5,0.99
        phone.archiveToggle: size 1179x266 label 424.5,60,330,170 leadingLine 72,144.505,316.5,0.99 trailingLine 790.5,144.505,316.5,0.99
        phone.machine: size 1179x217.00000000000003 icon 96,108.00000000000003,36,37 name 150,60.000000000000014,270,133
        phone.project: size 1083x280 avatar 48,98,84,84 stem 89,182,2,98 name 168,36,474,208 dot 666,129.5,21,21 changes 711,55,216,170 add 951,92,84,96
        phone.worktree: size 1083x271 trunk 89,0,2,271 elbow 90,134.5,42,2 chevron - label 168,36,582,199 dot 774,125,21,21 changes 819,50.5,216,170
        phone.worktreeToggle: size 1083x261 trunk 89,0,2,130.5 elbow 90,129.5,42,2 chevron 168,110.5,39,40 label 222,36,420,189 dot - changes -
        phone.chat: size 1083x280 avatar 48,98,84,84 name 168,36,693,208 corner 885,55,150,170
        tablet.bot: size 960x629.9999999999999 avatar 48,224.99999999999994,180,180 title 264,30,444,208 timestamp 732,30,180,208 dot 852,104,60,60 project 264,238,648,189 workspace 264,429.99999999999994,210,170 branchIcon 486,494.9999999999999,39,40 changes 708,447.5,204,135 draftIcon 645,494.9999999999999,39,40 divider 264,629.0099999999999,696,0.99
        tablet.section: size 960x253.99999999999997 label 72,60,816,170
        tablet.machine: size 960x159 leadingLine 96,91,208.5,1 icon 322.5,74.5,33,34 name 373.5,24,270,135 trailingLine 655.5,91,208.5,1
        tablet.workspace: size 960x393.99999999999994 avatar 60,160.99999999999997,90,90 title 174,35.99999999999998,594,170 branch 174,215.49999999999994,240,151 changes 432,205.99999999999997,216,170 addButton 792,160.99999999999997,90,90 addIcon 810,178.99999999999997,54,54
        tablet.chat: size 960x417.0000000000001 card 48,0,864,472.0000000000001 row 49,1,862,416.00000000000006 title 96.99999999999999,25.000000000000007,688,368 indicator 808.9999999999999,182,54,54 dot 826.9999999999999,200,18,18 divider 49,416.00000000000006,862,1
        tablet.archived: size 960x623 card 48,0,864,587 row 49,1,862,585 avatar 96.99999999999999,221.5,144,144 draftOverlay 193,317.5,54,54 title 289,36.999999999999986,574.0000000000001,184 subtitle 340,226.99999999999997,360,160 subtitleIcon 289,287.5,39,39 dot 289,468.5,18,18 status 319,399,544,151
        """,
        .accessibilityExtraExtraExtraLarge: """
        phone.session: size 1083x568 avatar 48,224,120,120 title 204,30,627,236 timestamp 855,30,180,236 dot 975,118,60,60 project 204,266,831,215 workspace - branchIcon - changes - draftIcon - divider -
        phone.session.workspace: size 1083x707 avatar 48,293.5,120,120 title 204,30,627,236 timestamp 855,30,180,236 dot 975,118,60,60 project 204,266,831,215 workspace 204,484,210,193 branchIcon 426,560.5,39,40 changes - draftIcon - divider -
        phone.session.changes: size 1083x668 avatar 48,274,120,120 title 204,30,627,236 timestamp 855,30,180,236 dot 975,118,60,60 project 204,266,831,215 workspace - branchIcon - changes 831,484,204,154 draftIcon - divider -
        phone.session.all: size 1083x707 avatar 48,293.5,120,120 title 204,30,627,236 timestamp 855,30,180,236 dot 975,118,60,60 project 204,266,831,215 workspace 204,484,210,193 branchIcon 426,560.5,39,40 changes 831,503.5,204,154 draftIcon 768,560.5,39,40 divider -
        phone.archiveToggle.banded: size 1179x289 label 424.5,72,330,193 leadingLine 72,168.005,316.5,0.99 trailingLine 790.5,168.005,316.5,0.99
        phone.archiveToggle: size 1179x289 label 424.5,60,330,193 leadingLine 72,156.005,316.5,0.99 trailingLine 790.5,156.005,316.5,0.99
        phone.machine: size 1179x234 icon 96,116.5,36,37 name 150,60,270,150
        phone.project: size 1083x308 avatar 48,112,84,84 stem 89,196.00000000000003,2,111.99999999999999 name 168,36,474,236 dot 666,143.5,21,21 changes 711,57.500000000000014,216,193 add 951,106,84,96
        phone.worktree: size 1083x297 trunk 89,0,2,297 elbow 90,147.5,42,2 chevron - label 168,36,582,225 dot 774,138,21,21 changes 819,52.00000000000001,216,193
        phone.worktreeToggle: size 1083x287 trunk 89,0,2,143.5 elbow 90,142.5,42,2 chevron 168,123.50000000000001,39,40 label 222,36,420,215 dot - changes -
        phone.chat: size 1083x308 avatar 48,112,84,84 name 168,36,693,236 corner 885,57.500000000000014,150,193
        tablet.bot: size 960x707 avatar 48,263.5,180,180 title 264,30,444,236 timestamp 732,30,180,236 dot 852,118,60,60 project 264,266,648,215 workspace 264,484,210,193 branchIcon 486,560.5,39,40 changes 708,503.5,204,154 draftIcon 645,560.5,39,40 divider 264,706.01,696,0.99
        tablet.section: size 960x277 label 72,60,816,193
        tablet.machine: size 960x178 leadingLine 96,100.50000000000003,208.5,1 icon 322.5,84.00000000000001,33,34 name 373.5,24.00000000000001,270,154 trailingLine 655.5,100.50000000000003,208.5,1
        tablet.workspace: size 960x440 avatar 60,184,90,90 title 174,36,594,193 branch 174,239.5,240,172 changes 432,229.00000000000003,216,193 addButton 792,184,90,90 addIcon 810,202,54,54
        tablet.chat: size 960x467.00000000000006 card 48,0,864,522.0000000000001 row 49,1,862,466 title 96.99999999999999,24.999999999999986,688,418 indicator 808.9999999999999,207,54,54 dot 826.9999999999999,225,18,18 divider 49,466,862,1
        tablet.archived: size 960x691 card 48,0,864,655 row 49,1,862,653 avatar 96.99999999999999,255.5,144,144 draftOverlay 193,351.50000000000006,54,54 title 289,36.999999999999986,574.0000000000001,209 subtitle 340,252,360,182 subtitleIcon 289,323.5,39,39 dot 289,526,18,18 status 319,446,544,172
        """,
    ]
}
