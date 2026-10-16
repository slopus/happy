#if canImport(UIKit)
import HappyLayout
import UIKit

/// Label sizes for a screen that follows the person's text size, measured
/// off the main thread (AGENTS.md rule 8) as a `StyledLabel` measures
/// itself (`NoSessionsMeasure.measure`: TextKit 1, the label's style, line
/// limit and alignment, ceiled to the screen's pixels).
///
/// A layout asks through `measurable(_:)`. A size measured for exactly the
/// label's words, style, lines, alignment, text size and screen, and the
/// width asked, is returned as is. Anything else returns the style's one
/// line at that width and queues the measurement: the queue is measured in
/// one background pass on the next turn of the main loop, and `onChange`
/// asks the screen to lay out again once, when the sizes land. Nothing is
/// measured on the main thread.
///
/// A label that doesn't follow the text size measures itself, as before.
@MainActor
final class MeasuredLabelSizes {
    struct Key: Hashable, Sendable {
        var string: String
        var style: TextStyle
        var lines: Int
        var alignment: Int
        var text: TextEnvironment
        var width: CGFloat
    }

    /// Kept sizes; past this many the oldest pass is forgotten.
    static let capacity = 1024

    private var sizes: [Key: CGSize] = [:]
    private var queued: [Key] = []
    private var queuedSet: Set<Key> = []
    private var flushing = false
    /// Called once per pass that landed.
    var onChange: (@MainActor () -> Void)?
    /// Passes measured so far (tests).
    private(set) var passes = 0

    /// `label`'s size at a width, from what was measured off the main
    /// thread.
    func measurable(_ label: StyledLabel) -> Measurable {
        Measurable { [weak self, unowned label] width in
            guard let self, let text = label.traitCollection.textEnvironment else {
                return label.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
            }
            let key = Key(
                string: label.string,
                style: label.style,
                lines: label.numberOfLines,
                alignment: label.alignment.rawValue,
                text: text,
                width: width
            )
            return self.size(key)
        }
    }

    /// The size measured for `key`, or one line until it is.
    func size(_ key: Key) -> CGSize {
        guard !key.string.isEmpty else { return .zero }
        if let size = sizes[key] { return size }
        enqueue(key)
        let width = key.width.isFinite && key.width < .greatestFiniteMagnitude / 2 ? max(0, key.width) : 0
        return CGSize(width: width, height: key.style.oneLine(in: key.text))
    }

    /// Whether every size asked for has landed (tests).
    var isSettled: Bool { queued.isEmpty && !flushing }

    private func enqueue(_ key: Key) {
        guard queuedSet.insert(key).inserted else { return }
        queued.append(key)
        guard !flushing else { return }
        flushing = true
        Task { @MainActor [weak self] in await self?.flush() }
    }

    private func flush() async {
        while !queued.isEmpty {
            let keys = queued
            queued = []
            let measured: [(Key, CGSize)] = await Task.detached(priority: .userInitiated) {
                keys.map { key in
                    (key, NoSessionsMeasure.measure(
                        key.string,
                        style: key.style,
                        lines: key.lines,
                        alignment: NSTextAlignment(rawValue: key.alignment) ?? .natural,
                        environment: key.text,
                        width: key.width
                    ))
                }
            }.value
            if sizes.count + measured.count > Self.capacity { sizes = [:] }
            for (key, size) in measured {
                sizes[key] = size
                queuedSet.remove(key)
            }
            passes += 1
            onChange?()
        }
        flushing = false
    }
}
#endif
