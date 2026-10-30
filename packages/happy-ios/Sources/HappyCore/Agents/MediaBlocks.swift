import Foundation

/// Layout blocks in an agent's text (happy-agent `API.md`, "Media layouts in
/// text"): plain HTML that arranges media the conversation already showed.
/// `MediaTree.parse` reads each into the tree it is drawn as; the
/// HTML itself is never drawn.
public enum MediaBlocks {
    public enum Segment: Equatable, Sendable {
        case markdown(String)
        case layout(Layout)
    }

    public struct Layout: Equatable, Sendable {
        /// The block as written.
        public var raw: String
        /// False when its root never closed or it ends inside a tag.
        public var complete: Bool
    }

    static let roots = ["div", "section", "figure", "p", "img"]

    /// `splitMediaLayoutBlocks` (`@slopus/happy-agent-client`), over UTF-16
    /// as JavaScript counts: Markdown and the layout blocks in it, in order;
    /// their texts joined are the input. A block holding no `<img` stays
    /// Markdown, and an incomplete block is always the last segment.
    public static func split(_ text: String) -> [Segment] {
        let units = Array(text.utf16)
        func string(_ range: Range<Int>) -> String { String(decoding: units[range], as: UTF16.self) }
        var segments: [Segment] = []
        func pushMarkdown(_ range: Range<Int>) {
            guard !range.isEmpty else { return }
            if case .markdown(let previous)? = segments.last { segments[segments.count - 1] = .markdown(previous + string(range)) }
            else { segments.append(.markdown(string(range))) }
        }
        var markdownStart = 0
        var lineStart = 0
        var fence: Fence?
        var spans = CodeSpans(units)
        var codeUntil = 0
        while lineStart < units.count {
            let newline = index(of: 0x0A, in: units, from: lineStart)
            let lineEnd = newline.map { $0 + 1 } ?? units.count
            let line = Array(units[lineStart..<(newline ?? units.count)])
            if let open = fence {
                if isFenceClose(line, open) { fence = nil }
                lineStart = lineEnd
                continue
            }
            if let opening = fenceOpening(line) {
                fence = opening
                lineStart = lineEnd
                continue
            }
            if isBlank(line[...]) {
                lineStart = lineEnd
                continue
            }
            if lineStart >= codeUntil {
                if let (tag, tagStart) = blockStart(line) {
                    let block = scanBlock(units, start: lineStart + tagStart, tag: tag)
                    pushMarkdown(markdownStart..<lineStart)
                    let html = string(lineStart..<block.end)
                    if !block.complete {
                        segments.append(.layout(Layout(raw: html, complete: false)))
                        return segments
                    }
                    if block.image { segments.append(.layout(Layout(raw: html, complete: true))) } else { pushMarkdown(lineStart..<block.end) }
                    markdownStart = block.end
                    lineStart = block.end
                    continue
                }
                if newline == nil, isPartialStart(line) {
                    pushMarkdown(markdownStart..<lineStart)
                    segments.append(.layout(Layout(raw: String(decoding: line, as: UTF16.self), complete: false)))
                    return segments
                }
            }
            codeUntil = spans.skip(from: max(lineStart, codeUntil), lineEnd: lineEnd, codeUntil: codeUntil)
            lineStart = lineEnd
        }
        pushMarkdown(markdownStart..<units.count)
        return segments
    }

    // MARK: The reference's scanning, unit for unit

    struct Fence { var marker: UInt16; var length: Int }
    static let backtick: UInt16 = 0x60, tilde: UInt16 = 0x7E, space: UInt16 = 0x20, tab: UInt16 = 0x09, cr: UInt16 = 0x0D

    static func index(of unit: UInt16, in units: [UInt16], from start: Int) -> Int? {
        var index = start
        while index < units.count { if units[index] == unit { return index }; index += 1 }
        return nil
    }

    static func isBlank(_ line: ArraySlice<UInt16>) -> Bool {
        line.allSatisfy { $0 == space || $0 == tab || $0 == cr }
    }

