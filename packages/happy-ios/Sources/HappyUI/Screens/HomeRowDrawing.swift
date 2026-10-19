#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// A view-free drawing plan. Both measurement and drawing use Home's
/// existing pure layouts. Only avatars and active animation overlays need
/// native views; text, rules, tree branches and status dots are bitmaps.
struct HomeRowDrawing: Sendable {
    enum Mark: Sendable {
        case text(String, TextStyle, ColorToken, CGRect)
        case fill(ColorToken, CGRect, round: Bool)
        case icon(String, CGFloat, ColorToken, CGRect)
        case card(CGRect, radius: CGFloat, top: Bool, bottom: Bool, selection: CGRect?)
        case clip(CGRect)
    }

    /// How a row answers a finger, as its table cell does.
    enum Press: Sendable, Equatable {
        /// No feedback: headings, and the tablet's cells.
        case none
        /// A fill behind the content: a flat session's selected background
        /// (SessionRowCell), a project row's pressed one (ProjectListCell).
        case fill(ColorToken)
        /// The content at half strength over an unchanged background
        /// (ArchiveToggleCell).
        case dim
    }

    var size: CGSize = .zero
    /// The row's page colour. It is the row view's own layer, not a mark, so
    /// the press fill sits between it and the content.
    var background: ColorToken?
    var press = Press.none
    var marks: [Mark] = []
    var avatar: SessionAvatar?
    var avatarFrame: CGRect = .zero
    var avatarAlpha: CGFloat = 1
    var monochromeAvatar = false
    var addFrame: CGRect?
    var shimmer: (String, TextStyle, CGRect)?
    var accessibilityLabel = ""
    var accessibilityValue: String?
    var isHeading = false
    var contentAlpha: CGFloat = 1
    var pulsingDots: [(ColorToken, CGRect)] = []
    var provider: (ProviderIconKind, CGRect)?
    var roundAdd = false
    let environment: HomeTextEnvironment
    let dark: Bool
    /// Archived phone rows have fixed geometry for their only live overlay
    /// (the avatar). Their exact text plan belongs to the bitmap display
    /// queue, so opening an archive doesn't measure thousands of hidden
    /// titles before the first visible row can appear. Owns only values.
    private var deferredDrawing: (@Sendable () -> HomeRowDrawing)?
    var defersText: Bool { deferredDrawing != nil }

    init(environment: HomeTextEnvironment, dark: Bool) {
        self.environment = environment; self.dark = dark
    }

