import Foundation

/// The editor's lines as one flat text, the way the text view holds them:
/// each line a paragraph ending in "\n", a hard break inside one as U+2028
/// (so a paragraph is always exactly one block), and a block without text
/// as one U+FFFC. Offsets inside a line are the same UTF-16 offsets
/// `DocumentCaret` counts.
public enum DocumentText {
    public static let lineBreak: Character = "\u{2028}"
    public static let object: Character = "\u{FFFC}"

    public static func paragraph(_ line: DocumentLine) -> String {
        line.block.isInline ? line.block.plainText.replacingOccurrences(of: "\n", with: String(lineBreak)) : String(object)
    }

    /// Where each line starts, and where the text ends.
    public static func starts(_ lines: [DocumentLine]) -> [Int] {
        var out: [Int] = []
        out.reserveCapacity(lines.count + 1)
        var position = 0
        for line in lines {
            out.append(position)
            position += line.length + 1
        }
        out.append(position)
        return out
    }

    /// The line an offset falls in, and the offset inside it.
    public static func locate(_ offset: Int, starts: [Int]) -> (line: Int, offset: Int) {
        guard starts.count > 1 else { return (0, 0) }
        var low = 0
        var high = starts.count - 2
        while low < high {
            let mid = (low + high + 1) / 2
            if starts[mid] <= offset { low = mid } else { high = mid - 1 }
        }
        let lineEnd = starts[low + 1] - 1
        return (low, min(max(0, offset - starts[low]), lineEnd - starts[low]))
    }

    /// A paragraph's text back as the block's text.
    public static func blockText(_ paragraph: String) -> String {
        paragraph.replacingOccurrences(of: String(lineBreak), with: "\n")
    }
}
