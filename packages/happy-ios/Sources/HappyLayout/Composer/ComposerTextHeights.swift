import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif

/// The composer's text height, measured off the main thread (AGENTS.md
/// rule 8), as Fabric measures a TextInput in its shadow tree rather than
/// in the view.
///
/// Each measurement is stamped with what it measured: the wrapping width,
/// the font and line, the padding and the cap (`Key`), and the text's
/// revision and generation (`Stamp`). A layout asking for a height already
/// measured gets it. One asking for a height not measured yet gets a guess
/// (the last height measured at that key, else the last at any key, else
/// one line) and a measurement starts. One runs at a time; what is asked
/// for meanwhile is coalesced to the newest text at each key. When one
/// lands and moves a height a layout was given, the owner lays out again.
public struct ComposerTextHeights: Sendable {
    /// Everything but the text that a measurement depends on.
    public struct Key: Hashable, Sendable {
        /// The width the text wraps at.
        public var width: CGFloat
        /// The font and line as drawn, at the person's text size.
        public var style: TextStyle
        /// One line as drawn.
        public var lineHeight: CGFloat
        public var paddingTop: CGFloat
        public var paddingBottom: CGFloat
        /// The input's cap, its padding included: a text this tall or
        /// taller scrolls (`MultiTextInputLayout`).
        public var maxHeight: CGFloat

        public init(width: CGFloat, style: TextStyle, lineHeight: CGFloat, paddingTop: CGFloat, paddingBottom: CGFloat, maxHeight: CGFloat) {
            self.width = width
            self.style = style
            self.lineHeight = lineHeight
            self.paddingTop = paddingTop
            self.paddingBottom = paddingBottom
            self.maxHeight = maxHeight
        }

        /// How tall a container the text is laid out in: a line past the
        /// cap, so a long text is laid out no further than it can show,
        /// and one cut off there, or whose last empty line doesn't fit, is
        /// past the cap whatever is left.
        public var measureLimit: CGFloat {
            max(0, maxHeight) + lineHeight
        }

        /// One line and the padding: an empty text's height, and the guess
        /// before anything is measured.
        public var oneLine: CGFloat {
            lineHeight + paddingTop + paddingBottom
        }

        /// The text's height, its padding included, from what was laid out
        /// in `measureLimit`: `usedHeight` tall, and all of the text or
        /// not. Cut off, it is at least the cap, so it scrolls.
        public func contentHeight(usedHeight: CGFloat, fits: Bool) -> CGFloat {
            let height = (max(0, usedHeight) + paddingTop + paddingBottom).rounded(.up)
            return fits ? height : max(height, maxHeight)
        }
    }

    /// One measurement: the key, and the text as it was.
    public struct Stamp: Hashable, Sendable {
        public var key: Key
        /// Moves on every change to the text.
        public var revision: Int
        /// Moves when the text is replaced rather than edited (a draft
        /// arriving, a suggestion picked): a measurement of the text before
        /// arriving late is dropped, not shown as a guess.
        public var generation: Int

        public init(key: Key, revision: Int, generation: Int) {
            self.key = key
            self.revision = revision
            self.generation = generation
        }
    }

    public struct Lookup: Equatable, Sendable {
        /// The text's height to lay out with now, its padding included.
        public var height: CGFloat
        /// Measure this text now; nil when it is measured or one is
        /// running.
        public var measure: Stamp?

        public init(height: CGFloat, measure: Stamp?) {
            self.height = height
            self.measure = measure
        }
    }

    public struct Finish: Equatable, Sendable {
        /// A height a layout was given has moved: lay out again.
        public var changed: Bool
        /// Measure this next: the live text at a key asked for meanwhile.
        public var measure: Stamp?

        public init(changed: Bool, measure: Stamp?) {
            self.changed = changed
            self.measure = measure
        }
    }

    /// The text as it is now, when a measurement lands.
    public struct Live: Equatable, Sendable {
        public var revision: Int
        public var generation: Int
        public var isEmpty: Bool

        public init(revision: Int, generation: Int, isEmpty: Bool) {
            self.revision = revision
            self.generation = generation
            self.isEmpty = isEmpty
        }
    }

    private struct Entry: Equatable, Sendable {
        var revision: Int
        var height: CGFloat
    }

    /// How many keys are kept: a layout may ask at a few widths a pass
    /// (the card's and the panel's, a dock's resting and open widths).
    public static let keptKeys = 4

    private var entries: [Key: Entry] = [:]
    /// The keys by when they were last asked for, newest last.
    private var recent: [Key] = []
    /// The newest stamp asked for at a key and not measured yet.
    private var wanted: [Key: Stamp] = [:]
    /// What each key was last answered.
    private var served: [Key: CGFloat] = [:]
    /// The last height measured, at any key.
    private var latest: CGFloat?
    /// The measurement running.
    public private(set) var inFlight: Stamp?

