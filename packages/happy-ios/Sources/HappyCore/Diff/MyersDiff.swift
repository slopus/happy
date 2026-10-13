import Foundation

// Myers' O(ND) diff as jsdiff 8.0.3 implements it (src/diff/base.ts), with
// the tokenizers happy-app's diff engine uses: lines (`diffLines`), arrays
// with a comparator (`diffArrays`) and words with whitespace
// (`diffWordsWithSpace`). The edit-graph walk, its diagonal pruning, the
// tie-breaking between insertions and removals and the component merging
// follow the original step for step, so the same inputs give the same
// changes. Tokens are interned to integers first: equality is an
// equivalence, so comparing ids is comparing tokens.
//
// jsdiff is distributed under this license:
//
//   BSD 3-Clause License
//
//   Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>
//   All rights reserved.
//
//   Redistribution and use in source and binary forms, with or without
//   modification, are permitted provided that the following conditions are met:
//
//   1. Redistributions of source code must retain the above copyright notice, this
//      list of conditions and the following disclaimer.
//
//   2. Redistributions in binary form must reproduce the above copyright notice,
//      this list of conditions and the following disclaimer in the documentation
//      and/or other materials provided with the distribution.
//
//   3. Neither the name of the copyright holder nor the names of its
//      contributors may be used to endorse or promote products derived from
//      this software without specific prior written permission.
//
//   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
//   AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
//   IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
//   DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
//   FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
//   DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
//   SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
//   CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
//   OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
//   OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

public enum MyersDiff {
    /// A run of tokens that was kept, added or removed.
    public struct Change<Value: Equatable & Sendable>: Equatable, Sendable {
        public var value: Value
        /// How many tokens the run holds.
        public var count: Int
        public var added: Bool
        public var removed: Bool

        public init(value: Value, count: Int, added: Bool, removed: Bool) {
            self.value = value
            self.count = count
            self.added = added
            self.removed = removed
        }
    }

    /// jsdiff's `maxEditLength` and `timeout`: past either the diff gives up
    /// and returns nil.
    public struct Budget: Equatable, Sendable {
        public var timeoutMs: Double?
        public var maxEditLength: Int?

        public init(timeoutMs: Double? = nil, maxEditLength: Int? = nil) {
            self.timeoutMs = timeoutMs
            self.maxEditLength = maxEditLength
        }

        public static let unlimited = Budget()
    }

    // MARK: Tokenizers

    /// `diffLines`: each line keeps its `\n` or `\r\n`.
    public static func diffLines(_ oldText: String, _ newText: String, budget: Budget = .unlimited) -> [Change<String>]? {
        let old = lineTokens(oldText)
        let new = lineTokens(newText)
        var interner = Interner()
        let oldIds = old.map { interner.id($0) }
        let newIds = new.map { interner.id($0) }
        guard let components = run(oldIds, newIds, budget: budget) else { return nil }
        return values(components, old: old, new: new) { $0.joined() }
    }

    /// `diffArrays` with a comparator, given as the key two equal elements
    /// share (happy-app compares lines with their whitespace stripped).
    public static func diffArrays(_ old: [String], _ new: [String], key: (String) -> String = { $0 }, budget: Budget = .unlimited) -> [Change<[String]>]? {
        var interner = Interner()
        let oldIds = old.map { interner.id(key($0)) }
        let newIds = new.map { interner.id(key($0)) }
        guard let components = run(oldIds, newIds, budget: budget) else { return nil }
        return values(components, old: old, new: new) { $0 }
    }

    /// `diffWordsWithSpace`: words, runs of horizontal whitespace, single
    /// newlines and single other characters are each a token.
    public static func diffWordsWithSpace(_ oldText: String, _ newText: String) -> [Change<String>] {
        let old = wordTokens(oldText)
        let new = wordTokens(newText)
        var interner = Interner()
        let oldIds = old.map { interner.id($0) }
        let newIds = new.map { interner.id($0) }
        let components = run(oldIds, newIds, budget: .unlimited) ?? []
        return values(components, old: old, new: new) { $0.joined() }
    }

