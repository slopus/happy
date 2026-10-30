#if canImport(UIKit)
import HappyCore
import HappyLayout
import UIKit

/// Plans a V2 conversation's rows off the main thread, with the
/// chat's own pieces: a person's message in its bubble on the right with
/// its photos, the agent's markdown and the pictures and recordings it
/// presented. A row is planned again
/// only when its item, the width or the text size changed.
actor ChatPlanner {
    struct Key: Equatable {
        var width: CGFloat
        /// `ContentWidth.maxWidth`, read on the main thread.
        var maxContentWidth: CGFloat
        var environment: TextEnvironment?
        /// What the references messages make read as now.
        var references = References()
        /// The agents this one spawned, by ID, as titled.
        var subagentTitles: [String: String] = [:]
        /// Inline pages' heights as they measured themselves, by artifact ID.
        var pageHeights: [String: CGFloat] = [:]
        /// The composer's model, which a failure card offers to continue on.
        var switchTarget: SwitchTarget?
        /// Models' names by ID, for what a failure was switched to.
        var modelNames: [String: String] = [:]
    }

    /// An inline page's height until it has measured itself.
    static let pageHeight: CGFloat = 120

    private let syntax: CodeSyntaxService
    private var cache: [String: (item: ChatItem, key: Key, copied: Bool, opened: Bool, proposals: [ProposalShown?], plan: ChatRowPlan)] = [:]

    init(syntax: CodeSyntaxService) {
        self.syntax = syntax
    }

    /// `proposals` are the sidebar proposals the items show, as they stand;
    /// `opened` the other agents' messages opened to read.
    func plans(_ items: [ChatItem], key: Key, copied: String?, opened: Set<String> = [], proposals: [String: ProposalShown] = [:]) -> [ChatRowPlan] {
        var next: [String: (item: ChatItem, key: Key, copied: Bool, opened: Bool, proposals: [ProposalShown?], plan: ChatRowPlan)] = [:]
        var plans: [ChatRowPlan] = []
        // Only a failure card reads the composer's model: another pick
        // plans no other row again.
        var others = key
        others.switchTarget = nil
        others.modelNames = [:]
        for item in items {
            let isCopied = copied == item.id
            let isOpened = opened.contains(item.id)
            let shown = item.proposalIds.map { proposals[$0] }
            var reads = others
            if case .failure = item.role { reads = key }
            let plan: ChatRowPlan
            if let cached = cache[item.id], cached.item == item, cached.key == reads, cached.copied == isCopied, cached.opened == isOpened, cached.proposals == shown {
                plan = cached.plan
            } else {
                plan = Self.plan(item, key: reads, copied: isCopied, opened: isOpened, syntax: syntax, proposals: proposals)
            }
            next[item.id] = (item, reads, isCopied, isOpened, shown, plan)
            if plan.size.height > 0 { plans.append(plan) }
        }
        cache = next
        return plans
    }

    static func plan(_ item: ChatItem, key: Key, copied: Bool, opened: Bool = false, syntax: CodeSyntaxService, proposals: [String: ProposalShown] = [:]) -> ChatRowPlan {
        let (width, environment) = (key.width, key.environment)
        if case .collaborator(let agentId, let explanation) = item.role {
            return collaborator(item, agentId: agentId, explanation: explanation, key: key, opened: opened, syntax: syntax)
        }
        if case .failure(let failure) = item.role {
            return Self.failure(failure, id: item.id, key: key, syntax: syntax)
        }
        guard !item.pieces.isEmpty else { return ChatRowPlan(id: item.id, size: CGSize(width: width, height: 0), items: []) }
        typealias M = MessageLayout.Metrics
        let text = HappyReferences.plain(item.text, view: key.references.view)
        switch item.role {
        case .agent:
            // Desktop's agent text: Figtree 16/24 markdown, soft breaks as spaces, blocks 8
            // apart, no copy button (a long press selects instead); its
            // pictures and recordings where they were presented.
            var parts: [MessageLayout.Part] = []
            enum Draft {
                case markdown(MarkdownPiece)
                case gallery([Media])
                case tree(ChatMediaPlan.Tree)
                case card(ChatMediaPlan.Card)
                case story(String)
                case page(InlinePage)
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
                    let markdown = MarkdownPiece(Markdown.joiningSoftBreaks(resolved), color: Palette.text, diagrams: ChatMermaidHeights(row: item.id), syntax: syntax, in: environment, body: ChatTextStyles.text, header: ChatTextStyles.header)
                    drafts.append(.markdown(markdown))
                    parts.append(.markdown(markdown.blocks))
                case .gallery(let media, let columns):
                    drafts.append(.gallery(media))
                    parts.append(.media(media.map(Self.layoutItem), columns: columns))
                case .tree(let media, let tree):
                    let planned = ChatMediaPlan.tree(media, tree, environment: environment)
                    drafts.append(.tree(planned))
                    parts.append(.tree(planned.boxes))
                case .file(let media):
                    drafts.append(.card(ChatMediaPlan.card(file: media)))
                    parts.append(.card)
                case .story(let id):
                    drafts.append(.story(id))
                    parts.append(.story)
                case .artifact(let artifact):
                    drafts.append(.card(ChatMediaPlan.card(artifact: artifact)))
                    parts.append(.card)
                    // Desktop's inline page, under its card: only where the call follows the latest version.
                    if artifact.followsLatest, let page = key.references.pages[artifact.id] {
                        drafts.append(.page(InlinePage(artifactId: artifact.id, title: artifact.title, page: page)))
                        parts.append(.page(height: key.pageHeights[artifact.id] ?? Self.pageHeight))
                    }
                case .sidebarProposal(let artifactId):
                    // Drawn by the sidebar's own rows once it is read.
                    if let shown = proposals[artifactId], shown.status != .loading, shown.status != .missing {
                        drafts.append(.proposal(artifactId))
                        parts.append(.proposal(shown.input))
                    } else {
                        let line = proposals[artifactId]?.status == .missing ? Strings.proposalMissing : Strings.proposalLoading
                        let markdown = MarkdownPiece(line, color: Palette.cardDetail, diagrams: ChatMermaidHeights(row: item.id), syntax: syntax, in: environment, body: ChatTextStyles.text, header: ChatTextStyles.header)
                        drafts.append(.line(markdown))
                        parts.append(.markdown(markdown.blocks))
                        spoken.append(line)
                    }
                case .picture:
                    break
                }
            }
            let layout = MessageLayout.agent(width: width, maxContentWidth: key.maxContentWidth, parts: parts)
            var items: [ChatDrawItem] = []
            var hits: [ChatHit] = []
            var proposals: [(artifactId: String, layout: SidebarProposalLayout, frame: CGRect)] = []
            func media(_ media: Media, _ frame: CGRect) {
                items.append(.media(ChatMedia(key: media.key, isVideo: media.isVideo, thumbhash: media.item.thumbhash, label: Strings.media(isVideo: media.isVideo, name: media.item.name)), frame: frame))
                hits.insert(ChatHit(frame: frame, action: .openMedia(media.key)), at: 0)
            }
            func card(_ card: ChatMediaPlan.Card, _ frame: CGRect) {
                let drawn = ChatMediaPlan.draw(card, in: frame, environment: environment)
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
                    for (index, frame) in tree.items.sorted(by: { $0.key < $1.key }) where planned.media.indices.contains(index) {
                        let one = planned.media[index]
                        let placed = frame.offsetBy(dx: origin.x, dy: origin.y)
                        if one.isVisual { media(one, placed) } else { card(ChatMediaPlan.card(file: one), placed) }
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
                case (.page(let frame), .page(let page)):
                    items.append(.embed(.page(page), frame: frame))
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
            // the accent bubble at the right, its photos under it. Past ten
            // lines it is cut there until tapped open, as on desktop.
            let string = ChatTextStyles.text.string(text, color: Palette.userMessageText, in: environment)
            let body = text.isEmpty ? nil : MeasuredText(string)
            let preview = MeasuredText(string, maxLines: M.previewLines)
            let toggles = opened ? Strings.showLess : Strings.showFull
            let control = MeasuredText(ChatTextStyles.fold.string(toggles, color: Palette.textSecondary, in: environment))
            let pictures: [(id: String, image: MediaFlow.Image)] = item.pieces.compactMap {
                guard case .picture(let id, _, let data) = $0 else { return nil }
                return (id, Self.pictureSize(data))
            }
            var failure = false
            if case .failed = item.delivery { failure = true }
            let layout = MessageLayout.user(
                width: width, maxContentWidth: key.maxContentWidth, text: body?.measurable,
                fold: body.map { _ in .init(preview: preview.measurable, control: control.measurable, opened: opened, lineHeight: ChatTextStyles.text.lineHeight ?? 24) },
                pictures: pictures.map(\.image), showsStatus: failure
            )
            var items: [ChatDrawItem] = []
            var hits: [ChatHit] = []
            if let bubble = layout.bubble {
                items.append(.box(ChatBox(frame: bubble, fill: Palette.userBubble, radius: M.bubbleRadius)))
                if layout.foldControl != nil { hits.append(ChatHit(frame: bubble, action: .toggleTool(item.id))) }
                hits.append(ChatHit(frame: bubble, action: .copyMenu(text), hold: true))
            }
            if let body, let frame = layout.text { items.append(.text((layout.cut ? preview : body).layout(for: frame), frame)) }
            if let frame = layout.foldControl { items.append(.text(control.layout(for: frame), frame)) }
            for (picture, frame) in zip(pictures, layout.pictures) {
                let key = MediaLoader.sentKey(picture.id)
                items.append(.media(ChatMedia(key: key, isVideo: false, thumbhash: nil, label: Strings.picture), frame: frame))
                hits.append(ChatHit(frame: frame, action: .openMedia(key)))
            }
            if failure, let frame = layout.status {
                let line = ChatTextLayout(
                    ChatTextStyles.pendingStatus.string(Strings.sendFailed, color: Palette.statusError, alignment: .right, lineBreakMode: .byTruncatingTail, in: environment),
                    width: frame.width, maxLines: 1
                )
                items.append(.text(line, frame))
                hits.insert(ChatHit(frame: frame, action: .retry(localId: item.id)), at: 0)
            }
            // On its way, or waiting for the agent to take it: dimmed, never moved.
            let alpha: CGFloat = item.delivery == .sending || item.delivery == .pending ? 0.6 : 1
            let label = [text, failure ? Strings.sendFailed : ""].filter { !$0.isEmpty }.joined(separator: ", ")
            return ChatRowPlan(id: item.id, size: layout.size, items: items, hits: hits, alpha: alpha, accessibilityLabel: label, toggles: layout.foldControl == nil ? nil : toggles)
        case .collaborator, .failure:
            // Planned above.
            return ChatRowPlan(id: item.id, size: CGSize(width: width, height: 0), items: [])
        }
    }

    /// What a failure card's action does, as desktop's card offers it:
    /// run the turn again, or, with another model picked in the composer,
    /// move there and continue.
    enum FailureAction: Equatable {
        case retry
        case switchTo(SwitchTarget)
    }

    /// The model the composer would send with, which a failure card offers
    /// to continue on; `label` names the model as its picker does.
    struct SwitchTarget: Equatable {
        var mode: AgentWire.Mode
        var label: String
    }

    /// The action a failure's card offers now; nil once it was acted on,
    /// or where running it again can't help.
    static func action(_ failure: Failure, target: SwitchTarget?) -> FailureAction? {
        guard failure.resolution == nil, failure.retryable else { return nil }
        if let target, let providerId = failure.providerId,
           target.mode.providerId != providerId || (failure.modelId.map { $0 != target.mode.modelId } ?? false) {
            return .switchTo(target)
        }
        return .retry
    }

    /// desktop's failure card (`ConversationErrorCard`): "Failure", the
    /// reason, the daemon's steps, and Retry or a switch, which becomes
    /// what was done once it is.
    static func failure(_ failure: Failure, id: String, key: Key, syntax: CodeSyntaxService) -> ChatRowPlan {
        let environment = key.environment
        func piece(_ text: String, _ color: ColorToken, selectable: Bool = false) -> MarkdownPiece {
            MarkdownPiece(text, color: color, selectable: selectable, diagrams: ChatMermaidHeights(row: id), syntax: syntax, in: environment, body: ChatTextStyles.text, header: ChatTextStyles.header)
        }
        var pieces: [MarkdownPiece] = [piece("**\(Strings.failure)**", Palette.statusError), piece(failure.reason, Palette.text, selectable: true)]
        pieces += failure.steps.map { piece($0, Palette.textSecondary) }
        let action = Self.action(failure, target: key.switchTarget)
        let actionText: String? = switch action {
        case .retry?: Strings.retry
        case .switchTo(let target)?: Strings.switchAndContinue(target.label)
        case nil:
            switch failure.resolution {
            case .retried?: Strings.retried
            case .switched(_, let modelId)?: Strings.switched(key.modelNames[modelId] ?? modelId)
            case .handled?: Strings.handled
            case nil: nil
            }
        }
        if let actionText { pieces.append(piece(actionText, action == nil ? Palette.textSecondary : Palette.textLink)) }
        let layout = MessageLayout.agent(width: key.width, maxContentWidth: key.maxContentWidth, parts: pieces.map { .markdown($0.blocks) })
        var items: [ChatDrawItem] = []
        var hits: [ChatHit] = []
        for (placed, piece) in zip(layout.parts, pieces) {
            guard case .markdown(let markdown, let origin) = placed else { continue }
            let drawn = piece.draw(markdown, origin: origin)
            items += drawn.items
            hits += drawn.hits
        }
        // The action's whole line answers, a finger's room above and below.
        if action != nil, case .markdown(let markdown, let origin)? = layout.parts.last {
            hits.insert(ChatHit(frame: CGRect(origin: origin, size: markdown.size).insetBy(dx: 0, dy: -8), action: .retry(localId: failure.messageId)), at: 0)
        }
        let spoken = [Strings.failure, failure.reason] + failure.steps + (actionText.map { [$0] } ?? [])
        return ChatRowPlan(id: id, size: layout.size, items: items, hits: hits, accessibilityLabel: spoken.joined(separator: "\n\n"))
    }

    /// happy-desktop's `AgentMessageActivity`: who it came from on one line,
    /// the message itself behind it. With the sender's one line on what it
    /// is, the line is the sender's name and that; without, "Message from"
    /// the sender. A sender nobody here can name shows by its ID's start.
    static func collaborator(_ item: ChatItem, agentId: String, explanation: String?, key: Key, opened: Bool, syntax: CodeSyntaxService) -> ChatRowPlan {
        let environment = key.environment
        let name = key.references.agents[agentId].map { $0.label.isEmpty ? Strings.untitledAgent : $0.label }
            ?? key.subagentTitles[agentId].map { $0.isEmpty ? Strings.subagent : $0 }
            ?? (agentId.count > 10 ? "\(agentId.prefix(8))…" : agentId)
        let verb: String? = switch explanation {
        case nil: Strings.agentMessage
        // A line that names its sender already says who it is from.
        case let explanation? where explanation.contains(agentId): nil
        default: name
        }
        // Desktop names a bare ID in the line by its agent's title.
        let line = explanation.map { HappyReferences.plain($0, view: key.references.view).replacingOccurrences(of: agentId, with: name) }
            ?? Strings.agentMessageFrom(name)
        let body = item.text
        let opens = !body.isEmpty
        let verbText = verb.map { ChatTextStyles.activityVerb.string($0, color: Palette.textSecondary, lineBreakMode: .byTruncatingTail, in: environment) }
        let lineText = ChatTextStyles.activityText.string(line, color: Palette.text, lineBreakMode: .byTruncatingTail, in: environment)
        let markdown = opened && opens ? MarkdownPiece(
            Markdown.joiningSoftBreaks(HappyReferences.markdown(body, view: key.references.view)), color: Palette.textSecondary,
            diagrams: ChatMermaidHeights(row: item.id), syntax: syntax, in: environment,
            body: ChatTextStyles.activityBody, header: ChatTextStyles.activityHeader
        ) : nil
        let layout = AgentMessageLayout(
            width: key.width, maxContentWidth: key.maxContentWidth,
            verbWidth: verbText.map { ChatTextLayout(unwrapped: $0).size.width },
            textWidth: ChatTextLayout(unwrapped: lineText).size.width,
            opens: opens, body: markdown?.blocks
        )
        var items: [ChatDrawItem] = [.icon(Glyphs.icon("agents"), size: AgentMessageLayout.Metrics.glyph, frame: layout.glyph, tint: Palette.textSecondary)]
        if let verbText, let frame = layout.verb { items.append(.text(ChatTextLayout(verbText, width: frame.width, maxLines: 1), frame)) }
        items.append(.text(ChatTextLayout(lineText, width: layout.text.width, maxLines: 1), layout.text))
        if let frame = layout.chevron {
            items.append(.icon(Glyphs.icon(opened ? "chevron-down" : "chevron-right"), size: AgentMessageLayout.Metrics.chevron, frame: frame, tint: Palette.textSecondary))
        }
        var hits: [ChatHit] = []
        if let markdown, let placed = layout.body {
            let drawn = markdown.draw(placed, origin: layout.bodyOrigin)
            items += drawn.items
            hits += drawn.hits
        }
        // The whole line opens and closes it, a finger's room above and below.
        if opens { hits.insert(ChatHit(frame: layout.header.insetBy(dx: 0, dy: -AgentMessageLayout.Metrics.paddingV), action: .toggleTool(item.id)), at: 0) }
        let spoken = [verb, line].compactMap { $0 }.joined(separator: " ") + (opened && opens ? "\n\n" + HappyReferences.plain(body, view: key.references.view) : "")
        return ChatRowPlan(id: item.id, size: layout.size, items: items, hits: hits, accessibilityLabel: spoken)
    }

    /// What the flow knows of a presented item before its bytes arrive.
    static func layoutItem(_ media: Media) -> MediaLayout.Item {
        let item = media.item
        return MediaLayout.Item(isVideo: media.isVideo, image: MediaFlow.Image(
            width: item.width.map { CGFloat($0) }, height: item.height.map { CGFloat($0) },
            scale: item.scale.map { CGFloat($0) }, hashedRatio: Media.hashedRatio(item.thumbhash).map { CGFloat($0) }
        ))
    }

    /// A sent photo's upright pixel size, read from its header alone.
    static func pictureSize(_ data: Data) -> MediaFlow.Image {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? CGFloat,
              let height = properties[kCGImagePropertyPixelHeight] as? CGFloat
        else { return MediaFlow.Image() }
        // EXIF orientations 5 to 8 turn the picture on its side.
        let turned = (properties[kCGImagePropertyOrientation] as? Int).map { (5...8).contains($0) } ?? false
        return turned ? MediaFlow.Image(width: height, height: width) : MediaFlow.Image(width: width, height: height)
    }
}
#endif
