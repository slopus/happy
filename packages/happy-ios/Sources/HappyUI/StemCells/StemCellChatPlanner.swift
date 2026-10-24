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
        guard !item.pieces.isEmpty else { return ChatRowPlan(id: item.id, size: CGSize(width: width, height: 0), items: []) }
        typealias M = StemCellMessageLayout.Metrics
        let text = item.text
        switch item.role {
        case .agent:
            // Desktop's agent text: markdown, soft breaks as spaces, blocks 8
            // apart, no copy button (a long press selects instead); its
            // pictures and recordings where they were presented.
            var parts: [StemCellMessageLayout.Part] = []
            var markdowns: [MarkdownPiece] = []
            var galleries: [[StemCellMedia]] = []
            for piece in item.pieces {
                switch piece {
                case .text(let text):
                    let markdown = MarkdownPiece(StemCellMarkdown.joiningSoftBreaks(text), color: Palette.text, diagrams: ChatMermaidHeights(row: item.id), syntax: syntax, in: environment)
                    markdowns.append(markdown)
                    parts.append(.markdown(markdown.blocks))
                case .gallery(let media, let columns):
                    galleries.append(media)
                    parts.append(.media(media.map(Self.layoutItem), columns: columns))
                case .picture:
                    break
                }
            }
            let layout = StemCellMessageLayout.agent(width: width, maxContentWidth: key.maxContentWidth, parts: parts)
            var items: [ChatDrawItem] = []
            var hits: [ChatHit] = []
            var (markdownIndex, galleryIndex) = (0, 0)
            for placed in layout.parts {
                switch placed {
                case .markdown(let placed, let origin):
                    let drawn = markdowns[markdownIndex].draw(placed, origin: origin)
                    markdownIndex += 1
                    items += drawn.items
                    hits += drawn.hits
                case .media(let frames):
                    for (media, frame) in zip(galleries[galleryIndex], frames) {
                        items.append(.media(ChatMedia(key: media.key, isVideo: media.isVideo, thumbhash: media.item.thumbhash, label: Strings.StemCells.media(isVideo: media.isVideo, name: media.item.name)), frame: frame))
                        hits.insert(ChatHit(frame: frame, action: .openMedia(media.key)), at: 0)
                    }
                    galleryIndex += 1
                }
            }
            // Each picture and recording reads as itself (`ChatMediaView`).
            return ChatRowPlan(id: item.id, size: layout.size, items: items, hits: hits, accessibilityLabel: text)
        case .user:
            // Desktop's own message: the text as written, lines and all, in
            // the accent bubble at the right, its photos under it.
            let body = text.isEmpty ? nil : MeasuredText(ChatTextStyles.markdownText.string(text, color: Palette.userMessageText, in: environment))
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
        }
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