    /// LineDiff's tokenizer: `value.split(/(\n|\r\n)/)`, the separators glued
    /// back onto their lines, the empty tail after a final newline dropped.
    static func lineTokens(_ text: String) -> [String] {
        var tokens: [String] = []
        let bytes = Array(text.utf8)
        var start = 0
        var index = 0
        while index < bytes.count {
            if bytes[index] == 0x0A {
                tokens.append(String(decoding: bytes[start...index], as: UTF8.self))
                index += 1
                start = index
            } else if bytes[index] == 0x0D, index + 1 < bytes.count, bytes[index + 1] == 0x0A {
                tokens.append(String(decoding: bytes[start...(index + 1)], as: UTF8.self))
                index += 2
                start = index
            } else {
                index += 1
            }
        }
        if start < bytes.count {
            tokens.append(String(decoding: bytes[start...], as: UTF8.self))
        }
        return tokens
    }

    /// `(\r?\n)|[word]+|[^\S\n\r]+|[^word]` with the `u` flag.
    static func wordTokens(_ text: String) -> [String] {
        let scalars = Array(text.unicodeScalars)
        var tokens: [String] = []
        var index = 0
        func take(_ end: Int) {
            var token = String.UnicodeScalarView()
            token.append(contentsOf: scalars[index..<end])
            tokens.append(String(token))
            index = end
        }
        while index < scalars.count {
            let scalar = scalars[index]
            if scalar == "\r", index + 1 < scalars.count, scalars[index + 1] == "\n" {
                take(index + 2)
            } else if scalar == "\n" {
                take(index + 1)
            } else if isWordScalar(scalar) {
                var end = index + 1
                while end < scalars.count, isWordScalar(scalars[end]) { end += 1 }
                take(end)
            } else if isHorizontalSpace(scalar) {
                var end = index + 1
                while end < scalars.count, isHorizontalSpace(scalars[end]) { end += 1 }
                take(end)
            } else {
                take(index + 1)
            }
        }
        return tokens
    }