    nonisolated func draw(in context: CGContext) {
        if let deferredDrawing {
            #if DEBUG || HAPPY_FIXTURES
            dispatchPrecondition(condition: .notOnQueue(.main))
            #endif
            deferredDrawing().draw(in: context); return
        }
        UIGraphicsPushContext(context)
        defer { UIGraphicsPopContext() }
        context.setAlpha(contentAlpha)
        for mark in marks {
            switch mark {
            case .clip(let frame): context.clip(to: frame)
            case .card(let frame, let radius, let top, let bottom, let selection):
                var corners: UIRectCorner = []
                if top { corners.formUnion([.topLeft, .topRight]) }
                if bottom { corners.formUnion([.bottomLeft, .bottomRight]) }
                let path = UIBezierPath(roundedRect: frame, byRoundingCorners: corners, cornerRadii: CGSize(width: radius, height: radius))
                context.setFillColor(resolved(Palette.surface).cgColor)
                context.addPath(path.cgPath); context.fillPath()
                if let selection {
                    context.saveGState(); context.addPath(path.cgPath); context.clip()
                    context.setFillColor(resolved(Palette.surfaceSelected).cgColor); context.fill(selection)
                    context.restoreGState()
                }
                context.setStrokeColor(resolved(Palette.divider).cgColor)
                context.setLineWidth(environment.rows.hairline)
                context.addPath(path.cgPath); context.strokePath()
            case .fill(let color, let frame, let round):
                context.setFillColor(resolved(color).cgColor)
                if round { context.fillEllipse(in: frame) } else { context.fill(frame) }
            case .text(let value, let style, let color, let frame):
                var attributes = style.scaled(environment.text.scale).attributes(color: resolved(color), lineBreakMode: .byTruncatingTail)
                attributes[.font] = style.font(in: environment.text)
                let text = NSAttributedString(string: style.uppercase ? value.uppercased() : value, attributes: attributes)
                text.draw(with: frame, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
            case .icon(let name, let size, let color, let frame):
                guard let glyph = IconCatalog.glyph(for: .ionicons(name)) else { continue }
                let layout = glyph.layout(size: size, scale: environment.text.displayScale)
                let box = layout.frame(centeredIn: frame, scale: environment.text.displayScale)
                context.saveGState()
                context.translateBy(x: box.minX, y: box.minY)
                context.translateBy(x: layout.glyphOrigin.x, y: layout.glyphOrigin.y)
                context.scaleBy(x: layout.glyphScale, y: layout.glyphScale)
                context.setFillColor(resolved(color).cgColor)
                // Happy's own vector renderer; no icon fonts or system glyph substitution.
                context.addPath(glyph.path.cgPath); context.fillPath()
                context.restoreGState()
            }
        }
    }

    nonisolated func resolved(_ token: ColorToken) -> UIColor {
        UIColor(dark ? token.dark : token.light)
    }

    nonisolated static func make(_ row: HomeListRow, width: CGFloat, grouped: Bool, selected: Bool, environment: HomeTextEnvironment, dark: Bool, catalog: TranslationCatalog = .english, deferArchiveText: Bool = false) -> HomeRowDrawing {
        var plan = HomeRowDrawing(environment: environment, dark: dark)
        let deferred = deferArchiveText && canDeferArchiveText(row)
        func measured(_ value: String, _ style: TextStyle) -> Measurable {
            if deferred { return .fixed(.zero) }
            return Measurable { HomeRowMeasurer.measure(value, style: style, in: environment.text, width: $0, maxLines: 1) }
        }
        func text(_ value: String, _ style: TextStyle, _ color: ColorToken, _ frame: CGRect) {
            plan.marks.append(.text(value, style, color, frame))
        }
        func fill(_ color: ColorToken, _ frame: CGRect?, round: Bool = false) {
            if let frame { plan.marks.append(.fill(color, frame, round: round)) }
        }
        func title(_ value: String, style: TextStyle, frame: CGRect, working: Bool, color: ColorToken = Palette.text) {
            if working { plan.shimmer = (value, style, frame) }
            else { text(value, style, color, frame) }
        }
        func activity(_ activity: HomeActivity, frame: CGRect?) {
            guard activity.blocked || activity.unread else { return }
            if activity.blocked, let frame {
                plan.pulsingDots.append((Palette.sessionBlockedDot, frame)); return
            }
            fill(activity.blocked ? Palette.sessionBlockedDot : Palette.sessionReadyDot, frame, round: true)
        }
        func changes(_ changes: GitLineChanges?, flat: Bool) -> HomeGitDrawing {
            HomeGitDrawing(changes, flat: flat, environment: environment)
        }
        func changesSize(_ parts: HomeGitDrawing) -> GitChangesLayout {
            parts.layout
        }
        func drawChanges(_ parts: HomeGitDrawing, at frame: CGRect?) {
            guard let frame else { return }
            parts.append(to: &plan, at: frame)
        }
        func session(_ row: SessionRow, archived: Bool) {
            let name = row.title ?? catalog("session.newChat")
            plan.accessibilityLabel = [name, row.state == .permissionRequired ? catalog("status.permissionRequired") : row.state == .inputRequired ? catalog("status.inputRequired") : row.corner != .timestamp ? catalog("status.unread") : nil, row.projectName, row.workspaceName, row.timestamp].compactMap { $0 }.joined(separator: ", ")
            plan.avatar = row.avatar
            if grouped { plan.avatar?.harness = nil }
            plan.avatarAlpha = archived || (!grouped && row.faded) ? 0.6 : 1
            plan.contentAlpha = archived || (!grouped && row.faded) ? 0.6 : 1
            if grouped {
                plan.accessibilityLabel = [name, row.timestamp].joined(separator: ", ")
                let layout = ProjectChatRowLayout(width: width, name: measured(name, TextStyles.projectName), corner: row.corner == .timestamp ? measured(row.timestamp, TextStyles.projectTimestamp) : .fixed(width: ProjectListMetrics.chatDotSize, height: ProjectListMetrics.chatDotSize))
                plan.size = layout.size
                plan.avatarFrame = layout.avatar
                title(name, style: TextStyles.projectName, frame: layout.name, working: row.shimmersTitle)
                if row.corner == .timestamp { text(row.timestamp, TextStyles.projectTimestamp, Palette.textSecondary, layout.corner) }
                else { fill(row.corner == .blockedDot ? Palette.sessionBlockedDot : Palette.sessionReadyDot, layout.corner, round: true) }
            } else {
                let parts = changes(row.changes, flat: true)
                let draftBox = Icon.ionicons("create-outline").layout(size: FlatSessionRowLayout.Metrics.draftIconSize, scale: environment.text.displayScale)?.size ?? CGSize(width: 13, height: 13)
                let layout = FlatSessionRowLayout(.init(width: width, title: measured(name, TextStyles.sessionTitle), timestamp: measured(row.timestamp, TextStyles.sessionTimestamp), project: measured(row.projectName, TextStyles.sessionProject), workspace: row.workspaceName.map { measured($0, TextStyles.sessionWorkspace) }, branchIcon: environment.rows.branchIcon, changes: row.changes == nil ? nil : changesSize(parts).size, draftIcon: row.hasDraft ? draftBox : nil, showsDivider: row.showsDivider, lines: environment.rows.sessionLines))
                plan.size = layout.size
                plan.avatarFrame = layout.avatar
                plan.avatarAlpha = row.faded ? 0.5 : 1
                plan.monochromeAvatar = row.faded
                title(name, style: TextStyles.sessionTitle, frame: layout.title, working: row.shimmersTitle, color: row.faded ? Palette.textSecondary : Palette.text)
                if row.corner == .timestamp { text(row.timestamp, TextStyles.sessionTimestamp, Palette.textSecondary, layout.timestamp) }
                else { fill(row.corner == .blockedDot ? Palette.sessionBlockedDot : Palette.sessionReadyDot, layout.dot, round: true) }
                text(row.projectName, TextStyles.sessionProject, Palette.textSecondary, layout.project)
                if let name = row.workspaceName, let frame = layout.workspace { text(name, TextStyles.sessionWorkspace, Palette.textSecondary, frame) }
                if let frame = layout.branchIcon { plan.marks.append(.icon("git-branch-outline", 13, Palette.textSecondary, frame)) }
                if let frame = layout.draftIcon { plan.marks.append(.icon("create-outline", 13, Palette.textSecondary, frame)) }
                drawChanges(parts, at: layout.changes)
                fill(Palette.divider, layout.divider)
                plan.accessibilityLabel += parts.spoken.isEmpty ? "" : ", " + parts.spoken
            }
        }
        switch row {
        case .flat(.session(let row)): session(row, archived: false)
        case .project(.bot(let row)), .project(.task(let row)): session(row, archived: false)
        case .project(.archived(let row)): session(row, archived: true)
        case .flat(.dayHeader(let age)), .project(.archiveHeader(let age)):
            let value = dayTitle(age, catalog: catalog)
            let style = grouped ? TextStyles.projectSection : TextStyles.sessionDayHeader
            if grouped {
                let layout = ProjectSectionLayout(width: width, label: measured(value, style))
                plan.size = layout.size; text(value, style, Palette.groupedSectionTitle, layout.label)
            } else {
                let layout = SessionDayHeaderLayout(width: width, label: measured(value, style))
                plan.size = layout.size; text(value, style, Palette.groupedSectionTitle, layout.label)
            }
            plan.accessibilityLabel = value; plan.isHeading = true
        case .flat(.archiveToggle(let hidden)), .project(.archiveToggle(let hidden)):
            let value = catalog(hidden ? "sidebar.showArchived" : "sidebar.hideArchived")
            let layout = ArchiveToggleLayout(width: width, label: measured(value, TextStyles.archiveToggle), paddingTop: grouped ? ArchiveToggleLayout.unbanded.top : ArchiveToggleLayout.Metrics.paddingTop, paddingBottom: grouped ? ArchiveToggleLayout.unbanded.bottom : ArchiveToggleLayout.Metrics.paddingBottom)
            plan.size = layout.size
            text(value, TextStyles.archiveToggle, Palette.textSecondary, layout.label)
            fill(Palette.divider, layout.leadingLine); fill(Palette.divider, layout.trailingLine)
            plan.accessibilityLabel = value
        case .project(.machine(_, let name)):
            let layout = MachineHeaderLayout(width: width, hairline: environment.rows.hairline, icon: environment.rows.machineIcon, name: measured(name, TextStyles.projectMachine))
            plan.size = layout.size
            text(name, TextStyles.projectMachine, Palette.textSecondary, layout.name)
            plan.marks.append(.icon("desktop-outline", 12, Palette.textSecondary, layout.icon))
            fill(Palette.textSecondary, layout.rule)
            plan.accessibilityLabel = name; plan.isHeading = true
        case .project(.section(_, let section)):
            let value = switch section {
            case .bots: catalog("sidebar.bots")
            case .tasks: Strings.Tasks.heading
            case .projects: catalog("sidebar.projects")
            }
            let layout = ProjectSectionLayout(width: width, label: measured(value, TextStyles.projectSection))
            plan.size = layout.size
            text(value, TextStyles.projectSection, Palette.groupedSectionTitle, layout.label)
            plan.accessibilityLabel = value; plan.isHeading = true
        case .project(.project(let entry)):
            let parts = changes(entry.changes, flat: false)
            let layout = ProjectCardLayout(.init(width: width, hairline: environment.rows.hairline, name: measured(entry.name, TextStyles.projectName), showsDot: entry.activity.blocked || entry.activity.unread, changes: entry.changes == nil ? nil : .fixed(changesSize(parts).size), showsAdd: entry.origin != nil, showsTree: entry.worktreeCount > 0))
            plan.size = layout.size; plan.avatar = entry.avatar; plan.avatarFrame = layout.avatar; plan.addFrame = layout.add
            title(entry.name, style: TextStyles.projectName, frame: layout.name, working: entry.activity.working)
            fill(Palette.textSecondary, layout.stem); activity(entry.activity, frame: layout.dot)
            drawChanges(parts, at: layout.changes); plan.accessibilityLabel = entry.name
        case .project(.worktree(let worktree, let last)):
            let parts = changes(worktree.changes, flat: false)
            let layout = WorktreeRowLayout(.init(width: width, hairline: environment.rows.hairline, label: measured(worktree.title, TextStyles.worktreeName), showsDot: worktree.activity.blocked || worktree.activity.unread, changes: worktree.changes == nil ? nil : .fixed(changesSize(parts).size), last: last))
            plan.size = layout.size
            title(worktree.title, style: TextStyles.worktreeName, frame: layout.label, working: worktree.activity.working)
            fill(Palette.textSecondary, layout.trunk); fill(Palette.textSecondary, layout.elbow)
            activity(worktree.activity, frame: layout.dot); drawChanges(parts, at: layout.changes)
            plan.accessibilityLabel = worktree.title
        case .project(.worktreeToggle(let toggle)):
            let value = toggle.expanded ? catalog("sidebar.showFewerWorkspaces") : catalog("sidebar.showAllWorkspaces", ["count": .number(toggle.worktreeCount)])
            let layout = WorktreeRowLayout(.init(width: width, hairline: environment.rows.hairline, label: measured(value, TextStyles.worktreeToggle), chevron: environment.rows.branchIcon, showsDot: toggle.activity.blocked || toggle.activity.unread, changes: nil, last: true))
            plan.size = layout.size
            text(value, TextStyles.worktreeToggle, Palette.textSecondary, layout.label)
            fill(Palette.textSecondary, layout.trunk); fill(Palette.textSecondary, layout.elbow)
            if let frame = layout.chevron { plan.marks.append(.icon(toggle.expanded ? "chevron-up" : "chevron-down", 13, Palette.textSecondary, frame)) }
            activity(toggle.activity, frame: layout.dot)
            plan.accessibilityLabel = value; plan.accessibilityValue = toggle.expanded ? "expanded" : "collapsed"
        }
        switch row {
        case .flat(.session): plan.press = .fill(Palette.surfaceSelected)
        case .project(.project), .project(.worktree), .project(.worktreeToggle), .project(.bot), .project(.task), .project(.archived):
            plan.press = .fill(Palette.surfacePressed)
        case .flat(.archiveToggle), .project(.archiveToggle): plan.press = .dim
        case .flat(.dayHeader), .project(.machine), .project(.section), .project(.archiveHeader): plan.press = .none
        }
        plan.background = selected ? Palette.surfaceSelected : grouped ? Palette.groupedBackground : Palette.flatListBackground
        if deferred {
            plan.marks = []
            plan.deferredDrawing = {
                make(row, width: width, grouped: grouped, selected: selected, environment: environment, dark: dark, catalog: catalog)
            }
        }
        return plan
    }

    nonisolated static func canDeferArchiveText(_ row: HomeListRow) -> Bool {
        switch row {
        case .flat(.session(let session)), .project(.archived(let session)):
            session.archived && !session.shimmersTitle && session.corner == .timestamp && session.changes == nil
        default: false
        }
    }

    nonisolated static func dayTitle(_ age: SessionList.DayAge, catalog: TranslationCatalog = .english) -> String {
        switch age {
        case .today: catalog("sessionHistory.today")
        case .yesterday: catalog("sessionHistory.yesterday")
        case .daysAgo(let count): catalog("sessionHistory.daysAgo", ["count": .number(count)])
        }
    }
}
#endif
