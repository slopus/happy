import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// One line of measured text: its box and where its baseline sits in it.
public struct DiffTextBox: Equatable, Sendable {
    public var size: CGSize
    /// Distance from the box's top to the baseline (the font's ascender).
    public var baseline: CGFloat

    public init(size: CGSize, baseline: CGFloat) {
        self.size = size
        self.baseline = baseline
    }
}

/// components/diff/DiffFileHeader.tsx: a `hunkBg` row, 12 in and 9 down,
/// its parts 8 apart and centred vertically:
///
///     12 [chevron] 8 [icon 16] 8 [dir…fileName] 8 [BADGE] 8 [+N] 8 [−N] 12
///
/// The path takes what the rest leave (`flex: 1`): the file name keeps its
/// width and the directory gives way, truncated at its head. The two sit on
/// one baseline (`alignItems: 'baseline'`).
public struct DiffFileHeaderLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingHorizontal: CGFloat = 12
        public static let paddingVertical: CGFloat = 9
        public static let gap: CGFloat = 8
        public static let iconSize: CGFloat = 16
        /// The chevron's Ionicons size.
        public static let chevronSize: CGFloat = 14
    }

    public struct Input: Equatable, Sendable {
        public var width: CGFloat
        /// The chevron's box, when the header toggles.
        public var chevron: CGSize?
        /// The directory part, `""` at the root (still a line tall).
        public var dir: DiffTextBox
        public var fileName: DiffTextBox
        public var badge: CGSize?
        public var additions: CGSize?
        public var deletions: CGSize?

        public init(width: CGFloat, chevron: CGSize?, dir: DiffTextBox, fileName: DiffTextBox, badge: CGSize? = nil, additions: CGSize? = nil, deletions: CGSize? = nil) {
            self.width = width
            self.chevron = chevron
            self.dir = dir
            self.fileName = fileName
            self.badge = badge
            self.additions = additions
            self.deletions = deletions
        }
    }

    public var size: CGSize
    public var chevron: CGRect?
    public var icon: CGRect
    public var dir: CGRect
    public var fileName: CGRect
    public var badge: CGRect?
    public var additions: CGRect?
    public var deletions: CGRect?

    public init(_ input: Input) {
        typealias M = Metrics
        let width = max(0, input.width)
        let path = (
            ascent: max(input.dir.baseline, input.fileName.baseline),
            descent: max(input.dir.size.height - input.dir.baseline, input.fileName.size.height - input.fileName.baseline)
        )
        let pathHeight = path.ascent + path.descent
        let trailing = [input.badge, input.additions, input.deletions]
        let rowHeight = ([input.chevron?.height, M.iconSize, pathHeight] + trailing.map { $0?.height })
            .compactMap { $0 }.max() ?? 0
        let top = M.paddingVertical
        func centred(_ x: CGFloat, _ size: CGSize) -> CGRect {
            CGRect(x: x, y: top + (rowHeight - size.height) / 2, width: size.width, height: size.height)
        }

        var x = M.paddingHorizontal
        if let size = input.chevron {
            chevron = centred(x, size)
            x += size.width + M.gap
        } else {
            chevron = nil
        }
        icon = centred(x, CGSize(width: M.iconSize, height: M.iconSize))
        x += M.iconSize + M.gap

        let trailingWidth = trailing.compactMap { $0 }.reduce(0) { $0 + M.gap + $1.width }
        let pathWidth = max(0, width - M.paddingHorizontal - x - trailingWidth)
        let nameWidth = min(input.fileName.size.width, pathWidth)
        let dirWidth = min(input.dir.size.width, max(0, pathWidth - nameWidth))
        let pathTop = top + (rowHeight - pathHeight) / 2
        dir = CGRect(x: x, y: pathTop + path.ascent - input.dir.baseline, width: dirWidth, height: input.dir.size.height)
        fileName = CGRect(x: x + dirWidth, y: pathTop + path.ascent - input.fileName.baseline, width: nameWidth, height: input.fileName.size.height)

        x += pathWidth
        func next(_ size: CGSize?) -> CGRect? {
            guard let size else { return nil }
            x += M.gap
            defer { x += size.width }
            return centred(x, size)
        }
        badge = next(input.badge)
        additions = next(input.additions)
        deletions = next(input.deletions)
        size = CGSize(width: width, height: rowHeight + M.paddingVertical * 2)
    }
}

/// components/diff/DiffImageView.tsx: the sides there are, side by side
/// with 12 around and between, each a label 6 over a 160-tall box.
public struct DiffImageLayout: Equatable, Sendable {
    public enum Metrics {
        public static let padding: CGFloat = 12
        public static let gap: CGFloat = 12
        public static let labelGap: CGFloat = 6
        public static let boxHeight: CGFloat = 160
        public static let boxBorder: CGFloat = 1
        public static let boxRadius: CGFloat = 6
    }

    public struct Pane: Equatable, Sendable {
        public var label: CGRect
        public var box: CGRect
        /// Inside the border, where the picture is fitted.
        public var image: CGRect
    }

