import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
import HappyLayout

/// A Seti theme colour name. components/FileIcon.tsx maps each to a light
/// and a dark colour (`FileIconPalette`).
public enum SetiColor: String, CaseIterable, Sendable {
    case blue, grey, greyLight = "grey-light", green, orange, pink, purple, red, white, yellow, ignore
}

/// One filled shape of a Seti icon, in its view box.
public struct FileIconShape: Equatable, Sendable {
    public var path: VectorPath
    public var evenOdd: Bool
    /// The shape's own `opacity`, applied to the fill colour.
    public var opacity: CGFloat

    public init(path: VectorPath, evenOdd: Bool, opacity: CGFloat) {
        self.path = path
        self.evenOdd = evenOdd
        self.opacity = opacity
    }
}

/// A Seti icon and the colour a file name gives it.
public struct FileIconGraphic: Equatable, Sendable {
    public var name: String
    public var color: SetiColor
    public var viewBox: CGRect
    public var shapes: [FileIconShape]

    /// The shapes fitted into `rect` as `<SvgXml width height>` draws them:
    /// the view box scaled to fit, centred (`xMidYMid meet`).
    public func fitted(into rect: CGRect) -> [FileIconShape] {
        guard viewBox.width > 0, viewBox.height > 0 else { return [] }
        let scale = min(rect.width / viewBox.width, rect.height / viewBox.height)
        let offset = CGPoint(
            x: rect.minX + (rect.width - viewBox.width * scale) / 2 - viewBox.minX * scale,
            y: rect.minY + (rect.height - viewBox.height * scale) / 2 - viewBox.minY * scale
        )
        return shapes.map { FileIconShape(path: $0.path.applying(scale: scale, offset: offset), evenOdd: $0.evenOdd, opacity: $0.opacity) }
    }
}

/// components/FileIcon.tsx: @peoplesgrocers/seti-ui-file-icons' icon for a
/// file name, from the outlines `scripts/generate-file-icons.py` wrote.
public enum FileIcons {
    public static let sourceVersion = "1.11.3"

    /// The package's `getIcon(fileName)`: the icon's name and colour.
    public static func lookup(_ fileName: String) -> (icon: String, color: SetiColor) {
        let entry = details(fileName)
        return (entry.icon, entry.color)
    }

    /// The icon for a file name; nil only if the tables are broken.
    public static func icon(for fileName: String) -> FileIconGraphic? {
        let entry = details(fileName)
        guard let outline = outlines[entry.icon] else { return nil }
        return FileIconGraphic(name: entry.icon, color: entry.color, viewBox: outline.viewBox, shapes: outline.shapes)
    }

    /// Every icon's name, for tests.
    static var allIcons: [String] { outlines.keys.sorted() }

    // MARK: Lookup

    struct Entry: Equatable {
        var icon: String
        var color: SetiColor
    }

    /// `getDetails`, step by step, with JavaScript's string semantics: keys
    /// match code unit for code unit, and the extension loop starts at the
    /// first dot and moves past one dot at a time.
    static func details(_ fileName: String) -> Entry {
        if let entry = match(files, fileName) { return entry }
        let units = Array(fileName.utf16)
        var ext = slice(units, from: units.firstIndex(of: dot) ?? -1)
        while !ext.isEmpty {
            if let entry = match(extensions, String(decoding: ext, as: UTF16.self)) { return entry }
            ext = Array(ext.dropFirst())
            ext = slice(ext, from: ext.firstIndex(of: dot) ?? -1)
        }
        for (partial, entry) in partials where contains(units, Array(partial.utf16)) {
            return entry
        }
        return defaultEntry
    }

    private static let dot = UInt16(UInt8(ascii: "."))

    /// `String.prototype.slice(start)`: a negative start counts from the end.
    private static func slice(_ units: [UInt16], from start: Int) -> [UInt16] {
        let begin = start < 0 ? max(0, units.count + start) : min(start, units.count)
        return Array(units[begin...])
    }

    private static func contains(_ units: [UInt16], _ part: [UInt16]) -> Bool {
        guard !part.isEmpty else { return true }
        guard part.count <= units.count else { return false }
        for start in 0...(units.count - part.count) where units[start..<start + part.count].elementsEqual(part) {
            return true
        }
        return false
    }

    /// Keyed by code units: `hasOwnProperty` compares them, where Swift's
    /// == would also match canonically equivalent names.
    private static func match(_ table: [[UInt16]: Entry], _ key: String) -> Entry? {
        table[Array(key.utf16)]
    }

    private static func table(_ text: String) -> [(String, Entry)] {
        text.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: " ")
            guard parts.count == 3, let color = SetiColor(rawValue: String(parts[2])) else { return nil }
            return (String(parts[0]), Entry(icon: String(parts[1]), color: color))
        }
    }

    private static func keyed(_ text: String) -> [[UInt16]: Entry] {
        Dictionary(table(text).map { (Array($0.0.utf16), $0.1) }, uniquingKeysWith: { first, _ in first })
    }

    private static let files = keyed(GeneratedFileIcons.files)
    private static let extensions = keyed(GeneratedFileIcons.extensions)
    private static let partials = table(GeneratedFileIcons.partials)
    private static let defaultEntry = Entry(icon: GeneratedFileIcons.defaultIcon, color: SetiColor(rawValue: GeneratedFileIcons.defaultColor) ?? .white)

    // MARK: Outlines

    struct Outline {
        var viewBox: CGRect
        var shapes: [FileIconShape]
    }

    /// Parsed once, on first use: 151 icons.
    static let outlines: [String: Outline] = {
        var result: [String: Outline] = [:]
        for line in GeneratedFileIcons.icons.split(separator: "\n") {
            let parts = line.split(separator: " ", maxSplits: 2)
            guard parts.count == 3 else { continue }
            let box = parts[1].split(separator: ",").compactMap { Double($0) }
            guard box.count == 4 else { continue }
            var shapes: [FileIconShape] = []
            for shape in parts[2].split(separator: ";") {
                let fields = shape.split(separator: ",", maxSplits: 2)
                guard fields.count == 3, let opacity = Double(fields[1]),
                      let path = try? VectorPath(svg: String(fields[2])) else { continue }
                shapes.append(FileIconShape(path: path, evenOdd: fields[0] == "e", opacity: CGFloat(opacity)))
            }
            result[String(parts[0])] = Outline(
                viewBox: CGRect(x: box[0], y: box[1], width: box[2], height: box[3]),
                shapes: shapes
            )
        }
        return result
    }()
}
