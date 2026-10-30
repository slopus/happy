import Foundation

/// Agent text as happy-desktop reads it (remark with GFM): a single newline
/// inside a paragraph is a soft break, drawn as a space, and only a blank
/// line starts a new paragraph. The shared markdown parser reads every line
/// as its own block, so soft breaks are joined first.
public enum Markdown {
    public static func joiningSoftBreaks(_ markdown: String) -> String {
        var out: [String] = []
        var fence: String?
        /// The previous line is paragraph text a soft break may continue.
        var continues = false
        for line in markdown.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
            let text = String(line)
            let trimmed = text.trimmingCharacters(in: .whitespaces)
            if let open = fence {
                out.append(text)
                if trimmed.hasPrefix(open) { fence = nil }
                continue
            }
            if let marker = fenceMarker(trimmed) {
                fence = marker
                out.append(text)
                continues = false
                continue
            }
            if trimmed.isEmpty {
                out.append(text)
                continues = false
                continue
            }
            if continues, !startsBlock(trimmed), let last = out.popLast() {
                out.append(last.trimmingCharacters(in: .whitespaces) + " " + trimmed)
            } else {
                out.append(text)
            }
            // A hard break (two trailing spaces or a backslash), a heading, a
            // table row or a rule ends here; anything else may run on.
            let hardBreak = text.hasSuffix("  ") || text.hasSuffix("\\")
            continues = !hardBreak && !trimmed.hasPrefix("#") && !trimmed.hasPrefix("|") && !isRule(trimmed)
        }
        return out.joined(separator: "\n")
    }

    static func fenceMarker(_ line: String) -> String? {
        if line.hasPrefix("```") { return "```" }
        if line.hasPrefix("~~~") { return "~~~" }
        return nil
    }

    /// A line that opens a block of its own rather than continuing a paragraph.
    static func startsBlock(_ line: String) -> Bool {
        if line.hasPrefix("#") || line.hasPrefix(">") || line.hasPrefix("|") || isRule(line) { return true }
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") { return true }
        let digits = line.prefix { $0.isASCII && $0.isNumber }
        if !digits.isEmpty, digits.count <= 9 {
            let rest = line.dropFirst(digits.count)
            if rest.hasPrefix(". ") || rest.hasPrefix(") ") { return true }
        }
        return false
    }

    static func isRule(_ line: String) -> Bool {
        let compact = line.filter { $0 != " " }
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }
}