    public var size: CGSize
    public var panes: [Pane]

    /// `labelHeight` is one line of the 10.5 mono label; `count` is how many
    /// sides there are (1 or 2).
    public init(width: CGFloat, count: Int, labelHeight: CGFloat) {
        typealias M = Metrics
        let width = max(0, width)
        let count = max(1, count)
        let paneWidth = max(0, (width - M.padding * 2 - M.gap * CGFloat(count - 1)) / CGFloat(count))
        panes = (0..<count).map { index in
            let x = M.padding + CGFloat(index) * (paneWidth + M.gap)
            let label = CGRect(x: x, y: M.padding, width: paneWidth, height: labelHeight)
            let box = CGRect(x: x, y: label.maxY + M.labelGap, width: paneWidth, height: M.boxHeight)
            return Pane(label: label, box: box, image: box.insetBy(dx: M.boxBorder, dy: M.boxBorder))
        }
        size = CGSize(width: width, height: M.padding * 2 + labelHeight + M.labelGap + M.boxHeight)
    }
}

/// DiffFilesList.tsx's FileSection: the header, then whatever the file has
/// to show, over a 1pt divider. Centred at `layout.maxWidth`.
public struct DiffSectionLayout: Equatable, Sendable {
    public enum Metrics {
        public static let border: CGFloat = 1
        /// "N changed lines — tap to expand".
        public static let hintPaddingVertical: CGFloat = 12
        /// Error, message and loading rows.
        public static let messagePaddingVertical: CGFloat = 16
    }

    public enum Body: Equatable, Sendable {
        /// Collapsed with nothing to explain.
        case none
        /// The size hint's text (13, centred).
        case hint(CGSize)
        /// A message's text, measured at the section's width.
        case message(CGSize)
        /// The small activity indicator.
        case spinner(CGSize)
        /// The image view's height.
        case image(height: CGFloat)
        /// Each built file's view height, one after another.
        case files([CGFloat])
    }

    public var frame: CGRect
    /// The rest are in the section's coordinates.
    public var header: CGRect
    /// The hint's tap target (the whole row).
    public var hintRow: CGRect?
    /// The hint, message or spinner, centred.
    public var content: CGRect?
    public var image: CGRect?
    public var files: [CGRect]
    public var border: CGRect
    public var height: CGFloat { frame.height }

    public init(width: CGFloat, maxWidth: CGFloat? = nil, headerHeight: CGFloat, body: Body) {
        typealias M = Metrics
        let outer = max(0, width)
        let width = min(outer, maxWidth ?? outer)
        header = CGRect(x: 0, y: 0, width: width, height: headerHeight)
        var y = header.maxY
        hintRow = nil
        content = nil
        image = nil
        files = []
        func centred(_ size: CGSize, padding: CGFloat) -> CGRect {
            let size = CGSize(width: min(size.width, width), height: size.height)
            defer { y += padding * 2 + size.height }
            return CGRect(x: (width - size.width) / 2, y: y + padding, width: size.width, height: size.height)
        }
        switch body {
        case .none:
            break
        case .hint(let size):
            hintRow = CGRect(x: 0, y: y, width: width, height: size.height + M.hintPaddingVertical * 2)
            content = centred(size, padding: M.hintPaddingVertical)
        case .message(let size), .spinner(let size):
            content = centred(size, padding: M.messagePaddingVertical)
        case .image(let height):
            image = CGRect(x: 0, y: y, width: width, height: height)
            y += height
        case .files(let heights):
            for height in heights {
                files.append(CGRect(x: 0, y: y, width: width, height: height))
                y += height
            }
        }
        border = CGRect(x: 0, y: y, width: width, height: M.border)
        frame = CGRect(x: (outer - width) / 2, y: 0, width: width, height: border.maxY)
    }
}

/// DiffFilesList.tsx's FlashList: an optional header, the sections one
/// after another, 32 of room at the end. With no sections, the empty text
/// centred 32 in.
public struct DiffFilesListLayout: Equatable, Sendable {
    public enum Metrics {
        public static let paddingBottom: CGFloat = 32
        public static let emptyPadding: CGFloat = 32
        /// HappyAgentDiffView's notices: padding 16, 8 apart.
        public static let noticesPadding: CGFloat = 16
        public static let noticesGap: CGFloat = 8
    }

    public var header: CGRect?
    public var sections: [CGRect]
    public var empty: CGRect?
    public var contentHeight: CGFloat

