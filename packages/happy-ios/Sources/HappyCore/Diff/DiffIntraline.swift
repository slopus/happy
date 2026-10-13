import Foundation

/// engine/intraline.ts: word-level emphasis inside changed lines, only for
/// lines that are actually related, so it points at the edit rather than
/// painting confetti.
public enum DiffIntraline {
    /// A half-open range of UTF-16 offsets.
    public typealias Range = Swift.Range<Int>

    /// Lines longer than this skip word diffing.
    public static let maxLineForWordDiff = 1500
    /// Below this the two lines are unrelated; whole-line colour reads better.
    public static let minSimilarity = 0.34
    /// A changed block bigger than this is almost never a 1:1 edit.
    public static let maxBlockForPairing = 60

    /// Shared prefix plus shared suffix over the longer length.
    public static func similarity(_ a: String, _ b: String) -> Double {
        similarity(Array(a.utf16), Array(b.utf16))
    }

    static func similarity(_ a: [UInt16], _ b: [UInt16]) -> Double {
        if a == b { return 1 }
        let longest = max(a.count, b.count)
        if longest == 0 { return 1 }
        let shortest = min(a.count, b.count)
        var prefix = 0
        while prefix < shortest, a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < shortest - prefix, a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        return Double(prefix + suffix) / Double(longest)
    }

    /// The word diff of one line pair, as ranges on each side.
    public static func wordRanges(_ oldLine: String, _ newLine: String) -> (del: [Range], ins: [Range]) {
        let oldLength = oldLine.utf16.count
        let newLength = newLine.utf16.count
        if oldLength > maxLineForWordDiff || newLength > maxLineForWordDiff {
            return ([0..<oldLength], [0..<newLength])
        }
        var del: [Range] = []
        var ins: [Range] = []
        var oldPos = 0
        var newPos = 0
        for part in MyersDiff.diffWordsWithSpace(oldLine, newLine) {
            let length = part.value.utf16.count
            if part.added {
                push(&ins, newPos, newPos + length)
                newPos += length
            } else if part.removed {
                push(&del, oldPos, oldPos + length)
                oldPos += length
            } else {
                oldPos += length
                newPos += length
            }
        }
        return (del, ins)
    }

    /// Appends a range, joining it to the previous one when they touch.
    private static func push(_ ranges: inout [Range], _ start: Int, _ end: Int) {
        guard end > start else { return }
        if let last = ranges.last, last.upperBound == start {
            ranges[ranges.count - 1] = last.lowerBound..<end
        } else {
            ranges.append(start..<end)
        }
    }

    /// Pairs each run of removals with the additions right after it, i-th
    /// with i-th, and records emphasis for the pairs that are related.
    /// Keyed by index into `lines`. Past `deadline` it stops and returns what
    /// it has.
    public static func computeEmphasis(_ lines: [DiffPatchParser.RawLine], deadline: Date? = nil) -> [Int: [Range]] {
        var map: [Int: [Range]] = [:]
        var index = 0
        while index < lines.count {
            if lines[index].type != .del {
                index += 1
                continue
            }
            var delEnd = index
            while delEnd < lines.count, lines[delEnd].type == .del { delEnd += 1 }
            var addEnd = delEnd
            while addEnd < lines.count, lines[addEnd].type == .add { addEnd += 1 }
            let delCount = delEnd - index
            let addCount = addEnd - delEnd
            if addCount == 0 {
                index = addEnd
                continue
            }
            if delCount <= maxBlockForPairing, addCount <= maxBlockForPairing {
                for pair in 0..<min(delCount, addCount) {
                    if let deadline, Date() >= deadline { return map }
                    let delIndex = index + pair
                    let addIndex = delEnd + pair
                    let oldUnits = Array(lines[delIndex].text.utf16)
                    let newUnits = Array(lines[addIndex].text.utf16)
                    if oldUnits == newUnits { continue }
                    if similarity(oldUnits, newUnits) < minSimilarity { continue }
                    let (del, ins) = wordRanges(lines[delIndex].text, lines[addIndex].text)
                    // When practically everything changed, emphasis adds nothing.
                    if coverage(del, oldUnits.count) > 0.9, coverage(ins, newUnits.count) > 0.9 { continue }
                    if !del.isEmpty { map[delIndex] = del }
                    if !ins.isEmpty { map[addIndex] = ins }
                }
            }
            index = addEnd
        }
        return map
    }

    private static func coverage(_ ranges: [Range], _ length: Int) -> Double {
        if length == 0 { return 1 }
        return Double(ranges.reduce(0) { $0 + $1.count }) / Double(length)
    }
}
