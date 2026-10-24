import Foundation

/// The CSS subset a media layout may use (`mediaLayoutStyle.ts` in
/// `@slopus/happy-agent-client`): every property, and the grammar its value
/// must match. A value is kept only in the normalized spelling the daemon
/// writes: lowercase, single-spaced, a space after each comma and around
/// each slash. Nothing it accepts names a colour, loads a resource or
/// places anything outside the layout.
public enum StemCellMediaTreeStyle {
    /// The normalized form of one value, or nil when it is outside the
    /// grammar of `key` (a camelCase key of the subset).
    public static func value(_ key: String, _ value: String) -> String? {
        guard value.count <= 512, let grammar = grammars[key] else { return nil }
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard let components = parse(text), !components.isEmpty, grammar(components) else { return nil }
        return serialize(components)
    }

    /// CSS property name to the key it is carried under.
    public static let keys: [String: String] = {
        var map: [String: String] = [:]
        for key in grammars.keys {
            let property = key.unicodeScalars.map { CharacterSet.uppercaseLetters.contains($0) ? "-" + String($0).lowercased() : String($0) }.joined()
            map[property] = key
        }
        return map
    }()

    // MARK: Components

    indirect enum Component: Equatable, Sendable {
        case word(String)
        case slash
        case comma
        case function(String, [Component])
    }

    typealias Grammar = @Sendable ([Component]) -> Bool

    static let functions: Set<String> = ["repeat", "minmax", "fit-content"]
    static let maxPx: Double = 4000
    static let maxEm: Double = 100
    static let maxFr: Double = 100
    static let maxGridLine = 24
    static let maxTracks = 24