    /// `sections` are each section's height; `empty` is the empty text's
    /// size, used only when there are none.
    public init(width: CGFloat, headerHeight: CGFloat?, sections heights: [CGFloat], empty: CGSize) {
        typealias M = Metrics
        let width = max(0, width)
        var y: CGFloat = 0
        if let headerHeight {
            header = CGRect(x: 0, y: 0, width: width, height: headerHeight)
            y = headerHeight
        } else {
            header = nil
        }
        sections = heights.map { height in
            defer { y += height }
            return CGRect(x: 0, y: y, width: width, height: height)
        }
        if heights.isEmpty {
            let size = CGSize(width: min(empty.width, max(0, width - M.emptyPadding * 2)), height: empty.height)
            self.empty = CGRect(x: (width - size.width) / 2, y: y + M.emptyPadding, width: size.width, height: size.height)
            y += M.emptyPadding * 2 + size.height
        } else {
            self.empty = nil
        }
        contentHeight = y + M.paddingBottom
    }

    /// The notices' text frames and height, each measured at the inner width.
    public static func notices(width: CGFloat, texts: [Measurable]) -> (frames: [CGRect], height: CGFloat) {
        typealias M = Metrics
        let inner = max(0, width - M.noticesPadding * 2)
        var y = M.noticesPadding
        var frames: [CGRect] = []
        for (index, text) in texts.enumerated() {
            if index > 0 { y += M.noticesGap }
            let size = text.size(fitting: inner)
            frames.append(CGRect(x: M.noticesPadding, y: y, width: size.width, height: size.height))
            y += size.height
        }
        return (frames, y + M.noticesPadding)
    }
}

/// components/diff/DiffChunk.tsx: the chat-sized diff, each built file's
/// view one after another with nothing between.
public struct DiffChunkLayout: Equatable, Sendable {
    /// Rows before "show more" in a chat.
    public static let collapseAfter = 80

    public var files: [DiffFileLayout]
    public var frames: [CGRect]
    public var size: CGSize

    public init(_ inputs: [DiffFileLayout.Input]) {
        var y: CGFloat = 0
        var frames: [CGRect] = []
        var width: CGFloat = 0
        files = inputs.map(DiffFileLayout.init)
        for file in files {
            frames.append(CGRect(x: 0, y: y, width: file.input.width, height: file.height))
            y += file.height
            width = max(width, file.input.width)
        }
        self.frames = frames
        size = CGSize(width: width, height: y)
    }
}

/// Where the reader is in the changes list, so a new text size (which moves
/// every height) keeps the same line at the top of the screen: the section
/// there and, inside it, the code row and how far into it, or else how far
/// into the header or the rest of the section.
public struct DiffReadingPlace: Equatable, Sendable {
    /// One section's frames, in its own coordinates: the section and the
    /// layout of each built file, in order.
    public struct Section: Equatable, Sendable {
        public var layout: DiffSectionLayout
        public var files: [DiffFileLayout]

        public init(layout: DiffSectionLayout, files: [DiffFileLayout] = []) {
            self.layout = layout
            self.files = files
        }
    }

    public enum Part: Equatable, Sendable {
        /// In the header, this far down it (0 to 1).
        case header(CGFloat)
        /// On row `row` of built file `file`, this far down the row.
        case row(file: Int, row: Int, fraction: CGFloat)
        /// Anywhere else in the section, this far down it.
        case section(CGFloat)
    }

    /// The section's index.
    public var section: Int
    public var part: Part

    public init(section: Int, part: Part) {
        self.section = section
        self.part = part
    }

    /// The place at `y` in the list's content; nil above the first section
    /// (the notices) or past the last.
    public init?(y: CGFloat, list: DiffFilesListLayout, sections: [Section]) {
        guard let index = list.sections.firstIndex(where: { $0.minY <= y && y < $0.maxY }), index < sections.count else { return nil }
        let section = sections[index]
        let local = y - list.sections[index].minY
        self.section = index
        let header = section.layout.header
        if local < header.maxY {
            part = .header(header.height > 0 ? (local - header.minY) / header.height : 0)
            return
        }
        for (file, frame) in section.layout.files.enumerated() where file < section.files.count {
            let layout = section.files[file]
            let inCanvas = local - frame.minY - layout.canvas.minY
            guard frame.minY <= local, local < frame.maxY, let row = layout.rowIndex(at: inCanvas) else { continue }
            part = .row(file: file, row: row, fraction: (inCanvas - layout.row(row).minY) / layout.lineHeight)
            return
        }
        let height = section.layout.height
        part = .section(height > 0 ? local / height : 0)
    }

    /// The same place in a list laid out again; nil when its section or
    /// row is no longer there.
    public func y(list: DiffFilesListLayout, sections: [Section]) -> CGFloat? {
        guard section < list.sections.count, section < sections.count else { return nil }
        let top = list.sections[section].minY
        let layout = sections[section].layout
        switch part {
        case .header(let fraction):
            return top + layout.header.minY + fraction * layout.header.height
        case .row(let file, let row, let fraction):
            guard file < layout.files.count, file < sections[section].files.count else { return nil }
            let fileLayout = sections[section].files[file]
            guard row < fileLayout.input.rowCount else { return nil }
            return top + layout.files[file].minY + fileLayout.canvas.minY + fileLayout.row(row).minY + fraction * fileLayout.lineHeight
        case .section(let fraction):
            return top + fraction * layout.height
        }
    }
}
