#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

extension HomeRowDrawing {
    nonisolated static func makeTablet(_ row: TabletGroupedRow, width: CGFloat, selected: Bool, environment: HomeTextEnvironment, dark: Bool, catalog: TranslationCatalog = .english) -> HomeRowDrawing {
        if case .bot(let session) = row {
            return make(.flat(.session(session)), width: width, grouped: false, selected: selected, environment: environment, dark: dark, catalog: catalog)
        }
        if case .task(let session) = row {
            return make(.flat(.session(session)), width: width, grouped: false, selected: selected, environment: environment, dark: dark, catalog: catalog)
        }
        if case .archiveToggle(let hidden) = row {
            return make(.project(.archiveToggle(hidden: hidden)), width: width, grouped: true, selected: false, environment: environment, dark: dark, catalog: catalog)
        }
        var plan = HomeRowDrawing(environment: environment, dark: dark)
        func measured(_ value: String, _ style: TextStyle, lines: Int = 1) -> Measurable {
            Measurable { HomeRowMeasurer.measure(value, style: style, in: environment.text, width: $0, maxLines: lines) }
        }
        func text(_ value: String, _ style: TextStyle, _ color: ColorToken, _ frame: CGRect) { plan.marks.append(.text(value, style, color, frame)) }
        func fill(_ color: ColorToken, _ frame: CGRect?) { if let frame { plan.marks.append(.fill(color, frame, round: false)) } }
        func dot(_ tone: TabletStatusTone, _ frame: CGRect, pulse: Bool) {
            let color = TabletStatusColors.color(tone)
            if pulse { plan.pulsingDots.append((color, frame)) }
            else { plan.marks.append(.fill(color, frame, round: true)) }
        }
        switch row {
        case .bot, .task, .archiveToggle: preconditionFailure("handled above")
        case .botsHeader, .tasksHeader, .archiveHeader:
            let label = switch row {
            case .archiveHeader(let age): dayTitle(age, catalog: catalog)
            case .tasksHeader: Strings.Tasks.heading
            default: catalog("sidebar.bots")
            }
            let layout = TabletSectionHeaderLayout(width: width, label: measured(label, TextStyles.sessionDayHeader))
            plan.size = layout.size; text(label, TextStyles.sessionDayHeader, Palette.groupedSectionTitle, layout.label)
            plan.accessibilityLabel = label; plan.isHeading = true
        case .machine(let id, let name):
            let size = Icon.ionicons("desktop-outline").layout(size: 11, scale: environment.text.displayScale)?.size ?? CGSize(width: 11, height: 11)
            let layout = TabletMachineRuleLayout(width: width, hairline: environment.rows.hairline, icon: size, name: measured(name, TextStyles.tabletMachineName))
            plan.size = layout.size
            fill(Palette.divider, layout.leadingLine); fill(Palette.divider, layout.trailingLine)
            text(name, TextStyles.tabletMachineName, Palette.textSecondary, layout.name)
            plan.marks.append(.icon("desktop-outline", 11, Palette.textSecondary, layout.icon))
            plan.accessibilityLabel = name; plan.isHeading = id?.isEmpty != false
        case .workspace(let header):
            let counts = HomeGitDrawing(header.changes, flat: false, environment: environment)
            let layout = TabletWorkspaceHeaderLayout(.init(width: width, title: measured(header.projectName, TextStyles.tabletWorkspaceTitle), branch: measured(header.branch, TextStyles.tabletWorkspaceBranch), changes: header.changes == nil ? nil : counts.layout.size))
            plan.size = layout.size; plan.avatar = header.avatar; plan.avatarFrame = layout.avatar
            plan.addFrame = layout.addButton; plan.roundAdd = true
            text(header.projectName, TextStyles.tabletWorkspaceTitle, Palette.groupedSectionTitle, layout.title)
            text(header.branch, TextStyles.tabletWorkspaceBranch, Palette.textSecondary, layout.branch)
            if let frame = layout.changes {
                counts.append(to: &plan, at: frame)
            }
            plan.accessibilityLabel = header.projectName + ", " + header.branch
            plan.isHeading = true
        case .chat(let chat):
            let title = chat.title ?? catalog("session.newChat")
            let layout = TabletChatRowLayout(.init(width: width, hairline: environment.rows.hairline, title: measured(title, TextStyles.tabletChatTitle, lines: 2), first: chat.first, last: chat.last, projectEnd: chat.projectEnd, showsBorder: chat.showsBorder))
            plan.size = layout.size
            plan.marks.append(.card(layout.card, radius: TabletChatRowLayout.Metrics.cardRadius, top: true, bottom: true, selection: selected ? layout.row : nil))
            fill(Palette.divider, layout.divider)
            plan.marks.append(.clip(layout.row))
            text(title, TextStyles.tabletChatTitle, chat.connected ? Palette.text : Palette.textSecondary, layout.title)
            if chat.hasDraft { plan.marks.append(.icon("create-outline", 14, Palette.textSecondary, layout.indicator)) }
            else if case .dot(let tone, let pulse) = chat.indicator { dot(tone, layout.dot, pulse: pulse) }
            plan.accessibilityLabel = title
        case .archived(let archived):
            let title = archived.title ?? catalog("session.newChat")
            let subtitle: String
            let providerKind: ProviderIconKind?
            switch archived.subtitle {
            case .identity(let value, let kind): subtitle = value; providerKind = kind
            case .folder(let value), .text(let value): subtitle = value; providerKind = nil
            case .unknown: subtitle = catalog("status.unknown"); providerKind = nil
            }
            let word = ComposerStatus.vibingMessages[archived.id.utf8.reduce(0) { ($0 + Int($1)) % ComposerStatus.vibingMessages.count }]
            let status = (archived.modelName.map { "\($0) · " } ?? "") + tabletStatusText(archived.status, word: word, catalog: catalog) + (archived.activity.map { " · \($0)" } ?? "")
            let icon: CGSize?
            switch providerKind {
            case .codex?, .claude?: icon = CGSize(width: 13, height: 13)
            case .grok?, .kimi?, .generic?:
                let name = providerKind == .grok ? "flash-outline" : providerKind == .kimi ? "moon-outline" : "sparkles-outline"
                icon = Icon.ionicons(name).layout(size: 13, scale: environment.text.displayScale)?.size
            case nil: icon = nil
            }
            let layout = TabletArchivedRowLayout(.init(width: width, hairline: environment.rows.hairline, title: measured(title, TextStyles.tabletArchivedTitle), subtitle: measured(subtitle, TextStyles.tabletArchivedSubtitle), subtitleRow: archived.subtitle.inRow, subtitleIcon: icon, status: measured(status, TextStyles.tabletArchivedStatus, lines: 0), last: archived.last))
            plan.size = layout.size
            plan.marks.append(.card(layout.card, radius: TabletArchivedRowLayout.Metrics.radius, top: archived.first, bottom: archived.last, selection: selected ? layout.row : nil))
            plan.marks.append(.clip(layout.card))
            text(title, TextStyles.tabletArchivedTitle, archived.connected ? Palette.text : Palette.textSecondary, layout.title)
            text(subtitle, TextStyles.tabletArchivedSubtitle, Palette.textSecondary, layout.subtitle)
            text(status, TextStyles.tabletArchivedStatus, TabletStatusColors.color(archived.tone), layout.status)
            dot(archived.tone, layout.dot, pulse: archived.pulsing)
            plan.avatar = archived.avatar; plan.avatarFrame = layout.avatar; plan.monochromeAvatar = !archived.connected
            if let kind = providerKind, let frame = layout.subtitleIcon { plan.provider = (kind, frame) }
            if archived.hasDraft {
                plan.marks.append(.fill(Palette.surface, layout.draftOverlay, round: true))
                plan.marks.append(.icon("create-outline", 12, Palette.textSecondary, layout.draftOverlay))
            }
            plan.accessibilityLabel = [title, subtitle, status].joined(separator: ", ")
        }
        plan.background = Palette.groupedBackground
        return plan
    }

    nonisolated private static func tabletStatusText(_ status: TabletArchivedRow.Status, word: String, catalog: TranslationCatalog) -> String {
        switch status {
        case .inputRequired: return catalog("status.inputRequired")
        case .permissionRequired: return catalog("status.permissionRequired")
        case .unread: return catalog("status.unread")
        case .thinking: return word.lowercased() + "…"
        case .online: return catalog("status.online")
        case .lastSeen(let last):
            let time: String
            switch last {
            case .justNow: time = catalog("time.justNow")
            case .minutes(let count): time = catalog("time.minutesAgo", ["count": .number(count)])
            case .hours(let count): time = catalog("time.hoursAgo", ["count": .number(count)])
            case .days(let count): time = catalog("sessionHistory.daysAgo", ["count": .number(count)])
            case .date(let ms):
                let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
                let formatter = DateFormatter()
                let sameYear = Calendar.current.component(.year, from: date) == Calendar.current.component(.year, from: Date())
                formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMd" : "yMMMd")
                time = formatter.string(from: date)
            }
            return catalog("status.lastSeen", ["time": .text(time)])
        }
    }
}
#endif