    static func parse(_ value: String) -> [Component]? {
        guard value.unicodeScalars.allSatisfy({ ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") || " .,%()/+-".unicodeScalars.contains($0) }) else { return nil }
        let chars = Array(value)
        var position = 0
        func list(_ depth: Int) -> [Component]? {
            var components: [Component] = []
            while position < chars.count {
                switch chars[position] {
                case " ": position += 1
                case "/": components.append(.slash); position += 1
                case ",": components.append(.comma); position += 1
                case ")":
                    guard depth > 0 else { return nil }
                    position += 1
                    return components
                case "(": return nil
                default:
                    var word = ""
                    while position < chars.count, !" /,()".contains(chars[position]) { word.append(chars[position]); position += 1 }
                    if position < chars.count, chars[position] == "(" {
                        guard functions.contains(word), depth < 2 else { return nil }
                        position += 1
                        guard let args = list(depth + 1) else { return nil }
                        components.append(.function(word, args))
                    } else {
                        components.append(.word(word))
                    }
                }
            }
            return depth == 0 ? components : nil
        }
        return list(0)
    }

    static func serialize(_ components: [Component]) -> String {
        var text = ""
        for component in components {
            if case .comma = component { text += ", "; continue }
            if !text.isEmpty, !text.hasSuffix(", ") { text += " " }
            switch component {
            case .slash: text += "/"
            case .word(let word): text += word
            case .function(let name, let args): text += "\(name)(\(serialize(args)))"
            case .comma: break
            }
        }
        return text
    }

    static func words(_ components: [Component]) -> [String]? {
        var texts: [String] = []
        for component in components {
            guard case .word(let text) = component else { return nil }
            texts.append(text)
        }
        return texts
    }

    /// Split at the top level on commas, or on slashes.
    static func split(_ components: [Component], slash: Bool) -> [[Component]] {
        var parts: [[Component]] = [[]]
        for component in components {
            if slash, case .slash = component { parts.append([]); continue }
            if !slash, case .comma = component { parts.append([]); continue }
            parts[parts.count - 1].append(component)
        }
        return parts
    }

    /// `^(\d+(\.\d+)?|\.\d+)$`.
    static func number(_ text: String) -> Double? {
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2, !text.isEmpty else { return nil }
        let digits: (Substring) -> Bool = { !$0.isEmpty && $0.allSatisfy { $0 >= "0" && $0 <= "9" } }
        if parts.count == 1 { return digits(parts[0]) ? Double(text) : nil }
        guard digits(parts[1]), parts[0].isEmpty || digits(parts[0]) else { return nil }
        return Double(parts[0].isEmpty ? "0" + text : text)
    }

    static func dimension(_ text: String) -> (value: Double, unit: String)? {
        for unit in ["rem", "px", "em", "fr", "%"] where text.hasSuffix(unit) {
            guard let value = number(String(text.dropLast(unit.count))) else { return nil }
            return (value, unit)
        }
        return nil
    }

    /// `0`, or a non-negative px, %, em or rem length within bounds.
    static func lengthPercentage(_ text: String) -> Bool {
        if text == "0" { return true }
        guard let found = dimension(text) else { return false }
        switch found.unit {
        case "px": return found.value <= maxPx
        case "%": return found.value <= 100
        case "em", "rem": return found.value <= maxEm
        default: return false
        }
    }

    static func keyword(_ allowed: String...) -> Grammar {
        let set = Set(allowed)
        return { components in
            guard let texts = words(components), !texts.isEmpty else { return false }
            return set.contains(texts.joined(separator: " "))
        }
    }

    static func each(_ most: Int, _ accept: @escaping @Sendable (String) -> Bool) -> Grammar {
        { components in
            guard let texts = words(components) else { return false }
            return texts.count >= 1 && texts.count <= most && texts.allSatisfy(accept)
        }
    }

    static func pair(_ first: @escaping Grammar, _ second: @escaping Grammar) -> Grammar {
        { components in
            if first(components) { return true }
            for index in components.indices.dropFirst() where first(Array(components[..<index])) && second(Array(components[index...])) { return true }
            return false
        }
    }

    static func either(_ grammars: Grammar...) -> Grammar {
        { components in grammars.contains { $0(components) } }
    }

    static func fitContent(_ components: [Component]) -> Bool {
        guard components.count == 1, case .function("fit-content", let args) = components[0] else { return false }
        return each(1, lengthPercentage)(args)
    }

    static let size: Grammar = either(keyword("auto", "min-content", "max-content", "fit-content"), each(1, lengthPercentage), fitContent)
    static let maxSize: Grammar = either(keyword("none"), size)
    static let spacing: Grammar = each(1, lengthPercentage)
    static let margin: Grammar = each(1) { $0 == "auto" || lengthPercentage($0) }

    static let contentPosition = ["normal", "start", "end", "center", "flex-start", "flex-end"]
    static let distribution = ["space-between", "space-around", "space-evenly", "stretch"]
    static let baseline = ["baseline", "first baseline", "last baseline"]
    static let selfPosition = ["self-start", "self-end"]

    static func keywords(_ allowed: [String]) -> Grammar {
        let set = Set(allowed)
        return { components in
            guard let texts = words(components), !texts.isEmpty else { return false }
            return set.contains(texts.joined(separator: " "))
        }
    }

    static let justifyContent = keywords(contentPosition + distribution + ["left", "right"])
    static let alignContent = keywords(contentPosition + distribution + baseline)
    static let justifyItems = keywords(["normal", "stretch", "start", "end", "center", "flex-start", "flex-end", "left", "right"] + selfPosition + baseline)
    static let alignItems = keywords(["normal", "stretch", "start", "end", "center", "flex-start", "flex-end"] + selfPosition + baseline)
    static let justifySelf = either(keyword("auto"), justifyItems)
    static let alignSelf = either(keyword("auto"), alignItems)

    static func trackBreadth(_ text: String, flexible: Bool) -> Bool {
        if ["auto", "min-content", "max-content"].contains(text) { return true }
        if flexible, let found = dimension(text), found.unit == "fr" { return found.value > 0 && found.value <= maxFr }
        return lengthPercentage(text)
    }

    /// One track: how many tracks it is, or nil when invalid.
    static func trackSize(_ component: Component) -> Int? {
        switch component {
        case .word(let text): return trackBreadth(text, flexible: true) ? 1 : nil
        case .function("fit-content", _): return fitContent([component]) ? 1 : nil
        case .function("minmax", let args):
            let parts = split(args, slash: false).map(words)
            guard parts.count == 2, let min = parts[0], let max = parts[1], min.count == 1, max.count == 1,
                  trackBreadth(min[0], flexible: false), trackBreadth(max[0], flexible: true) else { return nil }
            return 1
        default: return nil
        }
    }

    static let trackList: Grammar = { components in
        if keyword("none")(components) { return true }
        guard !components.isEmpty else { return false }
        var tracks = 0
        for component in components {
            if case .function("repeat", let args) = component {
                let parts = split(args, slash: false)
                guard parts.count == 2, let count = words(parts[0]), count.count == 1 else { return false }
                let repeats = count[0] == "auto-fill" || count[0] == "auto-fit" ? 1 : (count[0].allSatisfy { $0 >= "0" && $0 <= "9" } ? Int(count[0]) ?? 0 : 0)
                guard repeats >= 1, repeats <= maxTracks, !parts[1].isEmpty else { return false }
                for track in parts[1] {
                    guard let counted = trackSize(track) else { return false }
                    tracks += counted * repeats
                }
            } else {
                guard let counted = trackSize(component) else { return false }
                tracks += counted
            }
            if tracks > maxTracks { return false }
        }
        return true
    }

    static let autoTracks: Grammar = { components in
        components.count >= 1 && components.count <= maxTracks && components.allSatisfy { trackSize($0) != nil }
    }

    static func integer(_ text: String) -> Int? {
        let digits = text.hasPrefix("-") ? text.dropFirst() : Substring(text)
        guard !digits.isEmpty, digits.allSatisfy({ $0 >= "0" && $0 <= "9" }) else { return nil }
        return Int(text)
    }

    static let gridLine: Grammar = { components in
        guard let texts = words(components) else { return false }
        if texts.count == 1 {
            if texts[0] == "auto" { return true }
            guard let line = integer(texts[0]) else { return false }
            return line != 0 && abs(line) <= maxGridLine
        }
        if texts.count == 2, texts[0] == "span", !texts[1].hasPrefix("-"), let span = integer(texts[1]) {
            return span >= 1 && span <= maxGridLine
        }
        return false
    }

    static let gridLines: Grammar = { components in
        let parts = split(components, slash: true)
        return parts.count <= 2 && parts.allSatisfy(gridLine)
    }

    static let ratio: Grammar = { components in
        let parts = split(components, slash: true)
        guard parts.count <= 2 else { return false }
        let values = parts.map { part -> Double? in
            guard let texts = words(part), texts.count == 1 else { return nil }
            return number(texts[0])
        }
        guard values.allSatisfy({ $0 != nil && $0! > 0 && $0! <= 10_000 }) else { return false }
        let shape = values[0]! / (values.count > 1 ? values[1]! : 1)
        return shape >= 0.1 && shape <= 10
    }

    static let aspectRatio: Grammar = { components in
        if keyword("auto")(components) { return true }
        if case .word("auto")? = components.first { return ratio(Array(components.dropFirst())) }
        if case .word("auto")? = components.last { return ratio(Array(components.dropLast())) }
        return ratio(components)
    }

    static func flexFactor(_ text: String) -> Bool { number(text).map { $0 <= 100 } ?? false }

    static let flexBasis: Grammar = either(keyword("content"), size)

    static let flex: Grammar = { components in
        if keyword("none", "auto")(components) { return true }
        if let texts = words(components), texts.count >= 1, texts.count <= 3, flexFactor(texts[0]) {
            if texts.count == 1 { return true }
            if texts.count == 2 { return flexFactor(texts[1]) || flexBasis(Array(components.dropFirst())) }
            return flexFactor(texts[1]) && flexBasis(Array(components.dropFirst(2)))
        }
        return flexBasis(components)
    }

    static let objectPosition: Grammar = each(2) { ["left", "center", "right", "top", "bottom"].contains($0) || lengthPercentage($0) }

    static let lineHeight: Grammar = either(keyword("normal")) { components in
        guard let texts = words(components), texts.count == 1 else { return false }
        if let value = number(texts[0]) { return value <= 10 }
        return lengthPercentage(texts[0])
    }

    static let fontWeight: Grammar = either(keyword("normal", "bold", "bolder", "lighter")) { components in
        guard let texts = words(components), texts.count == 1, texts[0].allSatisfy({ $0 >= "0" && $0 <= "9" }), let weight = Int(texts[0]) else { return false }
        return weight >= 1 && weight <= 1000
    }

    static let borderRadius: Grammar = each(4) { text in
        if text == "0" { return true }
        guard let found = dimension(text) else { return false }
        return found.unit == "px" && found.value <= 999
    }

    static let overflow = keyword("visible", "hidden", "clip")
    static let direction = keyword("row", "row-reverse", "column", "column-reverse", "nowrap", "wrap", "wrap-reverse")

    static let grammars: [String: Grammar] = [
        "display": keyword("block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "none"),
        "flexDirection": keyword("row", "row-reverse", "column", "column-reverse"),
        "flexWrap": keyword("nowrap", "wrap", "wrap-reverse"),
        "flexFlow": pair(direction, keyword("nowrap", "wrap", "wrap-reverse")),
        "flex": flex,
        "flexGrow": each(1, flexFactor),
        "flexShrink": each(1, flexFactor),
        "flexBasis": flexBasis,
        "order": each(1) { integer($0).map { abs($0) <= 100 } ?? false },
        "justifyContent": justifyContent,
        "alignContent": alignContent,
        "placeContent": pair(alignContent, justifyContent),
        "justifyItems": justifyItems,
        "alignItems": alignItems,
        "placeItems": pair(alignItems, justifyItems),
        "justifySelf": justifySelf,
        "alignSelf": alignSelf,
        "placeSelf": pair(alignSelf, justifySelf),
        "gap": each(2) { $0 == "normal" || lengthPercentage($0) },
        "rowGap": each(1) { $0 == "normal" || lengthPercentage($0) },
        "columnGap": each(1) { $0 == "normal" || lengthPercentage($0) },
        "gridTemplateColumns": trackList,
        "gridTemplateRows": trackList,
        "gridAutoColumns": autoTracks,
        "gridAutoRows": autoTracks,
        "gridAutoFlow": keyword("row", "column", "dense", "row dense", "column dense", "dense row", "dense column"),
        "gridColumn": gridLines,
        "gridRow": gridLines,
        "gridColumnStart": gridLine,
        "gridColumnEnd": gridLine,
        "gridRowStart": gridLine,
        "gridRowEnd": gridLine,
        "width": size,
        "height": size,
        "minWidth": size,
        "minHeight": size,
        "maxWidth": maxSize,
        "maxHeight": maxSize,
        "aspectRatio": aspectRatio,
        "boxSizing": keyword("content-box", "border-box"),
        "padding": each(4, lengthPercentage),
        "paddingTop": spacing,
        "paddingRight": spacing,
        "paddingBottom": spacing,
        "paddingLeft": spacing,
        "margin": each(4) { $0 == "auto" || lengthPercentage($0) },
        "marginTop": margin,
        "marginRight": margin,
        "marginBottom": margin,
        "marginLeft": margin,
        "borderRadius": borderRadius,
        "overflow": pair(overflow, overflow),
        "overflowX": overflow,
        "overflowY": overflow,
        "objectFit": keyword("fill", "contain", "cover", "none", "scale-down"),
        "objectPosition": objectPosition,
        "verticalAlign": keyword("baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super"),
        "textAlign": keyword("left", "right", "center", "justify", "start", "end"),
        "fontWeight": fontWeight,
        "fontStyle": keyword("normal", "italic", "oblique"),
        "fontSize": keyword("small", "normal", "large", "title"),
        "lineHeight": lineHeight,
        "tone": keyword("default", "muted", "accent"),
    ]
}
