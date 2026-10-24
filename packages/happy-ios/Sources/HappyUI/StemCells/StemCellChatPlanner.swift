#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Plans a Stem Cells conversation's rows off the main thread, with the
/// chat's own pieces: a person's message in its bubble on the right, the
/// agent's markdown under it with its copy button. A row is planned again
/// only when its item, the width or the text size changed.
actor StemCellChatPlanner {
    struct Key: Equatable {
        var width: CGFloat
        /// `ContentWidth.maxWidth`, read on the main thread.
        var maxContentWidth: CGFloat
        var environment: TextEnvironment?
    }

    private let syntax: CodeSyntaxService
    private var cache: [String: (item: StemCellChatItem, key: Key, copied: Bool, plan: ChatRowPlan)] = [:]

    init(syntax: CodeSyntaxService) {
        self.syntax = syntax
    }

    func plans(_ items: [StemCellChatItem], key: Key, copied: String?) -> [ChatRowPlan] {
        var next: [String: (item: StemCellChatItem, key: Key, copied: Bool, plan: ChatRowPlan)] = [:]
        var plans: [ChatRowPlan] = []
        for item in items {
            let isCopied = copied == item.id
            let plan: ChatRowPlan
            if let cached = cache[item.id], cached.item == item, cached.key == key, cached.copied == isCopied {
                plan = cached.plan
            } else {
                plan = Self.plan(item, key: key, copied: isCopied, syntax: syntax)
            }
            next[item.id] = (item, key, isCopied, plan)
            if plan.size.height > 0 { plans.append(plan) }
        }
        cache = next
        return plans
    }

    static func plan(_ item: StemCellChatItem, key: Key, copied: Bool, syntax: CodeSyntaxService) -> ChatRowPlan {
        let (width, environment) = (key.width, key.environment)
        let text = item.text
        guard !text.isEmpty else { return ChatRowPlan(id: item.id, size: CGSize(width: width, height: 0), items: []) }
        switch item.role {
        case .agent:
            let markdown = MarkdownPiece(text, color: Palette.text, diagrams: ChatMermaidHeights(row: item.id), syntax: syntax, in: environment)
            let layout = AgentTextLayout(width: width, maxContentWidth: key.maxContentWidth, blocks: markdown.blocks)
            let drawn = markdown.draw(layout.markdown, origin: layout.markdownOrigin)
            let slop = AgentTextLayout.Metrics.copyHitSlop
            let copyTarget = CGRect(
                x: layout.copyButton.minX - slop.left, y: layout.copyButton.minY - slop.top,
                width: layout.copyButton.width + slop.left + slop.right, height: layout.copyButton.height + slop.top + slop.bottom
            )
            return ChatRowPlan(
                id: item.id, size: layout.size,
                items: drawn.items + [.icon(.ionicons(copied ? "checkmark" : "copy-outline"), size: AgentTextLayout.Metrics.copyIconSize, frame: layout.copyIcon, tint: Palette.text)],
                hits: [ChatHit(frame: copyTarget, action: .copyMessage(id: item.id, text: text))] + drawn.hits,
                accessibilityLabel: text
            )
        case .user:
            let palette = ChatRowRenderer.bubblePalette(.gray)
            let markdown = MarkdownPiece(text, color: Palette.userMessageText, selectable: false, diagrams: ChatMermaidHeights(row: item.id), syntax: syntax, in: environment)
            let layout = UserMessageLayout(.init(width: width, maxContentWidth: key.maxContentWidth, content: .text(markdown.blocks)))
            var items: [ChatDrawItem] = []
            var hits: [ChatHit] = []
            if let bubble = layout.bubble {
                items.append(.box(ChatBox(frame: bubble, fill: palette.background, border: palette.border, borderWidth: 1, radius: UserMessageLayout.Metrics.bubbleRadius)))
                hits.append(ChatHit(frame: bubble, action: .copyMenu(text), hold: true))
            }
            if let placed = layout.markdown {
                let drawn = markdown.draw(placed, origin: layout.markdownOrigin)
                items += drawn.items
                hits = drawn.hits + hits
            }
            // The status line keeps its height whether or not it says anything,
            // so a message never moves when it settles.
            let status: String
            var failed = false
            switch item.delivery {
            case .sent, .pending: status = ""
            case .sending: status = Strings.StemCells.sending
            case .failed:
                status = Strings.StemCells.sendFailed
                failed = true
            }
            if !status.isEmpty {
                let line = ChatTextLayout(
                    ChatTextStyles.pendingStatus.string(status, color: failed ? Palette.statusError : Palette.textSecondary, alignment: .right, lineBreakMode: .byTruncatingTail, in: environment),
                    width: layout.status.width, maxLines: 1
                )
                items.append(.text(line, layout.status))
                if failed { hits.insert(ChatHit(frame: layout.status, action: .retry(localId: item.id)), at: 0) }
            }
            return ChatRowPlan(
                id: item.id, size: layout.size, items: items, hits: hits,
                alpha: item.delivery == .pending ? UserMessageLayout.Metrics.pendingOpacity : 1,
                accessibilityLabel: [text, status.isEmpty ? nil : status].compactMap { $0 }.joined(separator: ", ")
            )
        }
    }
}
#endif
