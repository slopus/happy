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
        /// Whether the person's role may run a failed turn again.
        var actionable = true
        /// The server the conversation is on, which says where a settings
        /// link opens (`SettingsLinkPlace`).
        var server: String?
        /// The conversation's agent: a Gen UI's `message` is sent only
        /// into its origin agent's own.
        var agentId: String?
    }

    /// A row as it was planned, and what from.
    struct Planned: @unchecked Sendable {
        var item: ChatItem
        var key: Key
        /// `key`'s number in `plans`; 0 for one it hasn't numbered.
        var keyNumber: Int
        var copied: Bool
        var opened: Bool
        var proposals: [ProposalShown?]
        var plan: ChatRowPlan
    }

    final class Cache: @unchecked Sendable {
        private let lock = NSLock()
        private var rows: [String: Planned] = [:]

        subscript(id: String) -> Planned? {
            get { lock.withLock { rows[id] } }
            set { lock.withLock { rows[id] = newValue } }
        }

        var plans: [String: ChatRowPlan] { lock.withLock { rows.mapValues(\.plan) } }

        func replace(with next: [String: Planned]) {
            lock.withLock {
                // A row planned again at another width while these were
                // planned at the old one is kept for the next pass.
                var next = next
                for id in adopted {
                    guard let row = rows[id], let planned = next[id], planned.item == row.item, planned.key != row.key else { continue }
                    next[id] = row
                }
                adopted = []
                rows = next
            }
        }

        private var adopted: Set<String> = []

        /// `next` in place of `row`, if `row` is still what is kept.
        func adopt(_ next: Planned, replacing row: Planned, id: String) {
            lock.withLock {
                guard let kept = rows[id], kept.plan === row.plan else { return }
                rows[id] = next
                adopted.insert(id)
            }
        }
    }

    /// An inline page's height until it has measured itself.
    static let pageHeight: CGFloat = 120

    private let syntax: CodeSyntaxService
    /// Each row as last planned, by item ID. Behind a lock rather than the
    /// actor, so a width change can plan rows again while the main thread
    /// waits (`plansInPlace`).
    private let cache = Cache()
    /// The time each person's message first showed, which it keeps while
    /// it is shown: the computer's time for a send replaces this phone's
    /// when it is taken, and may be a minute on ("12:59" to "1:00"), which
    /// would widen the bubble or move the time to a line of its own.
    private var times: [String: Double?] = [:]

    init(syntax: CodeSyntaxService) {
        self.syntax = syntax
    }

    /// The key each row was last planned with, as a number: the same key
    /// keeps its number, so a row is told planned with it in one step, not
    /// by comparing every reference the key holds once per row.
    private var keys: [(key: Key, number: Int)] = []
    private var keyNumbers = 0

    private func number(_ key: Key) -> Int {
        if let known = keys.first(where: { $0.key == key }) { return known.number }
        keyNumbers += 1
        // The rows' key and a failure card's: two are all a pass needs.
        keys = Array((keys + [(key, keyNumbers)]).suffix(4))
        return keyNumbers
    }

    /// `proposals` are the sidebar proposals the items show, as they stand;
    /// `opened` the other agents' messages opened to read.
    func plans(_ items: [ChatItem], key: Key, copied: String?, opened: Set<String> = [], proposals: [String: ProposalShown] = [:]) -> [ChatRowPlan] {
        var next: [String: Planned] = [:]
        var plans: [ChatRowPlan] = []
        // Only a failure card reads the composer's model: another pick
        // plans no other row again.
        var others = key
        others.switchTarget = nil
        others.modelNames = [:]
        let othersNumber = number(others)
        var failureNumber: Int?
        var shownTimes: [String: Double?] = [:]
        for var item in items {
            if item.role == .user {
                if let first = times[item.id], item.time != first { item.time = first }
                shownTimes[item.id] = item.time
            }
            let isCopied = copied == item.id
            let isOpened = opened.contains(item.id)
            let shown = item.proposalIds.map { proposals[$0] }
            var reads = others
            var readsNumber = othersNumber
            if case .failure = item.role {
                reads = key
                if failureNumber == nil { failureNumber = number(key) }
                readsNumber = failureNumber ?? 0
            }
            let plan: ChatRowPlan
            if let cached = cache[item.id], (cached.keyNumber == 0 ? cached.key == reads : cached.keyNumber == readsNumber), cached.item == item, cached.copied == isCopied, cached.opened == isOpened, cached.proposals == shown {
                plan = cached.plan
            } else {
                plan = Self.plan(item, key: reads, copied: isCopied, opened: isOpened, syntax: syntax, proposals: proposals)
            }
            next[item.id] = Planned(item: item, key: reads, keyNumber: readsNumber, copied: isCopied, opened: isOpened, proposals: shown, plan: plan)
            if plan.size.height > 0 { plans.append(plan) }
        }
        cache.replace(with: next)
        times = shownTimes
        // The newest of the agent's words may be streaming: where they are
        // is worked out here, off the main thread, for showing them as
        // they come.
        plans.last(where: \.revealable)?.warmReveal()
        return plans
    }

    /// Plans the rows `ids` again at `width`, each as it was last planned
    /// but for the width, while the main thread waits, until `deadline` at
    /// the latest: a width change shows them at the new width in its own
    /// frame. The rows plan side by side, off the main thread. Their plans
    /// are kept for the next `plans`, which takes them for rows that
    /// haven't changed meanwhile; a row not planned in time is left out.
    nonisolated func plansInPlace(_ ids: [String], width: CGFloat, until deadline: DispatchTime) -> [String: ChatRowPlan] {
        let rows = ids.compactMap { id in self.cache[id].map { (id, $0) } }.filter { abs($0.1.key.width - width) > 0.5 }
        guard !rows.isEmpty else { return [:] }
        let cache = cache, syntax = syntax
        let planned = Cache()
        let group = DispatchGroup()
        for (id, row) in rows {
            group.enter()
            DispatchQueue.global(qos: .userInteractive).async {
                defer { group.leave() }
                var key = row.key
                key.width = width
                var proposals: [String: ProposalShown] = [:]
                for (proposal, shown) in zip(row.item.proposalIds, row.proposals) { proposals[proposal] = shown }
                var next = row
                next.key = key
                // Planned at a key `plans` hasn't numbered: told by the key itself.
                next.keyNumber = 0
                next.plan = Self.plan(row.item, key: key, copied: row.copied, opened: row.opened, syntax: syntax, proposals: proposals)
                cache.adopt(next, replacing: row, id: id)
                planned[id] = next
            }
        }
        _ = group.wait(timeout: deadline)
        return planned.plans
    }

    static func plan(_ item: ChatItem, key: Key, copied: Bool, opened: Bool = false, syntax: CodeSyntaxService, proposals: [String: ProposalShown] = [:]) -> ChatRowPlan {
        let (width, environment) = (key.width, key.environment)
        if case .collaborator(let agentId, let explanation) = item.role {
            return collaborator(item, agentId: agentId, explanation: explanation, key: key, opened: opened, syntax: syntax)
        }
        switch item.role {
        case .failure(let failure): return Self.failure(failure, id: item.id, key: key, syntax: syntax)
        case .tool(let tool):
            return item.pieces.isEmpty ? Self.tool(tool, id: item.id, key: key) : Self.toolResult(tool, item: item, key: key, syntax: syntax, proposals: proposals)
        case .turnEnd(let ended): return Self.turnEnd(ended, id: item.id, key: key, copied: copied)
        case .trace(let trace): return Self.trace(trace, id: item.id, key: key)
        case .question(let ask): return Self.question(ask, id: item.id, key: key)
        default: break
        }
        guard !item.pieces.isEmpty else { return ChatRowPlan(id: item.id, size: CGSize(width: width, height: 0), items: []) }
        typealias M = MessageLayout.Metrics
        let text = HappyReferences.plain(item.text, instanceId: key.references.instanceId, view: key.references.view)
        switch item.role {
        case .agent:
            return Self.body(item, key: key, syntax: syntax, proposals: proposals, revealable: true) {
                MessageLayout.agent(width: width, maxContentWidth: key.maxContentWidth, parts: $0)
            }
        case .user:
            // Desktop's own message: the text as written (Figtree 16/24), lines and all, in
            // the accent bubble at the right, its photos under it, whole.
            // Only a ludicrous one, past `foldLines`, is cut there until
            // tapped open.
            // A file on its way that is no picture or video is named under
            // the words; once the computer holds it, it is a card that opens it.
            let named = item.pieces.compactMap { piece -> String? in
                guard case .sentFile(let file) = piece, !file.isVisual else { return nil }
                return "📎 \(file.name)"
            }
            let files = item.pieces.compactMap { piece -> Media? in
                guard case .file(let media) = piece, media.attachment != nil else { return nil }
                return media
            }
            let written = ([text] + named).filter { !$0.isEmpty }.joined(separator: "\n\n")
            let string = ChatTextStyles.text.string(written, color: Palette.userMessageText, in: environment)
            let body = written.isEmpty ? nil : MeasuredText(string)
            let preview = MeasuredText(string, maxLines: M.foldLines)
            let toggles = opened ? Strings.showLess : Strings.showFull
            let control = MeasuredText(ChatTextStyles.fold.string(toggles, color: Palette.textSecondary, in: environment))
            // An attachment the computer holds is read as a tool's media is,
            // its thumbhash first; the sender's own is already here.
            let pictures: [(id: String, image: MediaFlow.Image, isVideo: Bool, attached: Media?)] = item.pieces.flatMap { piece -> [(id: String, image: MediaFlow.Image, isVideo: Bool, attached: Media?)] in
                switch piece {
                case .picture(let id, _, let data): return [(id, Self.pictureSize(data), false, nil)]
                case .sentFile(let file) where file.isVisual: return [(file.id, Self.fileSize(file), file.isVideo, nil)]
                case .gallery(let media, _): return media.filter { $0.attachment != nil }.map { ($0.key, Self.layoutItem($0).image, $0.isVideo, $0) }
                default: return []
                }
            }
            var failure = false
            if case .failed = item.delivery { failure = true }
            // On its way: each picture shows how far it is, and can be
            // taken out; one that failed is sent again with a tap.
            let uploading = item.delivery == .sending || failure
            // Telegram's outgoing status: the clock until the computer has
            // it, a check once it does, two once the agent took it into a run.
            let delivery: MessageDelivery = switch item.delivery {
            case .sending: .sending
            case .pending: .received
            case .sent: .accepted
            case .failed: .failed
            }
            let onMedia = body == nil
            let ink = onMedia ? Palette.deliveryOnMedia : Palette.deliveryInk
            let time = MessageTime.text(item.time, ink: ink, in: environment)
            let status = MessageTime.status(time, in: environment)
            let layout = MessageLayout.user(
                width: width, maxContentWidth: key.maxContentWidth, text: body?.measurable,
                fold: body.map { _ in .init(preview: preview.measurable, control: control.measurable, opened: opened, lineHeight: ChatTextStyles.text.lineHeight ?? 24) },
                // A refusal is the red mark in the slot, as Telegram's: no
                // line under the bubble, so the row never grows when a send fails.
                pictures: pictures.map(\.image), cards: files.count, showsStatus: false,
                delivery: status, trailing: body?.trailing
            )
            var items: [ChatDrawItem] = []
            var hits: [ChatHit] = []
            if let bubble = layout.bubble {
                items.append(.box(ChatBox(frame: bubble, fill: Palette.userBubble, radius: M.bubbleRadius)))
                if layout.foldControl != nil { hits.append(ChatHit(frame: bubble, action: .toggleTool(item.id))) }
                else if failure { hits.append(ChatHit(frame: bubble, action: .retry(localId: item.id))) }
                hits.append(ChatHit(frame: bubble, action: .copyMenu(text), hold: true))
            }
            var selectable: [ChatSelectable.Text] = []
            if let body, let frame = layout.text {
                let drawn = (layout.cut ? preview : body).layout(for: frame)
                items.append(.text(drawn, frame))
                selectable.append(.init(layout: drawn, frame: frame))
            }
            if let frame = layout.foldControl { items.append(.text(control.layout(for: frame), frame)) }
            for (picture, frame) in zip(pictures, layout.pictures) {
                if let media = picture.attached {
                    items.append(.media(ChatMedia(key: media.key, isVideo: media.isVideo, thumbhash: media.item.thumbhash, label: Strings.media(isVideo: media.isVideo, name: media.item.name)), frame: frame))
                    hits.insert(ChatHit(frame: frame, action: .openMedia(media.key)), at: 0)
                    let ring = media.isVideo ? MediaStatusLayout.badgeHit(in: frame) : ChatUpload.ring(in: frame).insetBy(dx: -8, dy: -8)
                    hits.insert(ChatHit(frame: ring, action: .toggleDownload(media.key)), at: 0)
                    continue
                }
                let key = MediaLoader.sentKey(picture.id)
                let upload = uploading ? ChatUpload(key: picture.id, failed: failure) : nil
                items.append(.media(ChatMedia(key: key, isVideo: picture.isVideo, thumbhash: nil, label: picture.isVideo ? Strings.video : Strings.picture, upload: upload), frame: frame))
                if failure {
                    hits.insert(ChatHit(frame: frame, action: .retry(localId: item.id)), at: 0)
                } else if uploading {
                    // Telegram's cancel: the ring's middle takes this one out.
                    hits.insert(ChatHit(frame: ChatUpload.ring(in: frame).insetBy(dx: -8, dy: -8), action: .cancelUpload(messageId: item.id, piece: picture.id)), at: 0)
                    hits.append(ChatHit(frame: frame, action: .openMedia(key)))
                } else {
                    hits.append(ChatHit(frame: frame, action: .openMedia(key)))
                }
            }
            // A file's card, as an agent's: its ring reads or pauses it, the
            // rest opens it once here.
            for (file, frame) in zip(files, layout.cards) {
                let drawn = ChatMediaPlan.draw(ChatMediaPlan.card(file: file), in: frame, environment: environment)
                items += drawn.items
                hits.insert(drawn.hit, at: 0)
                let chip = ResultCardLayout(frame: frame, opens: true).chip
                hits.insert(ChatHit(frame: chip.insetBy(dx: -8, dy: -8), action: .toggleDownload(file.key)), at: 0)
            }
            // The mark says where it is, so the bubble is never dimmed.
            if let box = layout.delivery {
                if let pill = layout.deliveryPill {
                    items.append(.box(ChatBox(frame: pill, fill: Palette.deliveryPill, radius: pill.height / 2)))
                }
                let placed = ChatDeliveryMark.items(status, box: box, time: time, state: delivery, tint: ink, message: item.id)
                items += placed.items
                if failure { hits.insert(ChatHit(frame: placed.mark.insetBy(dx: -8, dy: -8), action: .retry(localId: item.id)), at: 0) }
            }
            let label = ([text] + files.map(\.item.name) + [failure ? Strings.sendFailed : ""]).filter { !$0.isEmpty }.joined(separator: ", ")
            let shape = layout.bubble.map { ChatBox(frame: $0, fill: Palette.userBubble, radius: M.bubbleRadius) }
                ?? ChatBox(frame: (layout.pictures + layout.cards).reduce(CGRect.null) { $0.union($1) })
            let flight = ChatRowFlight(bubble: shape, text: layout.text, status: layout.delivery, media: !pictures.isEmpty)
            let selection = layout.bubble.flatMap { bubble in
                selectable.isEmpty ? nil : ChatSelectable(texts: selectable, whole: text, frame: bubble, card: false)
            }
            return ChatRowPlan(id: item.id, size: layout.size, items: items, hits: hits, accessibilityLabel: label, toggles: layout.foldControl == nil ? nil : toggles, flight: flight, mine: true, selection: selection)
        case .collaborator, .failure, .tool, .turnEnd, .trace, .question:
            // Planned above.
            return ChatRowPlan(id: item.id, size: CGSize(width: width, height: 0), items: [])
        }
    }

    /// An agent message's pieces in the parts `layout` places: desktop's
    /// agent text (Figtree 16/24 markdown, soft breaks as spaces, blocks 8
    /// apart, no copy button: a long press selects instead) and the
    /// pictures, recordings, files and artifacts where they were presented.
    static func body(_ item: ChatItem, key: Key, syntax: CodeSyntaxService, proposals: [String: ProposalShown], revealable: Bool = false, layout: ([MessageLayout.Part]) -> MessageLayout) -> ChatRowPlan {
        let environment = key.environment
        let text = HappyReferences.plain(item.text, instanceId: key.references.instanceId, view: key.references.view)
        var parts: [MessageLayout.Part] = []
        enum Draft {
            case markdown(MarkdownPiece)
            case gallery([Media])
            case tree(ChatMediaPlan.Tree)
            case card(ChatMediaPlan.Card)
            case page(InlinePage)
            case genUI(GenUIEmbed)
            case proposal(String)
            /// Words the planner writes, read but not selectable.
            case line(MarkdownPiece)
        }
        var drafts: [Draft] = []
        var spoken: [String] = text.isEmpty ? [] : [text]
        for piece in item.pieces {
            switch piece {
            case .text(let text):
                let resolved = HappyReferences.markdown(text, instanceId: key.references.instanceId, files: key.references.opens, view: key.references.view)
                let server = key.server
                let references = key.references
                let markdown = MarkdownPiece(
                    Markdown.joiningSoftBreaks(resolved), color: Palette.text, diagrams: ChatMermaidHeights(row: item.id), syntax: syntax, in: environment,
                    body: ChatTextStyles.text, header: ChatTextStyles.header, opens: { ChatLinks.opens($0, server: server) && (ChatLinks.file($0).map(references.opens) ?? true) }
                )
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
            case .artifact(let artifact):
                // An app is never run in the conversation: its card opens it full screen.
                let app = key.references.isApp(artifact.id, version: artifact.version, opensLatest: artifact.opensLatest)
                drafts.append(.card(app ? ChatMediaPlan.card(app: artifact) : ChatMediaPlan.card(artifact: artifact)))
                parts.append(.card)
                let inner = MessageLayout.agentInner(width: key.width, maxContentWidth: key.maxContentWidth)
                // A Gen UI under its card, as tall as its document plans at
                // the column's width, so the row is right on its first layout.
                if !app, let embed = GenUIPlanners.embed(artifact, references: key.references, width: inner, environment: environment, server: key.server, agentId: key.agentId) {
                    drafts.append(.genUI(embed))
                    parts.append(.page(height: embed.height))
                } else if !app, artifact.followsLatest, let page = key.references.pages[artifact.id] {
                    // Desktop's inline page, under its card: only where the call follows the latest version.
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
            case .picture, .sentFile:
                break
            }
        }
        let layout = layout(parts)
        var items: [ChatDrawItem] = []
        var hits: [ChatHit] = []
        var selectable: [ChatSelectable.Text] = []
        var proposals: [(artifactId: String, layout: SidebarProposalLayout, frame: CGRect)] = []
        func media(_ media: Media, _ frame: CGRect, covers: Bool = false) {
            items.append(.media(ChatMedia(key: media.key, isVideo: media.isVideo, thumbhash: media.item.thumbhash, label: Strings.media(isVideo: media.isVideo, name: media.item.name), covers: covers), frame: frame))
            hits.insert(ChatHit(frame: frame, action: .openMedia(media.key)), at: 0)
            // Telegram's ring pauses or resumes the download; a video's
            // play button plays, so its badge does that instead.
            let ring = media.isVideo ? MediaStatusLayout.badgeHit(in: frame) : ChatUpload.ring(in: frame).insetBy(dx: -8, dy: -8)
            hits.insert(ChatHit(frame: ring, action: .toggleDownload(media.key)), at: 0)
        }
        func card(_ card: ChatMediaPlan.Card, _ frame: CGRect) {
            let drawn = ChatMediaPlan.draw(card, in: frame, environment: environment)
            items += drawn.items
            hits.insert(drawn.hit, at: 0)
            if let file = card.file {
                let chip = ResultCardLayout(frame: frame, opens: true).chip
                hits.insert(ChatHit(frame: chip.insetBy(dx: -8, dy: -8), action: .toggleDownload(file.key)), at: 0)
            }
        }
        for (placed, draft) in zip(layout.parts, drafts) {
            switch (placed, draft) {
            case (.markdown(let placed, let origin), .markdown(let markdown)):
                let drawn = markdown.draw(placed, origin: origin)
                items += drawn.items
                hits += drawn.hits
                selectable += drawn.texts
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
            case (.page(let frame), .page(let page)):
                items.append(.embed(.page(page), frame: frame))
            case (.page(let frame), .genUI(let embed)):
                items.append(.embed(.genUI(embed), frame: frame))
            case (.markdown(let placed, let origin), .line(let markdown)):
                items += markdown.draw(placed, origin: origin).items
            case (.proposal(let layout, let frame), .proposal(let artifactId)):
                proposals.append((artifactId, layout, frame))
            default:
                break
            }
        }
        // Each picture and recording reads as itself (`ChatMediaView`).
        return ChatRowPlan(
            id: item.id, size: layout.size, items: items, hits: hits, accessibilityLabel: spoken.joined(separator: "\n\n"), proposals: proposals,
            revealable: revealable, selection: .covering(items, texts: selectable, whole: text)
        )
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
        let action = key.actionable ? Self.action(failure, target: key.switchTarget) : nil
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
        let line = explanation.map { HappyReferences.plain($0, instanceId: key.references.instanceId, view: key.references.view).replacingOccurrences(of: agentId, with: name) }
            ?? Strings.agentMessageFrom(name)
        let body = item.text
        let opens = !body.isEmpty
        let verbText = verb.map { ChatTextStyles.activityVerb.string($0, color: Palette.textSecondary, lineBreakMode: .byTruncatingTail, in: environment) }
        let lineText = ChatTextStyles.activityText.string(line, color: Palette.text, lineBreakMode: .byTruncatingTail, in: environment)
        let markdown = opened && opens ? MarkdownPiece(
            Markdown.joiningSoftBreaks(HappyReferences.markdown(body, instanceId: key.references.instanceId, files: key.references.opens, view: key.references.view)), color: Palette.textSecondary,
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
        let spoken = [verb, line].compactMap { $0 }.joined(separator: " ") + (opened && opens ? "\n\n" + HappyReferences.plain(body, instanceId: key.references.instanceId, view: key.references.view) : "")
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
    /// A sent file's shape as the composer measured it; a square until known.
    static func fileSize(_ file: ChatItem.SentFile) -> MediaFlow.Image {
        guard let width = file.width, let height = file.height, width > 0, height > 0 else { return MediaFlow.Image() }
        return MediaFlow.Image(width: CGFloat(width), height: CGFloat(height))
    }

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
