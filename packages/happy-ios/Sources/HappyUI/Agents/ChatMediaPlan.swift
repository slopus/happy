#if canImport(UIKit)
import HappyCore
import HappyIcons
import HappyLayout
import UIKit

/// What a conversation draws for media beyond a flow of pictures: a layout
/// the agent wrote (`MediaTree`), and desktop's result cards for documents,
/// files and artifacts. Planned off the main thread with the rest of a row.
enum ChatMediaPlan {
    /// A tree measured and ready to place: its boxes, and its paragraphs by id.
    struct Tree {
        var media: [Media]
        var boxes: [MediaTreeLayout.Box]
        var texts: [Int: MeasuredText]
    }

    static func tree(_ media: [Media], _ tree: MediaTree, environment: TextEnvironment?) -> Tree {
        var texts: [Int: MeasuredText] = [:]
        func boxes(_ blocks: [MediaTree.Block]) -> [MediaTreeLayout.Box] {
            blocks.compactMap { block in
                switch block {
                case .container(let style, let children):
                    return .container(MediaTreeLayout.Style(style), boxes(children))
                case .item(let index, _, let style):
                    guard media.indices.contains(index) else { return nil }
                    return .item(index: index, MediaTreeLayout.Style(style), item(media[index]))
                case .paragraph(let align, let runs):
                    let id = texts.count
                    let text = MeasuredText(string(runs, align: align, environment: environment))
                    texts[id] = text
                    return .text(id: id, text.measurable)
                }
            }
        }
        return Tree(media: media, boxes: boxes(tree.blocks), texts: texts)
    }

    /// An item's shape and natural size before its bytes arrive: as stated,
    /// else its thumbhash's shape; a recording that says nothing is 16:9.
    static func item(_ media: Media) -> MediaTreeLayout.Item {
        let item = media.item
        guard media.isVisual else { return MediaTreeLayout.Item(isCard: true, ratio: 1, natural: nil) }
        var natural: CGSize?
        var ratio = media.isVideo ? 16.0 / 9 : 4.0 / 3
        if let width = item.width, let height = item.height, width > 0, height > 0 {
            let scale = (item.scale ?? 1) > 0 ? item.scale ?? 1 : 1
            natural = CGSize(width: width / scale, height: height / scale)
            ratio = width / height
        } else if let hashed = Media.hashedRatio(item.thumbhash) {
            ratio = hashed
        }
        return MediaTreeLayout.Item(isCard: false, ratio: CGFloat(ratio), natural: natural)
    }

    /// `.happy-media-tree`'s type: 14 on 20, its steps 12/16, 16/24 and a
    /// 20/28 semibold title; strong is bold, em slanted, code mono.
    static func string(_ runs: [MediaTree.Run], align: String?, environment: TextEnvironment?) -> NSAttributedString {
        let scale = environment?.scale.multiplier ?? 1
        let result = NSMutableAttributedString()
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = switch align {
        case "center": .center
        case "right", "end": .right
        case "justify": .justified
        default: .natural
        }
        var tallest: CGFloat = 0
        for run in runs {
            let (size, line): (CGFloat, CGFloat) = switch run.size {
            case "small": (12, 16)
            case "large": (16, 24)
            case "title": (20, 28)
            default: (14, 20)
            }
            let font = run.code
                ? Fonts.mono(bold: run.bold, size: size * 0.9 * scale)
                : Fonts.ui(run.bold ? .bold : run.size == "title" ? .semiBold : .regular, size: size * scale)
            tallest = max(tallest, line * scale)
            let color: ColorToken = switch run.tone {
            case "muted": Palette.treeMuted
            case "accent": Palette.treeAccent
            default: Palette.treeText
            }
            var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor(color)]
            if run.italic { attributes[.obliqueness] = 0.2 }
            if let environment { attributes[.chatDisplayScale] = environment.displayScale }
            result.append(NSAttributedString(string: run.text, attributes: attributes))
        }
        paragraph.minimumLineHeight = tallest
        paragraph.maximumLineHeight = tallest
        result.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: result.length))
        return result
    }

    // MARK: Cards

    struct Card {
        var glyph: Icon
        var title: String
        var detail: String
        var action: ChatRowAction
    }

    static func card(file media: Media) -> Card {
        Card(
            glyph: .ionicons("document-outline"), title: media.item.name,
            detail: Strings.fileDetail(kind: media.item.kind, mimeType: media.item.mimeType, size: media.item.size),
            action: .openMedia(media.key)
        )
    }

    static func card(artifact: Artifact) -> Card {
        Card(
            glyph: glyph(artifact.type),
            title: artifact.title.isEmpty ? Strings.untitledArtifact : artifact.title,
            detail: Strings.artifactDetail(type: artifact.type, version: artifact.version),
            action: .openArtifact(artifact)
        )
    }

    /// Desktop's `ArtifactTypeGlyph`, from the glyphs the app carries.
    static func glyph(_ type: String) -> Icon {
        switch type {
        case "markdown": .ionicons("document-text-outline")
        case "html": .ionicons("globe-outline")
        case "image": .ionicons("image-outline")
        case "image_series": .ionicons("images")
        case "video": .ionicons("videocam")
        case "document": .ionicons("document-outline")
        default: .ionicons("cube-outline")
        }
    }

    /// The card's boxes, glyph, title and detail in `frame`, and its tap.
    static func draw(_ card: Card, in frame: CGRect, environment: TextEnvironment?) -> (items: [ChatDrawItem], hit: ChatHit) {
        typealias C = ResultCardLayout
        let layout = ResultCardLayout(frame: frame, opens: true)
        let scale = environment?.scale.multiplier ?? 1
        func line(_ text: String, weight: Fonts.Weight, size: CGFloat, color: ColorToken, frame: CGRect) -> ChatDrawItem {
            // One line exactly the frame's height, the glyphs centred in it.
            let font = Fonts.ui(weight, size: size * min(scale, 1.2))
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byTruncatingTail
            paragraph.minimumLineHeight = frame.height
            paragraph.maximumLineHeight = frame.height
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font, .foregroundColor: UIColor(color), .paragraphStyle: paragraph, .baselineOffset: (frame.height - font.lineHeight) / 4,
            ]
            if let environment { attributes[.chatDisplayScale] = environment.displayScale }
            return .text(ChatTextLayout(NSAttributedString(string: text, attributes: attributes), width: frame.width, maxLines: 1), frame)
        }
        var items: [ChatDrawItem] = [
            .box(ChatBox(frame: frame, fill: Palette.cardFill, border: Palette.divider, borderWidth: 1, radius: C.radius)),
            .box(ChatBox(frame: layout.chip, fill: Palette.cardChip, radius: C.chipRadius)),
            .icon(card.glyph, size: C.glyph, frame: layout.glyph, tint: Palette.cardDetail),
            line(card.title, weight: .semiBold, size: 14, color: Palette.cardTitle, frame: layout.title),
            line(card.detail, weight: .medium, size: 12, color: Palette.cardDetail, frame: layout.detail),
        ]
        if let chevron = layout.chevron {
            items.append(.icon(.ionicons("chevron-forward"), size: 16, frame: chevron, tint: Palette.cardDetail))
        }
        return (items, ChatHit(frame: frame, action: card.action))
    }
}
#endif