    public init() {}

    /// Whether `lookup` would answer `stamp` with its text's measured
    /// height rather than a guess. Starts nothing.
    public func isMeasured(_ stamp: Stamp, isEmpty: Bool) -> Bool {
        guard stamp.key.width > 0 else { return false }
        return isEmpty || entries[stamp.key]?.revision == stamp.revision
    }

    /// The height for `stamp`'s text, and whether to start measuring it.
    public mutating func lookup(_ stamp: Stamp, isEmpty: Bool) -> Lookup {
        let key = stamp.key
        // Not laid out yet: nothing to wrap at, nothing kept.
        guard key.width > 0 else {
            return Lookup(height: isEmpty ? key.oneLine : answer(key), measure: nil)
        }
        touch(key)
        if isEmpty {
            // Nothing to lay out: one line.
            record(key, Entry(revision: stamp.revision, height: key.oneLine))
            wanted[key] = nil
            return serve(key, nil)
        }
        if entries[key]?.revision == stamp.revision {
            wanted[key] = nil
            return serve(key, nil)
        }
        if inFlight != nil {
            if inFlight != stamp {
                wanted[key] = stamp
            }
            return serve(key, nil)
        }
        wanted[key] = nil
        inFlight = stamp
        return serve(key, stamp)
    }

    /// `stamp`'s text was measured before it was set (`premeasure`): its
    /// height is known at once, and nothing is measured for it.
    public mutating func seed(_ stamp: Stamp, height: CGFloat) {
        guard stamp.key.width > 0 else { return }
        touch(stamp.key)
        record(stamp.key, Entry(revision: stamp.revision, height: height))
        wanted[stamp.key] = nil
    }

    /// A measurement landed with `height`; `live` is the text now.
    public mutating func finish(_ stamp: Stamp, height: CGFloat, live: Live) -> Finish {
        if inFlight == stamp {
            inFlight = nil
        }
        let key = stamp.key
        // Kept only if it is of this text, still asked for, and newer than
        // what the key has.
        if stamp.generation == live.generation, recent.contains(key),
           entries[key].map({ $0.revision < stamp.revision }) ?? true {
            record(key, Entry(revision: stamp.revision, height: height))
        }
        let next = inFlight == nil ? nextMeasurement(live) : nil
        let changed = served.contains { key, height in answer(key) != height }
        return Finish(changed: changed, measure: next)
    }

    /// The newest key asked for and not measured at the live text, made
    /// the running measurement; an empty text needs none.
    private mutating func nextMeasurement(_ live: Live) -> Stamp? {
        for key in recent.reversed() where wanted[key] != nil {
            wanted[key] = nil
            if entries[key]?.revision == live.revision { continue }
            if live.isEmpty {
                record(key, Entry(revision: live.revision, height: key.oneLine))
                continue
            }
            let stamp = Stamp(key: key, revision: live.revision, generation: live.generation)
            inFlight = stamp
            return stamp
        }
        return nil
    }

    /// A text set not to animate its height (a restored draft), until its
    /// own measurement lands: which replacement (`generation`) and which
    /// edit of it (`revision`). A measurement of an earlier text landing
    /// meanwhile neither animates it nor ends it.
    public struct QuietGrowth: Equatable, Sendable {
        public var generation: Int
        public var revision: Int

        public init(generation: Int, revision: Int) {
            self.generation = generation
            self.revision = revision
        }

        /// Whether a height change for text of `generation` animates.
        public func animates(generation: Int) -> Bool {
            generation != self.generation
        }

        /// Whether `stamp` is this text's measurement (or a later edit's):
        /// once it lands the quiet growth is over.
        public func isEnded(by stamp: Stamp) -> Bool {
            stamp.generation == generation && stamp.revision >= revision
        }
    }

    private func answer(_ key: Key) -> CGFloat {
        entries[key]?.height ?? latest ?? key.oneLine
    }

    private mutating func serve(_ key: Key, _ measure: Stamp?) -> Lookup {
        let height = answer(key)
        served[key] = height
        return Lookup(height: height, measure: measure)
    }

    private mutating func record(_ key: Key, _ entry: Entry) {
        entries[key] = entry
        latest = entry.height
    }

    private mutating func touch(_ key: Key) {
        recent.removeAll { $0 == key }
        recent.append(key)
        while recent.count > Self.keptKeys {
            let dropped = recent.removeFirst()
            entries[dropped] = nil
            wanted[dropped] = nil
            served[dropped] = nil
        }
    }
}
