import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// How many characters of a reply that is still arriving are shown, frame
/// by frame: Telegram's streaming bot replies (`TextRevealController`).
///
/// Text arrives in chunks, tens of milliseconds to half a second apart. The
/// reveal runs behind the newest character at a speed that would reach it
/// about when the next chunk is expected (an exponentially weighted gap
/// between chunks), so the words come out evenly instead of a chunk at a
/// time. The speed itself eases toward that target with a short time
/// constant, so it never jumps. Once nothing more is coming (`finish`), what
/// is left comes out within `finishTime`.
///
/// Adapted from Telegram-iOS
/// `submodules/TelegramUI/Components/StreamingTextReveal/Sources/TextRevealController.swift`;
/// the constants are Telegram's.
public struct TextReveal: Equatable, Sendable {
    /// How quickly the speed follows its target, in seconds.
    public static let speedTimeConstant = 0.12
    /// The weight of the newest gap between chunks in the running average.
    public static let gapWeight = 0.4
    /// The gap assumed before two chunks have been seen.
    public static let initialGap = 0.5
    /// The least time the reveal plans to take to the next chunk.
    public static let stallFloor = 0.10
    /// What is left once the text is final comes out in this long.
    public static let finishTime = 0.3
    /// A frame longer than this (a hitch, the app in the background) counts
    /// as this long.
    public static let longestFrame = 0.05
    /// Characters a second before a second chunk says how fast they come.
    public static let initialRate = 40.0

    /// Characters shown, fractional between frames.
    public private(set) var revealed: Double
    /// Characters there are to show.
    public private(set) var length: Int
    public private(set) var isFinishing = false
    private var speed = 0.0
    private var averageGap = TextReveal.initialGap
    private var lastChunkTime: Double?
    private var lastChunkLength: Int?
    private var nextChunkTime: Double?
    private var chunks = 0
    private var lastFrameTime: Double?

    public init(revealed: Int, length: Int) {
        self.revealed = Double(max(0, min(revealed, length)))
        self.length = max(0, length)
    }

    /// Whole characters shown.
    public var count: Int { Int(revealed) }

    /// The text is `length` characters long as of `time`.
    public mutating func observe(length: Int, at time: Double) {
        if let last = lastChunkLength {
            if length > last {
                if let lastTime = lastChunkTime {
                    let gap = max(time - lastTime, 0.001)
                    averageGap = Self.gapWeight * gap + (1 - Self.gapWeight) * averageGap
                }
                lastChunkTime = time
                lastChunkLength = length
                nextChunkTime = time + averageGap
                chunks += 1
            } else if length < last {
                lastChunkLength = length
            }
        } else {
            lastChunkTime = time
            lastChunkLength = length
            nextChunkTime = time + averageGap
            chunks += 1
        }
        self.length = max(0, length)
        revealed = min(revealed, Double(self.length))
    }

    /// Nothing more is coming: the text ends at `length`.
    public mutating func finish(length: Int) {
        self.length = max(0, length)
        isFinishing = true
        revealed = min(revealed, Double(self.length))
    }

    /// Moves on to `time`. `complete` once finishing and everything is shown.
    public mutating func tick(at time: Double) -> (count: Int, complete: Bool) {
        let frame = min(time - (lastFrameTime ?? time), Self.longestFrame)
        let lag = max(0, Double(length) - revealed)
        let target: Double
        if isFinishing {
            target = max(speed, lag / Self.finishTime)
        } else if chunks < 2 {
            target = lag > 0 ? Self.initialRate : 0
        } else if let nextChunkTime {
            target = lag / max(Self.stallFloor, nextChunkTime - time)
        } else {
            target = lag > 0 ? Self.initialRate : 0
        }
        speed += (target - speed) * min(1, frame / Self.speedTimeConstant)
        revealed = min(Double(length), revealed + speed * frame)
        lastFrameTime = time
        return (count, isFinishing && revealed >= Double(length))
    }
}

/// Where a row's words are, in reading order, so a reply still arriving can
/// show a character at a time: each line of text with where each of its
/// characters ends, and each other block (a code block, a table, a picture)
/// as one piece that shows whole. All in the row's coordinates.
///
/// Telegram measures the same from its text layout (`characterRects`,
/// `layoutForCharacterCount`, `computeRevealedLines` in
/// `InteractiveTextComponent.swift`); here it covers a whole row of
/// markdown blocks.
public struct RevealMap: Equatable, Sendable {
    public struct Line: Equatable, Sendable {
        public var frame: CGRect
        /// Where each character ends, in x. Empty for a block, which counts
        /// `length` characters and shows whole once the first of them does.
        public var ends: [CGFloat]
        public var length: Int

        public init(frame: CGRect, ends: [CGFloat]) {
            self.frame = frame
            self.ends = ends
            length = ends.count
        }

        public init(block frame: CGRect, length: Int) {
            self.frame = frame
            ends = []
            self.length = max(1, length)
        }