    /// `BLOCK_START`: up to three spaces, `<` and a root tag, then a tab,
    /// newline, form feed, return, space, `/`, `>` or the end. The tag and where its `<` is.
    static func blockStart(_ line: [UInt16]) -> (String, Int)? {
        var indent = 0
        while indent < line.count, indent < 4, line[indent] == space { indent += 1 }
        guard indent <= 3, indent < line.count, line[indent] == 0x3C else { return nil }
        for tag in roots {
            let name = Array(tag.utf16)
            let end = indent + 1 + name.count
            guard end <= line.count else { continue }
            let written = line[(indent + 1)..<end].map { ($0 >= 0x41 && $0 <= 0x5A) ? $0 + 0x20 : $0 }
            guard written == name else { continue }
            if end == line.count || [tab, 0x0A, 0x0C, cr, space, 0x2F, 0x3E].contains(line[end]) { return (tag, indent) }
        }
        return nil
    }

    /// `PARTIAL_START`: a last line that is only `<` and the start of a root tag.
    static func isPartialStart(_ line: [UInt16]) -> Bool {
        var indent = 0
        while indent < line.count, line[indent] == space { indent += 1 }
        guard indent <= 3, indent < line.count, line[indent] == 0x3C else { return false }
        let rest = line[(indent + 1)...]
        guard rest.allSatisfy({ ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) }) else { return false }
        let name = String(decoding: rest, as: UTF16.self).lowercased()
        return roots.contains { $0.hasPrefix(name) }
    }

    static func fencePrefixEnd(_ line: [UInt16]) -> Int {
        var index = 0
        while index < line.count, line[index] == space || line[index] == tab { index += 1 }
        while index < line.count, line[index] == 0x3E {
            index += 1
            if index < line.count, line[index] == space || line[index] == tab { index += 1 }
        }
        while index < line.count, line[index] == space || line[index] == tab { index += 1 }
        return index
    }

    static func runLength(_ line: [UInt16], _ start: Int, _ marker: UInt16) -> Int {
        var length = 0
        while start + length < line.count, line[start + length] == marker { length += 1 }
        return length
    }

    static func fenceOpening(_ line: [UInt16]) -> Fence? {
        let start = fencePrefixEnd(line)
        guard start < line.count, line[start] == backtick || line[start] == tilde else { return nil }
        let marker = line[start]
        let length = runLength(line, start, marker)
        guard length >= 3 else { return nil }
        let info = line[(start + length)...]
        if info.contains(where: { $0 == cr || $0 == 0x2028 || $0 == 0x2029 }) { return nil }
        if marker == backtick, info.contains(backtick) { return nil }
        return Fence(marker: marker, length: length)
    }

    static func isFenceClose(_ line: [UInt16], _ fence: Fence) -> Bool {
        let start = fencePrefixEnd(line)
        guard start < line.count, line[start] == fence.marker else { return false }
        let length = runLength(line, start, fence.marker)
        return length >= fence.length && isBlank(line[(start + length)...])
    }

    static func isTagNameStart(_ unit: UInt16) -> Bool { (unit >= 0x41 && unit <= 0x5A) || (unit >= 0x61 && unit <= 0x7A) }
    static func isTagNameUnit(_ unit: UInt16) -> Bool { isTagNameStart(unit) || (unit >= 0x30 && unit <= 0x39) || unit == 0x2D }

    static func startsWith(_ units: [UInt16], _ text: String, at index: Int) -> Bool {
        let needle = Array(text.utf16)
        guard index + needle.count <= units.count else { return false }
        return Array(units[index..<(index + needle.count)]) == needle
    }

    static func find(_ units: [UInt16], _ text: String, from start: Int) -> Int? {
        var index = start
        while index < units.count { if startsWith(units, text, at: index) { return index }; index += 1 }
        return nil
    }

    /// `scanBlock`: past the line the root closes on; incomplete when it never
    /// closes or a tag or comment is cut off.
    static func scanBlock(_ units: [UInt16], start: Int, tag: String) -> (end: Int, complete: Bool, image: Bool) {
        let incomplete = (end: units.count, complete: false, image: false)
        var depth = 0
        var image = false
        var index = start
        while index < units.count {
            guard units[index] == 0x3C else { index += 1; continue }
            if startsWith(units, "<!--", at: index) {
                guard let close = find(units, "-->", from: index + 4) else { return incomplete }
                index = close + 3
                continue
            }
            let closing = index + 1 < units.count && units[index + 1] == 0x2F
            let nameStart = index + (closing ? 2 : 1)
            guard nameStart < units.count, isTagNameStart(units[nameStart]) else { index += 1; continue }
            var nameEnd = nameStart
            while nameEnd < units.count, isTagNameUnit(units[nameEnd]) { nameEnd += 1 }
            let name = String(decoding: units[nameStart..<nameEnd], as: UTF16.self).lowercased()
            let tagEnd = closing ? self.index(of: 0x3E, in: units, from: nameEnd) : openTagEnd(units, from: nameEnd)
            guard let tagEnd else { return incomplete }
            index = tagEnd + 1
            if !closing, name == "img" { image = true }
            guard name == tag else { continue }
            if closing { depth -= 1 } else if tag != "img" { depth += 1 }
            if depth > 0 { continue }
            let newline = self.index(of: 0x0A, in: units, from: index)
            return (newline.map { $0 + 1 } ?? units.count, true, image)
        }
        return incomplete
    }

    /// `openTagEnd`: the `>` ending an open tag, past values quoted after `=`.
    static func openTagEnd(_ units: [UInt16], from start: Int) -> Int? {
        var position = start
        var afterEquals = false
        while position < units.count {
            let unit = units[position]
            if unit == 0x3E { return position }
            if (unit == 0x22 || unit == 0x27) && afterEquals {
                guard let close = index(of: unit, in: units, from: position + 1) else { return nil }
                position = close + 1
                afterEquals = false
                continue
            }
            if unit == 0x3D { afterEquals = true } else if !isWhitespace(unit) { afterEquals = false }
            position += 1
        }
        return nil
    }

    static func isWhitespace(_ unit: UInt16) -> Bool {
        unit == space || unit == tab || unit == 0x0A || unit == 0x0B || unit == 0x0C || unit == cr || unit == 0xA0
            || unit == 0x1680 || (unit >= 0x2000 && unit <= 0x200A) || unit == 0x2028 || unit == 0x2029 || unit == 0x202F
            || unit == 0x205F || unit == 0x3000 || unit == 0xFEFF
    }

    /// The reference's `CodeSpans`: where the code spans opening on a line
    /// end, bounded by their paragraph. Asked in increasing order.
    struct CodeSpans {
        let units: [UInt16]
        var runs: [Int: [Int]]?
        var passed: [Int: Int] = [:]
        var paragraph: (from: Int, end: Int)?

        init(_ units: [UInt16]) { self.units = units }

        mutating func skip(from: Int, lineEnd: Int, codeUntil: Int) -> Int {
            var until = codeUntil
            var index = from
            while index < lineEnd {
                guard let next = MediaBlocks.index(of: MediaBlocks.backtick, in: units, from: index), next < lineEnd else { break }
                if isEscaped(from: index, at: next) { index = next + 1; continue }
                var length = 1
                while next + length < units.count, units[next + length] == MediaBlocks.backtick { length += 1 }
                let close = closing(from: next + length, length: length, end: paragraphEnd(lineEnd))
                index = close.map { $0 + length } ?? next + length
                if close != nil { until = index }
            }
            return until
        }

        func isEscaped(from: Int, at: Int) -> Bool {
            var backslashes = 0
            while at - backslashes - 1 >= from, units[at - backslashes - 1] == 0x5C { backslashes += 1 }
            return backslashes % 2 == 1
        }

        mutating func closing(from: Int, length: Int, end: Int) -> Int? {
            if runs == nil {
                var found: [Int: [Int]] = [:]
                var index = MediaBlocks.index(of: MediaBlocks.backtick, in: units, from: 0)
                while let start = index {
                    var run = 1
                    while start + run < units.count, units[start + run] == MediaBlocks.backtick { run += 1 }
                    found[run, default: []].append(start)
                    index = MediaBlocks.index(of: MediaBlocks.backtick, in: units, from: start + run)
                }
                runs = found
            }
            guard let list = runs?[length] else { return nil }
            var count = passed[length] ?? 0
            while count < list.count, list[count] < from { count += 1 }
            passed[length] = count
            guard count < list.count, list[count] < end else { return nil }
            return list[count]
        }

        mutating func paragraphEnd(_ from: Int) -> Int {
            if let known = paragraph, known.from <= from, from <= known.end { return known.end }
            var lineStart = from
            var end = units.count
            while lineStart < units.count {
                let newline = MediaBlocks.index(of: 0x0A, in: units, from: lineStart)
                let line = Array(units[lineStart..<(newline ?? units.count)])
                if MediaBlocks.isBlank(line[...]) || MediaBlocks.fenceOpening(line) != nil { end = lineStart; break }
                guard let newline else { break }
                lineStart = newline + 1
            }
            paragraph = (from, end)
            return end
        }
    }
}
