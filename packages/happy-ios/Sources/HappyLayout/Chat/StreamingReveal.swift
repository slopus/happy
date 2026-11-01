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
/// the constants are Telegram's. Two things differ, both so that words that
/// are already here never crawl out:
/// - Before a second chunk, Telegram shows 40 characters a second however
///   many there are, so a long first chunk (a whole message, a reconnect's
///   catch-up) takes many seconds. Here the first chunk is paced like any
///   other, to be out by when the next is due, and never slower than 40.
/// - Telegram's finish eases the speed up to the finishing one, so it takes
///   up to half a second. Here `finish` takes that speed at once, and what
///   is left is out in `finishTime`, as it says.
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

    /// Nothing more is coming: the text ends at `length`, and what is left
    /// comes out within `finishTime` from now.
    public mutating func finish(length: Int) {
        self.length = max(0, length)
        isFinishing = true
        revealed = min(revealed, Double(self.length))
        speed = max(speed, (Double(self.length) - revealed) / Self.finishTime)
    }

    /// Moves on to `time`. `complete` once finishing and everything is shown.
    public mutating func tick(at time: Double) -> (count: Int, complete: Bool) {
        let frame = min(time - (lastFrameTime ?? time), Self.longestFrame)
        let lag = max(0, Double(length) - revealed)
        let target: Double
        if isFinishing {
            target = max(speed, lag / Self.finishTime)
        } else if let nextChunkTime {
            let paced = lag / max(Self.stallFloor, nextChunkTime - time)
            // The first chunk: out by when the next is due, at 40 a second
            // or faster.
            target = chunks < 2 && lag > 0 ? max(Self.initialRate, paced) : paced
        } else {
            target = lag > 0 ? Self.initialRate : 0
        }
        speed += (target - speed) * min(1, frame / Self.speedTimeConstant)
        revealed = min(Double(length), revealed + speed * frame)
        lastFrameTime = time
        return (count, isFinishing && revealed >= Double(length))
    }
}

/// Which of a transcript's rows shows its words as they stream, update by
/// update. Telegram reveals only a bot's draft, the one message still being
/// written, and finishes it the moment it stops being one
/// (`ChatMessageTextBubbleContentNode`, `TypingDraftMessageAttribute`); a
/// message read from history never reveals. Here:
///
/// - Only the newest row reveals at the stream's pace (`target`), while the
///   agent works. A row that stops being the newest (anything came after
///   it, or the agent stopped) finishes: what is left comes out in
///   `TextReveal.finishTime`.
/// - Only words that arrive while the chat is on screen reveal. Never the
///   history it opens with, what came while it was away (another screen
///   over it, the app in the background), or several rows arriving in one
///   update or one row growing by a lot at once: a reconnect's catch-up
///   or a burst. Those show whole.
public struct RevealFocus: Equatable, Sendable {
    /// What a row is next to the update before.
    public enum Change: Equatable, Sendable {
        /// It wasn't there.
        case new
        /// Its words are what they were and `by` characters more.
        case grew(by: Int)
        /// The same words, or other words: planned again, not streamed.
        case same
    }

    public struct Row: Equatable, Sendable {
        public var id: String
        /// The agent's words, which may come out as they arrive.
        public var revealable: Bool
        public var change: Change

        public init(id: String, revealable: Bool, change: Change) {
            self.id = id
            self.revealable = revealable
            self.change = change
        }
    }

    public enum Step: Equatable, Sendable {
        /// Comes out from what it showed before, at the stream's pace.
        case start
        /// Goes on coming out, with its words as they are now.
        case grow
        /// What is left comes out within `TextReveal.finishTime`.
        case finish
        /// Shows whole at once.
        case stop
    }

    /// More characters than this in one update were caught up with, not
    /// streamed: a model's chunks are tens of characters, a few of them
    /// together when the planner falls behind.
    public static let catchUp = 400

    /// The row coming out at the stream's pace.
    public private(set) var target: String?
    private var wasOnScreen = false
    private var hadRows = false
    /// The app is in the background.
    private var away = false
    /// It was, and what it missed hasn't come yet.
    private var missed = false

    public init() {}

    /// The app went to the background: nothing reveals until it is back,
    /// and what it missed comes whole.
    public mutating func wentAway() {
        away = true
        missed = true
        target = nil
    }

    public mutating func cameBack() { away = false }

    /// One update's rows, oldest first. `streaming`: the agent is at work;
    /// `onScreen`: the transcript is in a window; `revealing`: the rows
    /// still coming out. Returns what each row that changes its reveal does.
    public mutating func update(_ rows: [Row], streaming: Bool, onScreen: Bool, revealing: Set<String>) -> [String: Step] {
        // What arrived: words that grew, and rows new after the first one
        // already shown (older history paged in at the far end arrived
        // from nowhere the reader was).
        var arrived = 0
        var caughtUp = false
        var shown = false
        for row in rows {
            switch row.change {
            case .new:
                if shown { arrived += 1 }
            case .grew(let by):
                shown = true
                arrived += 1
                if by > Self.catchUp { caughtUp = true }
            case .same:
                shown = true
            }
        }
        let live = onScreen && wasOnScreen && hadRows && !away && !missed
        if missed, onScreen, !away, arrived > 0 { missed = false }
        wasOnScreen = onScreen
        hadRows = !rows.isEmpty

        var steps: [String: Step] = [:]
        var next: String?
        if streaming, live, let newest = rows.last, newest.revealable {
            if revealing.contains(newest.id) {
                if caughtUp, newest.change != .same {
                    steps[newest.id] = .stop
                } else {
                    steps[newest.id] = .grow
                    next = newest.id
                }
            } else if newest.change != .same, arrived == 1, !caughtUp {
                steps[newest.id] = .start
                next = newest.id
            }
        }
        for id in revealing where id != next && steps[id] == nil { steps[id] = .finish }
        target = next
        return steps
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