        public var isBlock: Bool { ends.isEmpty }
    }

    /// One character coming into view, or a block.
    public struct Glyph: Equatable, Sendable {
        public var index: Int
        public var frame: CGRect
        public var isBlock: Bool
    }

    public let lines: [Line]
    /// The whole row's size, everything shown.
    public let size: CGSize
    /// Where each line's characters start in the count.
    public let starts: [Int]
    public let length: Int
    /// The row's room under its last line, shown with the last line.
    public let bottomPadding: CGFloat

    public init(lines: [Line], size: CGSize) {
        let lines = lines.filter { $0.length > 0 }
        self.lines = lines
        self.size = size
        var starts: [Int] = []
        starts.reserveCapacity(lines.count)
        var total = 0
        for line in lines {
            starts.append(total)
            total += line.length
        }
        self.starts = starts
        length = total
        bottomPadding = max(0, size.height - (lines.map(\.frame.maxY).max() ?? 0))
    }

    /// The line holding character `index`.
    private func line(holding index: Int) -> Int? {
        guard index >= 0, index < length else { return nil }
        var low = 0, high = lines.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if starts[mid] <= index { low = mid } else { high = mid - 1 }
        }
        return low
    }

    /// How tall the row is with `count` characters shown: down to the
    /// lowest line any of them is on (the first line even with none, as
    /// Telegram's bubble starts), then the row's own room under its words.
    /// Grows only where a new line starts.
    public func height(showing count: Int) -> CGFloat {
        guard count < length, let first = lines.first else { return size.height }
        var bottom = first.frame.maxY
        for (index, line) in lines.enumerated() where starts[index] < count {
            bottom = max(bottom, line.frame.maxY)
        }
        return min(size.height, bottom + bottomPadding)
    }

    /// What of the row shows with `count` characters shown: everything above
    /// the line being shown, the whole of each line shown before it that
    /// reaches below that line's top, and the line itself as far as its
    /// last shown character (a block whole). Everything once all show.
    public func mask(showing count: Int) -> [CGRect] {
        guard count < length else { return [CGRect(origin: .zero, size: size)] }
        guard let current = line(holding: max(0, count)) else { return [] }
        let line = lines[current]
        let top = line.frame.minY
        var rects: [CGRect] = []
        if top > 0 { rects.append(CGRect(x: 0, y: 0, width: size.width, height: top)) }
        for index in 0..<current where lines[index].frame.maxY > top {
            rects.append(lines[index].frame)
        }
        let shown = count - starts[current]
        if shown > 0 {
            if line.isBlock {
                rects.append(line.frame)
            } else {
                // From the row's edge: a list's bullet or a quote's bar
                // beside the line shows with it.
                rects.append(CGRect(x: 0, y: line.frame.minY, width: max(0, line.ends[shown - 1]), height: line.frame.height))
            }
        }
        return rects
    }

    /// What comes into view as the count goes from `from` to `to`: each
    /// character with a width (spaces have none to show), and each block
    /// whose first character is among them.
    public func glyphs(from: Int, to: Int) -> [Glyph] {
        let from = max(0, from), to = min(length, to)
        guard from < to, var current = line(holding: from) else { return [] }
        var glyphs: [Glyph] = []
        var index = from
        while index < to, current < lines.count {
            let line = lines[current]
            let start = starts[current]
            let end = min(to, start + line.length)
            if line.isBlock {
                if index == start { glyphs.append(Glyph(index: start, frame: line.frame, isBlock: true)) }
            } else {
                for character in index..<end {
                    let offset = character - start
                    let minX = offset == 0 ? line.frame.minX : line.ends[offset - 1]
                    let width = line.ends[offset] - minX
                    guard width >= 0.5 else { continue }
                    glyphs.append(Glyph(index: character, frame: CGRect(x: minX, y: line.frame.minY, width: width, height: line.frame.height), isBlock: false))
                }
            }
            index = end
            current += 1
        }
        return glyphs
    }
}

/// Telegram's motion for a character coming into view as a reply streams
/// (`InteractiveTextComponent.swift`, `updateRevealMask`): it fades in,
/// rises from 6 points below and grows from half its size, in 0.2 s on
/// the ease-in-out curve. A line the reply moves onto grows the row in
/// 0.15 s, on the same curve (the bubble's `requestFullUpdate`).
public enum StreamingRevealMotion {
    public static let glyphDuration = 0.2
    public static let glyphRise: CGFloat = 6
    public static let glyphScale: CGFloat = 0.5
    /// A block, and what the row shows under its words once the reply is
    /// whole, fade in this long (the bubble's status, `animateInsertion`).
    public static let fadeDuration = 0.2
    public static let heightDuration = 0.15
    /// More characters than this in one frame (a long reply arriving whole)
    /// fade in a line at a time instead of one by one.
    public static let glyphsPerFrame = 48
}