    /// jsdiff's `extendedWordChars`: ASCII letters, digits and `_`, the soft
    /// hyphen and the Latin letters with diacritics.
    static func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x61...0x7A, 0x41...0x5A, 0x30...0x39, 0x5F, 0xAD,
             0xC0...0xD6, 0xD8...0xF6, 0xF8...0x2C6, 0x2C8...0x2D7, 0x2DE...0x2FF, 0x1E00...0x1EFF:
            return true
        default:
            return false
        }
    }

    /// `[^\S\n\r]`: JavaScript whitespace other than the line breaks.
    static func isHorizontalSpace(_ scalar: Unicode.Scalar) -> Bool {
        scalar != "\n" && scalar != "\r" && DiffText.isJSWhitespace(scalar)
    }

    // MARK: The edit graph

    /// Ids for tokens by exact content. Swift's `String ==` compares canonical
    /// equivalence; JavaScript compares code units, so keys are the bytes.
    private struct Interner {
        private var ids: [ExactString: Int] = [:]

        mutating func id(_ token: String) -> Int {
            let key = ExactString(token)
            if let id = ids[key] { return id }
            let id = ids.count
            ids[key] = id
            return id
        }
    }

    private struct ExactString: Hashable {
        let value: String

        init(_ value: String) {
            self.value = value
        }

        static func == (lhs: ExactString, rhs: ExactString) -> Bool {
            lhs.value.utf8.elementsEqual(rhs.value.utf8)
        }

        func hash(into hasher: inout Hasher) {
            var value = value
            value.withUTF8 { hasher.combine(bytes: UnsafeRawBufferPointer($0)) }
        }
    }

    private final class Component {
        let count: Int
        let added: Bool
        let removed: Bool
        let previous: Component?

        init(count: Int, added: Bool, removed: Bool, previous: Component?) {
            self.count = count
            self.added = added
            self.removed = removed
            self.previous = previous
        }
    }

    private struct Path {
        var oldPos: Int
        var last: Component?
    }

    struct Run: Equatable {
        var count: Int
        var added: Bool
        var removed: Bool
    }

    /// `diffWithOptionsObj`: the runs that turn `old` into `new`, or nil once
    /// the budget is spent.
    static func run(_ old: [Int], _ new: [Int], budget: Budget) -> [Run]? {
        let oldLen = old.count
        let newLen = new.count
        var maxEditLength = newLen + oldLen
        if let limit = budget.maxEditLength { maxEditLength = min(maxEditLength, limit) }
        let deadline = budget.timeoutMs.map { ContinuousClock.now + .milliseconds(Int64($0.rounded(.up))) }

        // Diagonals run from -(maxEditLength + 1) to maxEditLength + 1.
        let offset = max(0, maxEditLength) + 1
        var bestPath = [Path?](repeating: nil, count: offset * 2 + 1)

        func extractCommon(_ path: inout Path, _ diagonal: Int) -> Int {
            var oldPos = path.oldPos
            var newPos = oldPos - diagonal
            var common = 0
            while newPos + 1 < newLen, oldPos + 1 < oldLen, old[oldPos + 1] == new[newPos + 1] {
                newPos += 1
                oldPos += 1
                common += 1
            }
            if common > 0 {
                path.last = Component(count: common, added: false, removed: false, previous: path.last)
            }
            path.oldPos = oldPos
            return newPos
        }

        func addToPath(_ path: Path, added: Bool, removed: Bool, oldPosInc: Int) -> Path {
            if let last = path.last, last.added == added, last.removed == removed {
                return Path(oldPos: path.oldPos + oldPosInc, last: Component(count: last.count + 1, added: added, removed: removed, previous: last.previous))
            }
            return Path(oldPos: path.oldPos + oldPosInc, last: Component(count: 1, added: added, removed: removed, previous: path.last))
        }

        var seed = Path(oldPos: -1, last: nil)
        var newPos = extractCommon(&seed, 0)
        if seed.oldPos + 1 >= oldLen, newPos + 1 >= newLen {
            return runs(seed.last)
        }
        bestPath[offset] = seed

        var minDiagonal = Int.min
        var maxDiagonal = Int.max
        var editLength = 1
        while editLength <= maxEditLength {
            if let deadline, ContinuousClock.now > deadline { return nil }
            var diagonal = max(minDiagonal, -editLength)
            while diagonal <= min(maxDiagonal, editLength) {
                let removePath = bestPath[offset + diagonal - 1]
                let addPath = bestPath[offset + diagonal + 1]
                if removePath != nil { bestPath[offset + diagonal - 1] = nil }
                var canAdd = false
                if let addPath {
                    let addPathNewPos = addPath.oldPos - diagonal
                    canAdd = 0 <= addPathNewPos && addPathNewPos < newLen
                }
                let canRemove = removePath.map { $0.oldPos + 1 < oldLen } ?? false
                if !canAdd && !canRemove {
                    bestPath[offset + diagonal] = nil
                    diagonal += 2
                    continue
                }
                var basePath: Path
                if !canRemove || (canAdd && removePath!.oldPos < addPath!.oldPos) {
                    basePath = addToPath(addPath!, added: true, removed: false, oldPosInc: 0)
                } else {
                    basePath = addToPath(removePath!, added: false, removed: true, oldPosInc: 1)
                }
                newPos = extractCommon(&basePath, diagonal)
                if basePath.oldPos + 1 >= oldLen, newPos + 1 >= newLen {
                    return runs(basePath.last)
                }
                bestPath[offset + diagonal] = basePath
                if basePath.oldPos + 1 >= oldLen { maxDiagonal = min(maxDiagonal, diagonal - 1) }
                if newPos + 1 >= newLen { minDiagonal = max(minDiagonal, diagonal + 1) }
                diagonal += 2
            }
            editLength += 1
        }
        return nil
    }

    private static func runs(_ last: Component?) -> [Run] {
        var runs: [Run] = []
        var component = last
        while let current = component {
            runs.append(Run(count: current.count, added: current.added, removed: current.removed))
            component = current.previous
        }
        return runs.reversed()
    }

    /// `buildValues`: each run's tokens, from the new side unless removed.
    private static func values<Value>(_ runs: [Run], old: [String], new: [String], join: ([String]) -> Value) -> [Change<Value>] {
        var newPos = 0
        var oldPos = 0
        return runs.map { run in
            let value: Value
            if !run.removed {
                value = join(Array(new[newPos..<(newPos + run.count)]))
                newPos += run.count
                if !run.added { oldPos += run.count }
            } else {
                value = join(Array(old[oldPos..<(oldPos + run.count)]))
                oldPos += run.count
            }
            return Change(value: value, count: run.count, added: run.added, removed: run.removed)
        }
    }
}
