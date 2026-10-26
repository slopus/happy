#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Plans a Stem Cells conversation's rows off the main thread, with the
/// chat's own pieces: a person's message in its bubble on the right with
/// its photos, the agent's markdown and the pictures and recordings it
/// presented. A row is planned again
/// only when its item, the width or the text size changed.
actor StemCellChatPlanner {
    struct Key: Equatable {
        var width: CGFloat
        /// `ContentWidth.maxWidth`, read on the main thread.
        var maxContentWidth: CGFloat
        var environment: TextEnvironment?
        /// What the references messages make read as now.
        var references = StemCellReferences()
        /// The agents this one spawned, by ID, as titled.
        var subagentTitles: [String: String] = [:]
    }

    private let syntax: CodeSyntaxService
    private var cache: [String: (item: StemCellChatItem, key: Key, copied: Bool, opened: Bool, proposals: [StemCellProposalShown?], plan: ChatRowPlan)] = [:]

    init(syntax: CodeSyntaxService) {
        self.syntax = syntax
    }

    /// `proposals` are the sidebar proposals the items show, as they stand;
    /// `opened` the other agents' messages opened to read.
    func plans(_ items: [StemCellChatItem], key: Key, copied: String?, opened: Set<String> = [], proposals: [String: StemCellProposalShown] = [:]) -> [ChatRowPlan] {
        var next: [String: (item: StemCellChatItem, key: Key, copied: Bool, opened: Bool, proposals: [StemCellProposalShown?], plan: ChatRowPlan)] = [:]
        var plans: [ChatRowPlan] = []
        for item in items {
            let isCopied = copied == item.id
            let isOpened = opened.contains(item.id)
            let shown = item.proposalIds.map { proposals[$0] }
            let plan: ChatRowPlan
            if let cached = cache[item.id], cached.item == item, cached.key == key, cached.copied == isCopied, cached.opened == isOpened, cached.proposals == shown {
                plan = cached.plan
            } else {
                plan = Self.plan(item, key: key, copied: isCopied, opened: isOpened, syntax: syntax, proposals: proposals)
            }
            next[item.id] = (item, key, isCopied, isOpened, shown, plan)
            if plan.size.height > 0 { plans.append(plan) }
        }
        cache = next
        return plans
    }

    static func plan(_ item: StemCellChatItem, key: Key, copied: Bool, opened: Bool = false, syntax: CodeSyntaxService, proposals: [String: StemCellProposalShown] = [:]) -> ChatRowPlan {
        let (width, environment) = (key.width, key.environment)
        if case .collaborator(let agentId, let explanation) = item.role {
            return collaborator(item, agentId: agentId, explanation: explanation, key: key, opened: opened, syntax: syntax)
        }
        guard !item.pieces.isEmpty else { return ChatRowPlan(id: item.id, size: CGSize(width: width, height: 0), items: []) }
        typealias M = StemCellMessageLayout.Metrics
        let text = HappyReferences.plain(item.text, view: key.references.view)
        switch item.role {
        case .agent:
            // Desktop's agent text: Figtree 16/24 markdown, soft breaks as spaces, blocks 8
            // apart, no copy button (a long press selects instead); its
            // pictures and recordings where they were presented.
            var parts: [StemCellMessageLayout.Part] = []
            enum Draft {
                case markdown(MarkdownPiece)
                case gallery([StemCellMedia])
                case tree(StemCellChatMediaPlan.Tree)
                case card(StemCellChatMediaPlan.Card)
                case story(String)
                case proposal(String)
                /// Words the planner writes, read but not selectable.
                case line(MarkdownPiece)
            }
            var drafts: [Draft] = []
            var spoken: [String] = text.isEmpty ? [] : [text]
            for piece in item.pieces {
                switch piece {
                case .text(let text):
                    let resolved = HappyReferences.markdown(text, view: key.references.view)
                    let markdown = MarkdownPiece(StemCellMarkdown.joiningSoftBreaks(resolved), color: Palette.text, diagrams: ChatMermaidHeights(row: item.id), syntax: syntax, in: environment, body: ChatTextStyles.stemCellsText, header: ChatTextStyles.stemCellsHeader)
                    drafts.append(.markdown(markdown))
                    parts.append(.markdown(markdown.blocks))
                case .gallery(let media, let columns):
                    drafts.append(.gallery(media))
                    parts.append(.media(media.map(Self.layoutItem), columns: columns))
                case .tree(let media, let tree):
                    let planned = StemCellChatMediaPlan.tree(media, tree, environment: environment)
                    drafts.append(.tree(planned))
                    parts.append(.tree(planned.boxes))
                case .file(let media):
                    drafts.append(.card(StemCellChatMediaPlan.card(file: media)))
                    parts.append(.card)
                case .story(let id):
                    drafts.append(.story(id))
                    parts.append(.story)
                case .artifact(let artifact):
                    drafts.append(.card(StemCellChatMediaPlan.card(artifact: artifact)))
                    parts.append(.card)
                case .sidebarProposal(let artifactId):
                    // Drawn by the sidebar's own rows once it is read.
                    if let shown = proposals[artifactId], shown.status != .loading, shown.status != .missing {
                        drafts.append(.proposal(artifactId))
                        parts.append(.proposal(shown.input))
                    } else {
                        let line = proposals[artifactId]?.status == .missing ? Strings.StemCells.proposalMissing : Strings.StemCells.proposalLoading
                        let markdown = MarkdownPiece(line, color: Palette.stemCellsCardDetail, diagrams: ChatMermaidHeights(row: item.id), syntax: syntax, in: environment, body: ChatTextStyles.stemCellsText, header: ChatTextStyles.stemCellsHeader)
                        drafts.append(.line(markdown))
                        parts.append(.markdown(markdown.blocks))
                        spoken.append(line)
                    }
                case .picture:
                    break
                }
            }
            let layout = StemCellMessageLayout.agent(width: width, maxContentWidth: key.maxContentWidth, parts: parts)
            var items: [ChatDrawItem] = []
            var hits: [ChatHit] = []
            var proposals: [(artifactId: String, layout: StemCellSidebarProposalLayout, frame: CGRect)] = []
            func media(_ media: StemCellMedia, _ frame: CGRect) {
                items.append(.media(ChatMedia(key: media.key, isVideo: media.isVideo, thumbhash: media.item.thumbhash, label: Strings.StemCells.media(isVideo: media.isVideo, name: media.item.name)), frame: frame))
                hits.insert(ChatHit(frame: frame, action: .openMedia(media.key)), at: 0)
            }
            func card(_ card: StemCellChatMediaPlan.Card, _ frame: CGRect) {
                let drawn = StemCellChatMediaPlan.draw(card, in: frame, environment: environment)
                items += drawn.items
                hits.insert(drawn.hit, at: 0)
            }
            for (placed, draft) in zip(layout.parts, drafts) {
                switch (placed, draft) {
                case (.markdown(let placed, let origin), .markdown(let markdown)):
                    let drawn = markdown.draw(placed, origin: origin)
                    items += drawn.items
                    hits += drawn.hits
                case (.media(let frames), .gallery(let gallery)):
                    for (one, frame) in zip(gallery, frames) { media(one, frame) }
                case (.tree(let tree, let origin), .tree(let planned)):
                    for (index, frame) in tree.items.sorted(by: { $0.key < $1.key }) {
                        let one = planned.media[index]
                        let placed = frame.offsetBy(dx: origin.x, dy: origin.y)
                        if one.isVisual { media(one, placed) } else { card(StemCellChatMediaPlan.card(file: one), placed) }
                    }
                    for (id, frame) in tree.texts.sorted(by: { $0.key < $1.key }) {
                        guard let text = planned.texts[id] else { continue }
                        let placed = frame.offsetBy(dx: origin.x, dy: origin.y)
                        items.append(.text(text.layout(for: placed), placed))
                    }
                case (.card(let frame), .card(let drafted)):
                    card(drafted, frame)
                case (.story(let frame), .story(let id)):
                    items.append(.embed(.story(id), frame: frame))
                case (.markdown(let placed, let origin), .line(let markdown)):
                    items += markdown.draw(placed, origin: origin).items
                case (.proposal(let layout, let frame), .proposal(let artifactId)):
                    proposals.append((artifactId, layout, frame))
                default:
                    break
                }
            }
            // Each picture and recording reads as itself (`ChatMediaView`).
            return ChatRowPlan(id: item.id, size: layout.size, items: items, hits: hits, accessibilityLabel: spoken.joined(separator: "\n\n"), proposals: proposals)
        case .user:
            // Desktop's own message: the text as written (Figtree 16/24), lines and all, in
            // the accent bubble at the right, its photos under it.
            let body = text.isEmpty ? nil : MeasuredText(ChatTextStyles.stemCellsText.string(text, color: Palette.userMessageText, in: environment))
            let pictures: [(id: String, image: StemCellMediaFlow.Image)] = item.pieces.compactMap {
                guard case .picture(let id, _, let data) = $0 else { return nil }
                return (id, Self.pictureSize(data))
            }
            var failure = false
            if case .failed = item.delivery { failure = true }
            let layout = StemCellMessageLayout.user(width: width, maxContentWidth: key.maxContentWidth, text: body?.measurable, pictures: pictures.map(\.image), showsStatus: failure)
            var items: [ChatDrawItem] = []
            var hits: [ChatHit] = []
            if let bubble = layout.bubble {
                items.append(.box(ChatBox(frame: bubble, fill: Palette.stemCellsUserBubble, radius: M.bubbleRadius)))
                hits.append(ChatHit(frame: bubble, action: .copyMenu(text), hold: true))
            }
            if let body, let frame = layout.text { items.append(.text(body.layout(for: frame), frame)) }
            for (picture, frame) in zip(pictures, layout.pictures) {
                let key = StemCellMediaLoader.sentKey(picture.id)
                items.append(.media(ChatMedia(key: key, isVideo: false, thumbhash: nil, label: Strings.StemCells.picture), frame: frame))
                hits.append(ChatHit(frame: frame, action: .openMedia(key)))
            }
            if failure, let frame = layout.status {
                let line = ChatTextLayout(
                    ChatTextStyles.pendingStatus.string(Strings.StemCells.sendFailed, color: Palette.statusError, alignment: .right, lineBreakMode: .byTruncatingTail, in: environment),
                    width: frame.width, maxLines: 1
                )
                items.append(.text(line, frame))
                hits.insert(ChatHit(frame: frame, action: .retry(localId: item.id)), at: 0)
            }
            // On its way, or waiting for the agent to take it: dimmed, never moved.
            let alpha: CGFloat = item.delivery == .sending || item.delivery == .pending ? 0.6 : 1
            let label = [text, failure ? Strings.StemCells.sendFailed : ""].filter { !$0.isEmpty }.joined(separator: ", ")
            return ChatRowPlan(id: item.id, size: layout.size, items: items, hits: hits, alpha: alpha, accessibilityLabel: label)
        case .collaborator:
            // Planned above.
            return ChatRowPlan(id: item.id, size: CGSize(width: width, height: 0), items: [])
        }
    }

    /// happy-desktop's `AgentMessageActivity`: who it came from on one line,
    /// the message itself behind it. With the sender's one line on what it
    /// is, the line is the sender's name and that; without, "Message from"
    /// the sender. A sender nobody here can name shows by its ID's start.
    static func collaborator(_ item: StemCellChatItem, agentId: String, explanation: String?, key: Key, opened: Bool, syntax: CodeSyntaxService) -> ChatRowPlan {
        let environment = key.environment
        let name = key.references.agents[agentId].map { $0.label.isEmpty ? Strings.StemCells.untitledAgent : $0.label }
            ?? key.subagentTitles[agentId].map { $0.isEmpty ? Strings.StemCells.subagent : $0 }
            ?? (agentId.count > 10 ? "\(agentId.prefix(8))…" : agentId)
        let verb: String? = switch explanation {
        case nil: Strings.StemCells.agentMessage
        // A line that names its sender already says who it is from.
        case let explanation? where explanation.contains(agentId): nil
        default: name
        }
        // Desktop names a bare ID in the line by its agent's title.
        let line = explanation.map { HappyReferences.plain($0, view: key.references.view).replacingOccurrences(of: agentId, with: name) }
            ?? Strings.StemCells.agentMessageFrom(name)
        let body = item.text
        let opens = !body.isEmpty
        let verbText = verb.map { ChatTextStyles.stemCellsActivityVerb.string($0, color: Palette.textSecondary, lineBreakMode: .byTruncatingTail, in: environment) }
        let lineText = ChatTextStyles.stemCellsActivityText.string(line, color: Palette.text, lineBreakMode: .byTruncatingTail, in: environment)
        let markdown = opened && opens ? MarkdownPiece(
            StemCellMarkdown.joiningSoftBreaks(HappyReferences.markdown(body, view: key.references.view)), color: Palette.textSecondary,
            diagrams: ChatMermaidHeights(row: item.id), syntax: syntax, in: environment,
            body: ChatTextStyles.stemCellsActivityBody, header: ChatTextStyles.stemCellsActivityHeader
        ) : nil
        let layout = StemCellAgentMessageLayout(
            width: key.width, maxContentWidth: key.maxContentWidth,
            verbWidth: verbText.map { ChatTextLayout(unwrapped: $0).size.width },
            textWidth: ChatTextLayout(unwrapped: lineText).size.width,
            opens: opens, body: markdown?.blocks
        )
        var items: [ChatDrawItem] = [.icon(StemCellsGlyphs.icon("agents"), size: StemCellAgentMessageLayout.Metrics.glyph, frame: layout.glyph, tint: Palette.textSecondary)]
        if let verbText, let frame = layout.verb { items.append(.text(ChatTextLayout(verbText, width: frame.width, maxLines: 1), frame)) }
        items.append(.text(ChatTextLayout(lineText, width: layout.text.width, maxLines: 1), layout.text))
        if let frame = layout.chevron {
            items.append(.icon(StemCellsGlyphs.icon(opened ? "chevron-down" : "chevron-right"), size: StemCellAgentMessageLayout.Metrics.chevron, frame: frame, tint: Palette.textSecondary))
        }
        var hits: [ChatHit] = []
        if let markdown, let placed = layout.body {
            let drawn = markdown.draw(placed, origin: layout.bodyOrigin)
            items += drawn.items
            hits += drawn.hits
        }
        // The whole line opens and closes it, a finger's room above and below.
        if opens { hits.insert(ChatHit(frame: layout.header.insetBy(dx: 0, dy: -StemCellAgentMessageLayout.Metrics.paddingV), action: .toggleTool(item.id)), at: 0) }
        let spoken = [verb, line].compactMap { $0 }.joined(separator: " ") + (opened && opens ? "\n\n" + HappyReferences.plain(body, view: key.references.view) : "")
        return ChatRowPlan(id: item.id, size: layout.size, items: items, hits: hits, accessibilityLabel: spoken)
    }

    /// What the flow knows of a presented item before its bytes arrive.
    static func layoutItem(_ media: StemCellMedia) -> StemCellMediaLayout.Item {
        let item = media.item
        return StemCellMediaLayout.Item(isVideo: media.isVideo, image: StemCellMediaFlow.Image(
            width: item.width.map { CGFloat($0) }, height: item.height.map { CGFloat($0) },
            scale: item.scale.map { CGFloat($0) }, hashedRatio: StemCellMedia.hashedRatio(item.thumbhash).map { CGFloat($0) }
        ))
    }

    /// A sent photo's upright pixel size, read from its header alone.
    static func pictureSize(_ data: Data) -> StemCellMediaFlow.Image {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? CGFloat,
              let height = properties[kCGImagePropertyPixelHeight] as? CGFloat
        else { return StemCellMediaFlow.Image() }
        // EXIF orientations 5 to 8 turn the picture on its side.
        let turned = (properties[kCGImagePropertyOrientation] as? Int).map { (5...8).contains($0) } ?? false
        return turned ? StemCellMediaFlow.Image(width: height, height: width) : StemCellMediaFlow.Image(width: width, height: height)
    }
}
#endif
